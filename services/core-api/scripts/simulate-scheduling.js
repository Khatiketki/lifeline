// Offline benchmark: how often do concurrent booking requests collide?
//
// Requests arrive in waves of `concurrency`; every request in a wave plans
// against the same calendar snapshot (as real clients do), then they commit
// in order. A commit that overlaps an already-committed booking is a
// conflict (in production: an exclusion-constraint violation / HTTP 409) and
// the request retries in the next wave.
//
// Baseline = what most booking UIs do: offer the free slot closest to the
// requested time. Lifeline = the scorer + randomized top-k pick in scheduler.js.
//
//   node scripts/simulate-scheduling.js [--runs 200] [--patients 90] [--concurrency 6]

import { generateFreeSlots, pickSlot, rankSlots } from '../src/scheduling/scheduler.js';

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const RUNS = Number(args.runs ?? 200);
const PATIENTS = Number(args.patients ?? 90);
const CONCURRENCY = Number(args.concurrency ?? 6);
const PROVIDERS = 6;

function mulberry32(seed) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY = Date.UTC(2030, 0, 7); // a Monday
const H = 3600_000;

function scenario(rng) {
  const windows = Array.from({ length: PROVIDERS }, (_, i) => ({
    providerId: i + 1,
    facilityId: i + 1,
    start: new Date(DAY + 9 * H),
    end: new Date(DAY + 17 * H),
    slotMinutes: 30,
  }));
  const distanceKmByFacility = new Map(windows.map((w) => [w.facilityId, 1 + rng() * 8]));
  // Demand peaks mid-morning, like real clinics.
  const requests = Array.from({ length: PATIENTS }, (_, i) => {
    const g = Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
    const hour = Math.min(16.5, Math.max(9, 10.5 + 1.5 * g));
    return { patientId: i + 1, preferredStart: new Date(DAY + Math.round(hour * 2) * (H / 2)) };
  });
  return { windows, distanceKmByFacility, requests };
}

const strategies = {
  baseline(free, req) {
    const sorted = [...free].sort(
      (a, b) => Math.abs(a.start - req.preferredStart) - Math.abs(b.start - req.preferredStart) || a.start - b.start || a.providerId - b.providerId,
    );
    return sorted[0] ?? null;
  },
  lifeline(free, req, ctx) {
    const ranked = rankSlots(free, { preferredStart: req.preferredStart, priority: 3, now: DAY, distanceKmByFacility: ctx.distanceKmByFacility });
    return pickSlot(ranked, { rng: ctx.rng });
  },
};

function run(strategy, seed) {
  const rng = mulberry32(seed);
  const { windows, distanceKmByFacility, requests } = scenario(rng);
  const busy = new Map(windows.map((w) => [w.providerId, []]));
  const queue = [...requests];
  let attempts = 0;
  let conflicts = 0;
  let booked = 0;
  let offsetHours = 0;
  let waves = 0;

  while (queue.length > 0 && waves < 500) {
    waves++;
    const wave = queue.splice(0, CONCURRENCY);
    // Snapshot taken once per wave: every request in it sees the same calendar.
    const snapshot = new Map([...busy].map(([k, v]) => [k, [...v]]));
    const plans = wave.map((req) => {
      const free = generateFreeSlots({ windows, providerBusy: snapshot });
      return { req, slot: strategies[strategy](free, req, { rng, distanceKmByFacility }) };
    });
    for (const { req, slot } of plans) {
      if (!slot) continue; // fully booked: not a conflict, just no capacity
      attempts++;
      const list = busy.get(slot.providerId);
      if (list.some((b) => slot.start < b.end && b.start < slot.end)) {
        conflicts++;
        queue.push(req);
        continue;
      }
      list.push({ start: slot.start, end: slot.end });
      booked++;
      offsetHours += Math.abs(slot.start - req.preferredStart) / H;
    }
  }
  return { attempts, conflicts, booked, offsetHours };
}

const totals = {};
for (const name of Object.keys(strategies)) {
  const t = { attempts: 0, conflicts: 0, booked: 0, offsetHours: 0 };
  for (let s = 1; s <= RUNS; s++) {
    const r = run(name, s);
    for (const k of Object.keys(t)) t[k] += r[k];
  }
  totals[name] = {
    conflictRate: t.conflicts / t.attempts,
    conflictsPerRun: t.conflicts / RUNS,
    bookedPerRun: t.booked / RUNS,
    avgHoursFromPreferred: t.offsetHours / t.booked,
  };
}

const fmt = (n, d = 3) => n.toFixed(d);
console.log(`Scheduling conflict simulation: ${RUNS} runs, ${PATIENTS} patients, ${PROVIDERS} providers, concurrency ${CONCURRENCY}\n`);
console.log('strategy   conflict-rate  conflicts/run  booked/run  avg-hours-from-preferred');
for (const [name, t] of Object.entries(totals)) {
  console.log(
    `${name.padEnd(10)} ${fmt(t.conflictRate).padStart(13)}  ${fmt(t.conflictsPerRun, 1).padStart(13)}  ${fmt(t.bookedPerRun, 1).padStart(10)}  ${fmt(t.avgHoursFromPreferred, 2).padStart(24)}`,
  );
}
const reduction = 1 - totals.lifeline.conflictRate / totals.baseline.conflictRate;
console.log(`\nConflict-rate reduction vs baseline: ${(reduction * 100).toFixed(1)}%`);
