// Pure scheduling engine (no I/O) so it can be unit tested and reused by the
// offline simulation in scripts/simulate-scheduling.js.
//
// Pipeline:  working windows + busy intervals  ->  free slots  ->  scored  ->  picked
//
// Conflicts in practice come from many clients booking from the same stale
// view of the calendar at once and all reaching for the same "obvious" slot.
// The ranker reduces that by (a) balancing load across providers,
// (b) preferring slots that keep remaining free time contiguous, and
// (c) spreading concurrent requests over a set of near-equivalent top slots.

const MIN = 60_000;

const overlaps = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && bStart < aEnd;

function sortedIntervals(list = []) {
  return list
    .map((b) => ({ start: +new Date(b.start), end: +new Date(b.end) }))
    .sort((a, b) => a.start - b.start);
}

function anyOverlap(sorted, start, end) {
  // Intervals are short and few per provider-day, so a linear scan with an
  // early exit is faster in practice than building an interval tree.
  for (const b of sorted) {
    if (b.start >= end) return false;
    if (overlaps(start, end, b.start, b.end)) return true;
  }
  return false;
}

/**
 * @param {object} args
 * @param {Array<{providerId:number, facilityId?:number, start:Date|string, end:Date|string, slotMinutes?:number, meta?:object}>} args.windows
 * @param {Map<number, Array<{start, end}>>} args.providerBusy
 * @param {Array<{start, end}>} [args.patientBusy]
 * @param {number} [args.durationMinutes] defaults to each window's slotMinutes
 * @param {Date|number} [args.notBefore]
 */
export function generateFreeSlots({ windows, providerBusy = new Map(), patientBusy = [], durationMinutes, notBefore = 0 }) {
  const patient = sortedIntervals(patientBusy);
  const busyCache = new Map();
  const earliest = +new Date(notBefore);
  const slots = [];

  for (const w of windows) {
    if (!busyCache.has(w.providerId)) busyCache.set(w.providerId, sortedIntervals(providerBusy.get(w.providerId)));
    const busy = busyCache.get(w.providerId);
    const winStart = +new Date(w.start);
    const winEnd = +new Date(w.end);
    const step = (w.slotMinutes ?? 30) * MIN;
    const dur = (durationMinutes ?? w.slotMinutes ?? 30) * MIN;

    const busyInWindow = busy.reduce(
      (sum, b) => sum + Math.max(0, Math.min(b.end, winEnd) - Math.max(b.start, winStart)),
      0,
    );
    const utilization = busyInWindow / Math.max(1, winEnd - winStart);

    for (let t = winStart; t + dur <= winEnd; t += step) {
      if (t < earliest) continue;
      if (anyOverlap(busy, t, t + dur)) continue;
      if (anyOverlap(patient, t, t + dur)) continue;

      // A slot that touches a booking or the window edge does not split free time.
      const touchesLeft = t === winStart || busy.some((b) => b.end === t);
      const touchesRight = t + dur === winEnd || busy.some((b) => b.start === t + dur);

      slots.push({
        providerId: w.providerId,
        facilityId: w.facilityId,
        start: new Date(t),
        end: new Date(t + dur),
        utilization,
        contiguous: touchesLeft || touchesRight,
        meta: w.meta,
      });
    }
  }
  return slots;
}

export const DEFAULT_WEIGHTS = { time: 1.0, load: 1.5, travel: 0.15, fragmentation: 0.4 };

/**
 * Lower score is better.
 * Urgent requests (priority 1-2) optimise for "as soon as possible"; routine
 * requests optimise for closeness to the patient's preferred time.
 */
export function scoreSlot(slot, { preferredStart, priority = 3, now = Date.now(), distanceKm = 0, weights = DEFAULT_WEIGHTS }) {
  const start = +slot.start;
  const urgent = priority <= 2;
  const anchor = urgent ? +new Date(now) : +new Date(preferredStart ?? now);
  const hoursOff = Math.abs(start - anchor) / (60 * MIN);
  const timeCost = urgent ? hoursOff * 3 : hoursOff;
  const loadCost = slot.utilization ?? 0;
  const travelCost = distanceKm;
  const fragCost = slot.contiguous ? 0 : 1;

  return (
    weights.time * timeCost +
    weights.load * loadCost +
    weights.travel * travelCost +
    weights.fragmentation * fragCost
  );
}

export function rankSlots(slots, opts) {
  const distance = opts.distanceKmByFacility ?? new Map();
  return slots
    .map((s) => ({ ...s, score: scoreSlot(s, { ...opts, distanceKm: distance.get(s.facilityId) ?? 0 }) }))
    .sort((a, b) => a.score - b.score || a.start - b.start || a.providerId - b.providerId);
}

/**
 * Pick one of the top candidates. Candidates within `tolerance` of the best
 * score are treated as equivalent and one is chosen at random, which keeps
 * concurrent requests from piling onto the same slot.
 */
export function pickSlot(ranked, { topK = 4, tolerance = 0.5, rng = Math.random } = {}) {
  if (ranked.length === 0) return null;
  const best = ranked[0].score;
  const pool = ranked.slice(0, topK).filter((s) => s.score <= best + tolerance);
  return pool[Math.floor(rng() * pool.length)];
}
