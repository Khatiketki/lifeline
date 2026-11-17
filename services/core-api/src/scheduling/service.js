import { query } from '../db.js';
import { config } from '../config.js';
import { counters } from '../metrics.js';
import { HttpError } from '../errors.js';
import { generateFreeSlots, pickSlot, rankSlots } from './scheduler.js';

const DAY = 24 * 60 * 60 * 1000;
const FIVE_MIN = 5 * 60 * 1000;

function searchHorizon(preferredStart, priority, now) {
  if (priority <= 2) return { from: now, to: new Date(+now + 3 * DAY) };
  const pref = new Date(preferredStart ?? now);
  const from = new Date(Math.max(+now, +pref - 2 * DAY));
  return { from, to: new Date(Math.max(+from, +pref) + 5 * DAY) };
}

async function loadWindows({ specialty, from, to, patientId }) {
  const { rows } = await query(
    `SELECT p.id AS provider_id, p.name AS provider_name, p.slot_minutes,
            f.id AS facility_id, f.name AS facility_name,
            ((d::date + p.work_start) AT TIME ZONE $4) AS win_start,
            ((d::date + p.work_end)   AT TIME ZONE $4) AS win_end,
            COALESCE(ST_Distance(f.location, pt.home_location) / 1000.0, 0) AS distance_km
       FROM providers p
       JOIN facilities f ON f.id = p.facility_id
       LEFT JOIN patients pt ON pt.id = $5
      CROSS JOIN generate_series(($2::timestamptz AT TIME ZONE $4)::date,
                                 ($3::timestamptz AT TIME ZONE $4)::date,
                                 interval '1 day') d
      WHERE p.specialty = $1
        AND extract(isodow FROM d) < 6`,
    [specialty, from, to, config.clinicTimeZone, patientId],
  );
  return rows;
}

async function loadBusy({ providerIds, patientId, from, to }) {
  const { rows } = await query(
    `SELECT provider_id, patient_id, lower(slot) AS start, upper(slot) AS "end"
       FROM appointments
      WHERE status = 'booked'
        AND slot && tstzrange($3, $4)
        AND (provider_id = ANY($1) OR patient_id = $2)`,
    [providerIds, patientId, from, to],
  );
  const providerBusy = new Map();
  const patientBusy = [];
  for (const r of rows) {
    if (!providerBusy.has(r.provider_id)) providerBusy.set(r.provider_id, []);
    providerBusy.get(r.provider_id).push(r);
    if (r.patient_id === patientId) patientBusy.push(r);
  }
  return { providerBusy, patientBusy };
}

export async function suggestSlots({ patientId, specialty, preferredStart, durationMinutes, priority = 3, limit = 5 }) {
  if (!specialty) throw new HttpError(400, 'specialty is required');
  const now = new Date();
  const { from, to } = searchHorizon(preferredStart, priority, now);
  const rows = await loadWindows({ specialty, from, to, patientId: patientId ?? null });
  if (rows.length === 0) return { options: [], ranked: [] };

  const providerIds = [...new Set(rows.map((r) => r.provider_id))];
  const { providerBusy, patientBusy } = await loadBusy({ providerIds, patientId: patientId ?? null, from, to });

  const distanceKmByFacility = new Map(rows.map((r) => [r.facility_id, r.distance_km]));
  const windows = rows.map((r) => ({
    providerId: r.provider_id,
    facilityId: r.facility_id,
    start: r.win_start,
    end: r.win_end,
    slotMinutes: r.slot_minutes,
    meta: { providerName: r.provider_name, facilityName: r.facility_name, distanceKm: r.distance_km },
  }));

  const free = generateFreeSlots({
    windows,
    providerBusy,
    patientBusy,
    durationMinutes,
    notBefore: Math.ceil(+now / FIVE_MIN) * FIVE_MIN,
  });
  const ranked = rankSlots(free, { preferredStart: preferredStart ?? now, priority, now, distanceKmByFacility });
  return { ranked, options: ranked.slice(0, limit).map(toOption) };
}

function toOption(s) {
  return {
    providerId: s.providerId,
    providerName: s.meta?.providerName,
    facilityId: s.facilityId,
    facilityName: s.meta?.facilityName,
    distanceKm: s.meta?.distanceKm != null ? +s.meta.distanceKm.toFixed(2) : null,
    start: s.start.toISOString(),
    end: s.end.toISOString(),
    score: +s.score.toFixed(3),
  };
}

export async function bookSlot({ patientId, providerId, start, end, priority = 3, reason = null }) {
  if (!patientId || !providerId || !start || !end) throw new HttpError(400, 'patientId, providerId, start and end are required');
  if (new Date(start) >= new Date(end)) throw new HttpError(400, 'start must be before end');
  if (new Date(start) < new Date()) throw new HttpError(400, 'cannot book in the past');

  counters.bookingAttempts++;
  try {
    const { rows } = await query(
      `INSERT INTO appointments (patient_id, provider_id, slot, priority, reason)
       VALUES ($1, $2, tstzrange($3, $4), $5, $6)
       RETURNING id, patient_id, provider_id, lower(slot) AS start, upper(slot) AS "end", status, priority, reason`,
      [patientId, providerId, start, end, priority, reason],
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23P01') {
      counters.bookingConflicts++;
      throw new HttpError(409, 'slot is no longer available', { constraint: err.constraint });
    }
    throw err;
  }
}

/**
 * Suggest + book in one call. If another request wins the race for the chosen
 * slot (exclusion constraint violation) we fall through to the next
 * equivalent candidate instead of bouncing the conflict back to the client.
 */
export async function autoBook({ patientId, specialty, preferredStart, durationMinutes, priority = 3, reason, maxAttempts = 5 }) {
  if (!patientId) throw new HttpError(400, 'patientId is required');
  const request = { patientId, specialty, preferredStart, durationMinutes, priority };
  let { ranked } = await suggestSlots(request);

  for (let attempt = 1; attempt <= maxAttempts && ranked.length > 0; attempt++) {
    const choice = pickSlot(ranked);
    try {
      const appointment = await bookSlot({
        patientId,
        providerId: choice.providerId,
        start: choice.start,
        end: choice.end,
        priority,
        reason,
      });
      return { appointment, option: toOption(choice), attempts: attempt };
    } catch (err) {
      if (err.status !== 409) throw err;
      // Losing a race means our snapshot is stale: re-read the calendar so
      // the next pick accounts for every booking that landed meanwhile.
      ({ ranked } = await suggestSlots(request));
    }
  }
  throw new HttpError(409, 'no available slot could be booked; try a different time range');
}

export async function cancelAppointment(id) {
  const { rows } = await query(
    `UPDATE appointments SET status = 'cancelled' WHERE id = $1 AND status = 'booked'
     RETURNING id, status`,
    [id],
  );
  if (rows.length === 0) throw new HttpError(404, 'booked appointment not found');
  return rows[0];
}

export async function listAppointments({ from, to, providerId, patientId, limit = 200 }) {
  const { rows } = await query(
    `SELECT a.id, a.patient_id, pt.name AS patient_name, a.provider_id, p.name AS provider_name,
            p.specialty, f.name AS facility_name, lower(a.slot) AS start, upper(a.slot) AS "end",
            a.status, a.priority, a.reason
       FROM appointments a
       JOIN patients pt ON pt.id = a.patient_id
       JOIN providers p ON p.id = a.provider_id
       JOIN facilities f ON f.id = p.facility_id
      WHERE a.status = 'booked'
        AND a.slot && tstzrange($1, $2)
        AND ($3::int IS NULL OR a.provider_id = $3)
        AND ($4::int IS NULL OR a.patient_id = $4)
      ORDER BY lower(a.slot)
      LIMIT $5`,
    [from ?? new Date(), to ?? new Date(Date.now() + 14 * DAY), providerId ?? null, patientId ?? null, limit],
  );
  return rows;
}
