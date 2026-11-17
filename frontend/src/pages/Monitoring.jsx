import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { usePolling } from '../usePolling.js';

function Sparkline({ values, min, max, warnBelow, warnAbove }) {
  if (values.length < 2) return <svg className="spark" />;
  const w = 160;
  const h = 36;
  const lo = Math.min(min, ...values);
  const hi = Math.max(max, ...values);
  const pts = values.map((v, i) => `${(i / (values.length - 1)) * w},${h - ((v - lo) / (hi - lo || 1)) * h}`).join(' ');
  const last = values[values.length - 1];
  const bad = (warnBelow != null && last < warnBelow) || (warnAbove != null && last > warnAbove);
  return (
    <svg className={`spark ${bad ? 'bad' : ''}`} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
      <polyline points={pts} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

const METRICS = [
  { key: 'heart_rate', label: 'HR', unit: 'bpm', min: 50, max: 120, warnBelow: 50, warnAbove: 110 },
  { key: 'spo2', label: 'SpO₂', unit: '%', min: 88, max: 100, warnBelow: 94 },
  { key: 'systolic_bp', label: 'Sys BP', unit: 'mmHg', min: 90, max: 160, warnBelow: 100, warnAbove: 180 },
  { key: 'resp_rate', label: 'Resp', unit: '/min', min: 10, max: 26, warnAbove: 21 },
];

function PatientCard({ patient, stream }) {
  const latest = stream?.latest;
  const level = latest?.ews_level ?? 'normal';
  return (
    <div className={`card patient ${level}`}>
      <div className="patient-head">
        <div>
          <strong>{patient.name}</strong>
          <div className="muted small">#{patient.id} · {patient.risk_level} risk</div>
        </div>
        <span className={`pill ${level}`}>EWS {latest?.ews_score ?? '–'}</span>
      </div>
      {METRICS.map((m) => (
        <div className="vital" key={m.key}>
          <span className="vital-label">{m.label}</span>
          <Sparkline values={(stream?.history ?? []).map((r) => r[m.key]).filter((v) => v != null)} {...m} />
          <span className="vital-value">{latest?.[m.key] != null ? Math.round(latest[m.key]) : '–'}<small> {m.unit}</small></span>
        </div>
      ))}
    </div>
  );
}

export default function Monitoring({ realtime }) {
  const { data: patients } = usePolling('/patients?monitored=true', 0);
  const [alerts, setAlerts] = useState([]);

  useEffect(() => {
    api.get('/alerts?open=true').then(setAlerts).catch(() => {});
  }, []);

  // Merge pushed alerts into the persisted list (newest first, de-duplicated).
  useEffect(() => {
    if (realtime.alerts.length === 0) return;
    setAlerts((prev) => {
      const seen = new Set(prev.map((a) => a.id));
      return [...realtime.alerts.filter((a) => !seen.has(a.id)), ...prev].slice(0, 100);
    });
  }, [realtime.alerts]);

  const names = Object.fromEntries((patients ?? []).map((p) => [p.id, p.name]));

  const ack = async (id) => {
    await api.post(`/alerts/${id}/ack`);
    setAlerts((prev) => prev.filter((a) => a.id !== id));
    realtime.setAlerts((prev) => prev.map((a) => (a.id === id ? { ...a, acknowledged: true } : a)));
  };

  return (
    <div className="page monitoring">
      <section className="patients">
        {(patients ?? []).map((p) => (
          <PatientCard key={p.id} patient={p} stream={realtime.vitals[p.id]} />
        ))}
      </section>
      <aside className="card alerts">
        <h2>Alerts</h2>
        {alerts.length === 0 && <p className="muted">No open alerts.</p>}
        <ul>
          {alerts.map((a) => (
            <li key={a.id ?? `${a.patient_id}-${a.created_at}`} className={a.severity}>
              <div className="alert-head">
                <span className={`pill ${a.severity}`}>{a.severity}</span>
                <span className="muted small">{new Date(a.created_at).toLocaleTimeString()}</span>
              </div>
              <div><strong>{a.patient_name ?? names[a.patient_id] ?? `Patient #${a.patient_id}`}</strong></div>
              <div className="small">{a.message}</div>
              {a.id && <button className="link" onClick={() => ack(a.id)}>Acknowledge</button>}
            </li>
          ))}
        </ul>
      </aside>
    </div>
  );
}
