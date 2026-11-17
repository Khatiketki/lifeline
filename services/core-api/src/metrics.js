// Lightweight in-process latency tracking. Keeps a ring buffer of recent
// samples per route so percentiles reflect current behaviour.
const SAMPLE_SIZE = 2000;
const routes = new Map();

export const counters = {
  bookingAttempts: 0,
  bookingConflicts: 0,
  vitalsIngested: 0,
  vitalsFlushes: 0,
  vitalsFlushMsTotal: 0,
  alertsRaised: 0,
};

function record(key, ms) {
  let r = routes.get(key);
  if (!r) {
    r = { samples: new Float64Array(SAMPLE_SIZE), next: 0, filled: 0, count: 0 };
    routes.set(key, r);
  }
  r.samples[r.next] = ms;
  r.next = (r.next + 1) % SAMPLE_SIZE;
  r.filled = Math.min(r.filled + 1, SAMPLE_SIZE);
  r.count++;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

export function latencyMiddleware(req, res, next) {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    // Use the matched route pattern (e.g. /api/patients/:id) to keep cardinality low.
    if (!req.route) return;
    const ms = Number(process.hrtime.bigint() - start) / 1e6;
    record(`${req.method} ${req.baseUrl}${req.route.path}`, ms);
  });
  next();
}

export function snapshot() {
  const out = [];
  for (const [route, r] of routes) {
    const sorted = Array.from(r.samples.subarray(0, r.filled)).sort((a, b) => a - b);
    out.push({
      route,
      count: r.count,
      p50: +percentile(sorted, 50).toFixed(2),
      p95: +percentile(sorted, 95).toFixed(2),
      p99: +percentile(sorted, 99).toFixed(2),
      max: +(sorted[sorted.length - 1] ?? 0).toFixed(2),
    });
  }
  out.sort((a, b) => b.count - a.count);
  return {
    routes: out,
    scheduling: {
      bookingAttempts: counters.bookingAttempts,
      bookingConflicts: counters.bookingConflicts,
      conflictRate: counters.bookingAttempts ? +(counters.bookingConflicts / counters.bookingAttempts).toFixed(4) : 0,
    },
    ingest: {
      vitalsIngested: counters.vitalsIngested,
      flushes: counters.vitalsFlushes,
      avgFlushMs: counters.vitalsFlushes ? +(counters.vitalsFlushMsTotal / counters.vitalsFlushes).toFixed(2) : 0,
      alertsRaised: counters.alertsRaised,
    },
  };
}
