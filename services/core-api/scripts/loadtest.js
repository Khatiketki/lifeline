// Minimal dependency-free load test against a running stack.
//   node scripts/loadtest.js [--url http://localhost:4000] [--requests 2000] [--concurrency 50]

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith('--') ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const BASE = args.url ?? 'http://localhost:4000';
const TOTAL = Number(args.requests ?? 2000);
const CONCURRENCY = Number(args.concurrency ?? 50);

const tomorrow10 = () => {
  const d = new Date(Date.now() + 24 * 3600_000);
  d.setUTCHours(15, 0, 0, 0);
  return d.toISOString();
};

const scenarios = [
  { name: 'GET /api/patients', run: () => fetch(`${BASE}/api/patients?limit=50`) },
  { name: 'GET /api/patients/:id/vitals', run: () => fetch(`${BASE}/api/patients/${1 + Math.floor(Math.random() * 12)}/vitals?minutes=5`) },
  { name: 'GET /api/facilities/nearest', run: () => fetch(`${BASE}/api/facilities/nearest?lat=${42.31 + Math.random() * 0.08}&lng=${-71.14 + Math.random() * 0.12}&k=3`) },
  {
    name: 'POST /api/appointments/suggest',
    run: () =>
      fetch(`${BASE}/api/appointments/suggest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ patientId: 1 + Math.floor(Math.random() * 250), specialty: 'primary_care', preferredStart: tomorrow10() }),
      }),
  },
];

const results = new Map(scenarios.map((s) => [s.name, { lat: [], errors: 0 }]));
let issued = 0;

async function worker() {
  while (issued < TOTAL) {
    const s = scenarios[issued++ % scenarios.length];
    const t0 = performance.now();
    try {
      const res = await s.run();
      await res.arrayBuffer();
      if (!res.ok) results.get(s.name).errors++;
    } catch {
      results.get(s.name).errors++;
    }
    results.get(s.name).lat.push(performance.now() - t0);
  }
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;

const started = performance.now();
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
const secs = (performance.now() - started) / 1000;

console.log(`${TOTAL} requests, concurrency ${CONCURRENCY}, ${(TOTAL / secs).toFixed(0)} req/s\n`);
console.log('endpoint                          p50 ms   p95 ms   p99 ms   errors');
for (const [name, r] of results) {
  const s = r.lat.sort((a, b) => a - b);
  console.log(`${name.padEnd(32)} ${pct(s, 50).toFixed(1).padStart(7)}  ${pct(s, 95).toFixed(1).padStart(7)}  ${pct(s, 99).toFixed(1).padStart(7)}  ${String(r.errors).padStart(7)}`);
}
