import { usePolling } from '../usePolling.js';

function Stat({ label, value, tone }) {
  return (
    <div className={`card stat ${tone ?? ''}`}>
      <div className="stat-value">{value ?? '–'}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}

export default function Dashboard({ realtime }) {
  const { data: stats, error } = usePolling('/stats', 5000);
  const { data: metrics } = usePolling('/metrics', 3000);
  const liveReadings = Object.keys(realtime.vitals).length;
  const sched = metrics?.scheduling;
  const ingest = metrics?.ingest;

  return (
    <div className="page">
      {error && <div className="banner error">API unavailable: {error}</div>}
      <section className="grid stats">
        <Stat label="Patients" value={stats?.patients} />
        <Stat label="Monitored (live)" value={stats ? `${liveReadings}/${stats.monitored}` : null} />
        <Stat label="Upcoming appointments" value={stats?.upcoming_appointments} />
        <Stat label="Providers" value={stats?.providers} />
        <Stat label="Facilities" value={stats?.facilities} />
        <Stat label="Open alerts" value={stats?.open_alerts} tone={stats?.open_alerts ? 'critical' : ''} />
      </section>

      <section className="grid two">
        <div className="card">
          <h2>API latency</h2>
          <p className="muted">Server-side, rolling window of the last 2,000 requests per route.</p>
          <table>
            <thead>
              <tr><th>Route</th><th className="num">Requests</th><th className="num">p50 ms</th><th className="num">p95 ms</th><th className="num">p99 ms</th></tr>
            </thead>
            <tbody>
              {(metrics?.routes ?? []).slice(0, 10).map((r) => (
                <tr key={r.route}>
                  <td className="mono">{r.route}</td>
                  <td className="num">{r.count}</td>
                  <td className="num">{r.p50}</td>
                  <td className={`num ${r.p95 > 1000 ? 'bad' : ''}`}>{r.p95}</td>
                  <td className="num">{r.p99}</td>
                </tr>
              ))}
              {metrics && metrics.routes.length === 0 && <tr><td colSpan="5" className="muted">No traffic yet.</td></tr>}
            </tbody>
          </table>
        </div>

        <div className="stack">
          <div className="card">
            <h2>Scheduling</h2>
            <dl className="kv">
              <dt>Booking attempts</dt><dd>{sched?.bookingAttempts ?? '–'}</dd>
              <dt>Conflicts (rejected by DB)</dt><dd>{sched?.bookingConflicts ?? '–'}</dd>
              <dt>Conflict rate</dt><dd>{sched ? `${(sched.conflictRate * 100).toFixed(1)}%` : '–'}</dd>
            </dl>
          </div>
          <div className="card">
            <h2>Stream processing</h2>
            <dl className="kv">
              <dt>Readings ingested</dt><dd>{ingest?.vitalsIngested?.toLocaleString() ?? '–'}</dd>
              <dt>Batch writes</dt><dd>{ingest?.flushes ?? '–'}</dd>
              <dt>Avg batch write</dt><dd>{ingest ? `${ingest.avgFlushMs} ms` : '–'}</dd>
              <dt>Alerts raised</dt><dd>{ingest?.alertsRaised ?? '–'}</dd>
            </dl>
          </div>
        </div>
      </section>
    </div>
  );
}
