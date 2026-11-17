import { Router } from 'express';
import { query } from './db.js';
import { asyncHandler, HttpError } from './errors.js';
import { snapshot } from './metrics.js';
import { routingGet } from './routingClient.js';
import { autoBook, bookSlot, cancelAppointment, listAppointments, suggestSlots } from './scheduling/service.js';

const int = (v, name, { required = false } = {}) => {
  if (v == null || v === '') {
    if (required) throw new HttpError(400, `${name} is required`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `${name} must be an integer`);
  return n;
};

const coord = (v, name, min, max) => {
  const n = Number(v);
  if (v == null || v === '' || !Number.isFinite(n) || n < min || n > max) throw new HttpError(400, `${name} is invalid`);
  return n;
};

export function buildRouter({ processor }) {
  const r = Router();

  r.get('/health', asyncHandler(async (_req, res) => {
    await query('SELECT 1');
    res.json({ status: 'ok' });
  }));

  r.get('/metrics', (_req, res) => res.json(snapshot()));

  r.get('/stats', asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT (SELECT count(*) FROM patients)::int AS patients,
              (SELECT count(*) FROM patients WHERE monitored)::int AS monitored,
              (SELECT count(*) FROM providers)::int AS providers,
              (SELECT count(*) FROM facilities)::int AS facilities,
              (SELECT count(*) FROM appointments WHERE status = 'booked' AND lower(slot) >= now())::int AS upcoming_appointments,
              (SELECT count(*) FROM alerts WHERE NOT acknowledged)::int AS open_alerts`,
    );
    res.json(rows[0]);
  }));

  // --- Patients -------------------------------------------------------------
  r.get('/patients', asyncHandler(async (req, res) => {
    const limit = Math.min(int(req.query.limit, 'limit') ?? 50, 500);
    const { rows } = await query(
      `SELECT id, name, date_of_birth, risk_level, monitored,
              ST_Y(home_location::geometry) AS lat, ST_X(home_location::geometry) AS lng
         FROM patients
        WHERE ($1::text IS NULL OR name ILIKE '%' || $1 || '%')
          AND ($2::boolean IS NULL OR monitored = $2)
        ORDER BY monitored DESC, id
        LIMIT $3`,
      [req.query.search || null, req.query.monitored == null ? null : req.query.monitored === 'true', limit],
    );
    res.json(rows);
  }));

  r.get('/patients/:id', asyncHandler(async (req, res) => {
    const id = int(req.params.id, 'id', { required: true });
    const { rows } = await query(
      `SELECT id, name, date_of_birth, risk_level, monitored,
              ST_Y(home_location::geometry) AS lat, ST_X(home_location::geometry) AS lng
         FROM patients WHERE id = $1`,
      [id],
    );
    if (!rows[0]) throw new HttpError(404, 'patient not found');
    res.json({ ...rows[0], latestVitals: processor.latest(id) });
  }));

  r.get('/patients/:id/vitals', asyncHandler(async (req, res) => {
    const id = int(req.params.id, 'id', { required: true });
    const minutes = Math.min(int(req.query.minutes, 'minutes') ?? 10, 24 * 60);
    const { rows } = await query(
      `SELECT recorded_at, heart_rate, spo2, systolic_bp, resp_rate, temperature, ews_score
         FROM vitals
        WHERE patient_id = $1 AND recorded_at >= now() - make_interval(mins => $2)
        ORDER BY recorded_at DESC
        LIMIT 2000`,
      [id, minutes],
    );
    res.json(rows.reverse());
  }));

  // --- Vitals ingest (devices / gateways) -----------------------------------
  r.post('/vitals', asyncHandler(async (req, res) => {
    const readings = Array.isArray(req.body) ? req.body : [req.body];
    if (readings.length > 1000) throw new HttpError(413, 'max 1000 readings per request');
    let alerts = 0;
    for (const reading of readings) {
      try {
        alerts += (await processor.ingest(reading)).alerts.length;
      } catch (err) {
        throw new HttpError(400, err.message);
      }
    }
    res.status(202).json({ accepted: readings.length, alerts });
  }));

  // --- Alerts ---------------------------------------------------------------
  r.get('/alerts', asyncHandler(async (req, res) => {
    const openOnly = req.query.open !== 'false';
    const { rows } = await query(
      `SELECT a.id, a.patient_id, p.name AS patient_name, a.created_at, a.severity, a.kind, a.message, a.acknowledged
         FROM alerts a JOIN patients p ON p.id = a.patient_id
        WHERE ($1::boolean = false OR NOT a.acknowledged)
        ORDER BY a.created_at DESC
        LIMIT 100`,
      [openOnly],
    );
    res.json(rows);
  }));

  r.post('/alerts/:id/ack', asyncHandler(async (req, res) => {
    const { rows } = await query(
      `UPDATE alerts SET acknowledged = true WHERE id = $1 RETURNING id, acknowledged`,
      [int(req.params.id, 'id', { required: true })],
    );
    if (!rows[0]) throw new HttpError(404, 'alert not found');
    res.json(rows[0]);
  }));

  // --- Providers & facilities -----------------------------------------------
  r.get('/specialties', asyncHandler(async (_req, res) => {
    const { rows } = await query(`SELECT specialty, count(*)::int AS providers FROM providers GROUP BY specialty ORDER BY specialty`);
    res.json(rows);
  }));

  r.get('/providers', asyncHandler(async (req, res) => {
    const { rows } = await query(
      `SELECT p.id, p.name, p.specialty, p.facility_id, f.name AS facility_name,
              p.work_start, p.work_end, p.slot_minutes
         FROM providers p JOIN facilities f ON f.id = p.facility_id
        WHERE ($1::text IS NULL OR p.specialty = $1)
        ORDER BY p.specialty, p.name`,
      [req.query.specialty || null],
    );
    res.json(rows);
  }));

  r.get('/facilities', asyncHandler(async (_req, res) => {
    const { rows } = await query(
      `SELECT id, name, type, address, er_capacity, current_wait_minutes, specialties, updated_at,
              ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lng
         FROM facilities ORDER BY id`,
    );
    res.json(rows);
  }));

  r.get('/facilities/nearest', asyncHandler(async (req, res) => {
    res.json(await routingGet('/api/routing/nearest', {
      lat: coord(req.query.lat, 'lat', -90, 90),
      lng: coord(req.query.lng, 'lng', -180, 180),
      specialty: req.query.specialty,
      type: req.query.type,
      k: req.query.k,
    }));
  }));

  r.get('/route', asyncHandler(async (req, res) => {
    res.json(await routingGet('/api/routing/route', {
      fromLat: coord(req.query.fromLat, 'fromLat', -90, 90),
      fromLng: coord(req.query.fromLng, 'fromLng', -180, 180),
      toLat: coord(req.query.toLat, 'toLat', -90, 90),
      toLng: coord(req.query.toLng, 'toLng', -180, 180),
    }));
  }));

  // --- Scheduling -----------------------------------------------------------
  r.get('/appointments', asyncHandler(async (req, res) => {
    res.json(await listAppointments({
      from: req.query.from,
      to: req.query.to,
      providerId: int(req.query.providerId, 'providerId'),
      patientId: int(req.query.patientId, 'patientId'),
    }));
  }));

  const schedulingInput = (b) => ({
    patientId: int(b.patientId, 'patientId'),
    specialty: b.specialty,
    preferredStart: b.preferredStart,
    durationMinutes: int(b.durationMinutes, 'durationMinutes'),
    priority: int(b.priority, 'priority') ?? 3,
    reason: b.reason,
  });

  r.post('/appointments/suggest', asyncHandler(async (req, res) => {
    const { options } = await suggestSlots({ ...schedulingInput(req.body), limit: int(req.body.limit, 'limit') ?? 5 });
    res.json({ options });
  }));

  r.post('/appointments/auto', asyncHandler(async (req, res) => {
    res.status(201).json(await autoBook(schedulingInput(req.body)));
  }));

  r.post('/appointments', asyncHandler(async (req, res) => {
    const b = req.body;
    try {
      res.status(201).json(await bookSlot({
        patientId: int(b.patientId, 'patientId', { required: true }),
        providerId: int(b.providerId, 'providerId', { required: true }),
        start: b.start,
        end: b.end,
        priority: int(b.priority, 'priority') ?? 3,
        reason: b.reason,
      }));
    } catch (err) {
      if (err.status !== 409) throw err;
      // Return fresh alternatives with the conflict so the client can re-offer instantly.
      const { rows } = await query(`SELECT specialty FROM providers WHERE id = $1`, [b.providerId]);
      const { options } = rows[0]
        ? await suggestSlots({ patientId: b.patientId, specialty: rows[0].specialty, preferredStart: b.start, priority: b.priority ?? 3 })
        : { options: [] };
      res.status(409).json({ error: err.message, alternatives: options });
    }
  }));

  r.post('/appointments/:id/cancel', asyncHandler(async (req, res) => {
    res.json(await cancelAppointment(int(req.params.id, 'id', { required: true })));
  }));

  return r;
}
