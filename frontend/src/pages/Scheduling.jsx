import { useEffect, useState } from 'react';
import { api } from '../api.js';
import { usePolling } from '../usePolling.js';
import { clinicLocalToIso, fmtClinic as fmt } from '../time.js';

function defaultPreferred() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  d.setHours(10, 0, 0, 0);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T10:00`;
}

const PRIORITIES = [
  { value: 1, label: '1 · Urgent (ASAP)' },
  { value: 2, label: '2 · High (ASAP)' },
  { value: 3, label: '3 · Routine' },
  { value: 4, label: '4 · Follow-up' },
  { value: 5, label: '5 · Flexible' },
];

export default function Scheduling() {
  const { data: patients } = usePolling('/patients?limit=250', 0);
  const { data: specialties } = usePolling('/specialties', 0);
  const [form, setForm] = useState({ patientId: '', specialty: '', preferredStart: defaultPreferred(), priority: 3, reason: '' });
  const [options, setOptions] = useState(null);
  const [message, setMessage] = useState(null);
  const [busy, setBusy] = useState(false);
  const appointmentsPath = form.patientId ? `/appointments?patientId=${form.patientId}` : '/appointments';
  const { data: appointments, reload } = usePolling(appointmentsPath, 15000);

  useEffect(() => {
    if (!form.specialty && specialties?.length) setForm((f) => ({ ...f, specialty: specialties[0].specialty }));
  }, [specialties, form.specialty]);

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));
  const payload = () => ({
    patientId: form.patientId ? Number(form.patientId) : undefined,
    specialty: form.specialty,
    preferredStart: clinicLocalToIso(form.preferredStart),
    priority: Number(form.priority),
    reason: form.reason || undefined,
  });

  const run = async (fn) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ tone: 'error', text: err.message });
      if (err.body?.alternatives) setOptions(err.body.alternatives);
    } finally {
      setBusy(false);
    }
  };

  const suggest = () => run(async () => setOptions((await api.post('/appointments/suggest', payload())).options));

  const book = (o) =>
    run(async () => {
      if (!form.patientId) throw new Error('Select a patient first');
      await api.post('/appointments', { patientId: Number(form.patientId), providerId: o.providerId, start: o.start, end: o.end, priority: Number(form.priority), reason: form.reason || undefined });
      setMessage({ tone: 'ok', text: `Booked ${o.providerName} at ${o.facilityName}, ${fmt(o.start)}` });
      setOptions(null);
      reload();
    });

  const autoBook = () =>
    run(async () => {
      if (!form.patientId) throw new Error('Select a patient first');
      const r = await api.post('/appointments/auto', payload());
      setMessage({ tone: 'ok', text: `Auto-booked ${r.option.providerName} at ${r.option.facilityName}, ${fmt(r.option.start)}${r.attempts > 1 ? ` (resolved ${r.attempts - 1} race conflict${r.attempts > 2 ? 's' : ''})` : ''}` });
      setOptions(null);
      reload();
    });

  const cancel = (id) => run(async () => {
    await api.post(`/appointments/${id}/cancel`);
    reload();
  });

  return (
    <div className="page grid two">
      <div className="stack">
        <div className="card">
          <h2>Request an appointment</h2>
          <div className="form">
            <label>Patient
              <select value={form.patientId} onChange={set('patientId')}>
                <option value="">Select…</option>
                {(patients ?? []).map((p) => <option key={p.id} value={p.id}>#{p.id} {p.name}</option>)}
              </select>
            </label>
            <label>Specialty
              <select value={form.specialty} onChange={set('specialty')}>
                {(specialties ?? []).map((s) => <option key={s.specialty} value={s.specialty}>{s.specialty.replace('_', ' ')} ({s.providers})</option>)}
              </select>
            </label>
            <label>Preferred time (clinic, ET)
              <input type="datetime-local" value={form.preferredStart} onChange={set('preferredStart')} />
            </label>
            <label>Priority
              <select value={form.priority} onChange={set('priority')}>
                {PRIORITIES.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
              </select>
            </label>
            <label className="wide">Reason
              <input value={form.reason} onChange={set('reason')} placeholder="Optional" />
            </label>
          </div>
          <div className="actions">
            <button className="primary" disabled={busy} onClick={suggest}>Find slots</button>
            <button disabled={busy || !form.patientId} onClick={autoBook}>Auto-book best slot</button>
          </div>
          {message && <div className={`banner ${message.tone}`}>{message.text}</div>}
        </div>

        {options && (
          <div className="card">
            <h2>Suggested slots</h2>
            <p className="muted">Ranked by closeness to the preferred time, provider load, travel distance and calendar fragmentation.</p>
            {options.length === 0 && <p className="muted">No free slots in the search window.</p>}
            <ul className="options">
              {options.map((o) => (
                <li key={`${o.providerId}-${o.start}`}>
                  <div>
                    <strong>{fmt(o.start)}</strong>
                    <div className="small">{o.providerName} · {o.facilityName}</div>
                    <div className="muted small">{o.distanceKm != null ? `${o.distanceKm} km from home · ` : ''}score {o.score}</div>
                  </div>
                  <button disabled={busy || !form.patientId} onClick={() => book(o)}>Book</button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <div className="card">
        <h2>{form.patientId ? 'Patient’s upcoming appointments' : 'Upcoming appointments (next 14 days)'}</h2>
        <table>
          <thead><tr><th>When (ET)</th><th>Patient</th><th>Provider</th><th>Facility</th><th /></tr></thead>
          <tbody>
            {(appointments ?? []).slice(0, 60).map((a) => (
              <tr key={a.id}>
                <td>{fmt(a.start)}</td>
                <td>{a.patient_name}</td>
                <td>{a.provider_name}<div className="muted small">{a.specialty.replace('_', ' ')}</div></td>
                <td className="small">{a.facility_name}</td>
                <td><button className="link" onClick={() => cancel(a.id)}>Cancel</button></td>
              </tr>
            ))}
            {appointments?.length === 0 && <tr><td colSpan="5" className="muted">Nothing booked.</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  );
}
