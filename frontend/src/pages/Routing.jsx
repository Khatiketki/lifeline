import { useState } from 'react';
import { CircleMarker, MapContainer, Polyline, TileLayer, Tooltip, useMapEvents } from 'react-leaflet';
import { api } from '../api.js';
import { usePolling } from '../usePolling.js';

const CENTER = [42.35, -71.075];
const TYPE_COLORS = { hospital: '#e5484d', urgent_care: '#f5a524', clinic: '#3b82f6' };

function ClickToSetOrigin({ onPick }) {
  useMapEvents({ click: (e) => onPick({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

export default function Routing({ realtime }) {
  const { data: facilities } = usePolling('/facilities', 30000);
  const [origin, setOrigin] = useState(null);
  const [filter, setFilter] = useState({ specialty: 'emergency', type: '' });
  const [result, setResult] = useState(null);
  const [selected, setSelected] = useState(0);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const search = async (o = origin) => {
    if (!o) return;
    setLoading(true);
    setError(null);
    const t0 = performance.now();
    try {
      const qs = new URLSearchParams({ lat: o.lat, lng: o.lng, k: 3, ...(filter.specialty && { specialty: filter.specialty }), ...(filter.type && { type: filter.type }) });
      const r = await api.get(`/facilities/nearest?${qs}`);
      setResult({ ...r, roundTripMs: Math.round(performance.now() - t0) });
      setSelected(0);
    } catch (err) {
      setError(err.message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  const pick = (o) => {
    setOrigin(o);
    search(o);
  };

  const chosen = result?.options?.[selected];
  const wait = (f) => realtime.facilityWaits[f.id] ?? f.current_wait_minutes;

  return (
    <div className="page routing">
      <div className="card map-card">
        <MapContainer center={CENTER} zoom={13} className="map">
          <TileLayer attribution='&copy; OpenStreetMap contributors' url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" />
          <ClickToSetOrigin onPick={pick} />
          {(facilities ?? []).map((f) => (
            <CircleMarker key={f.id} center={[f.lat, f.lng]} radius={f.type === 'hospital' ? 9 : 7} pathOptions={{ color: TYPE_COLORS[f.type], fillOpacity: 0.85 }}>
              <Tooltip>
                <strong>{f.name}</strong><br />
                {f.type.replace('_', ' ')}{f.type !== 'clinic' && ` · wait ${wait(f)} min`}
              </Tooltip>
            </CircleMarker>
          ))}
          {result?.options?.map((o, i) =>
            i === selected ? null : (
              <Polyline key={o.id} positions={o.route.path.map((p) => [p.lat, p.lng])} pathOptions={{ color: '#8b8d98', weight: 3, opacity: 0.5 }} />
            ),
          )}
          {chosen && <Polyline positions={chosen.route.path.map((p) => [p.lat, p.lng])} pathOptions={{ color: '#12a594', weight: 5 }} />}
          {origin && <CircleMarker center={[origin.lat, origin.lng]} radius={8} pathOptions={{ color: '#111', fillColor: '#fff', fillOpacity: 1, weight: 3 }} />}
        </MapContainer>
      </div>

      <aside className="stack">
        <div className="card">
          <h2>Find care fastest</h2>
          <p className="muted">Click the map to set the patient’s location. Facilities are ranked by drive time (A* over the road graph) plus live ER wait.</p>
          <div className="form">
            <label>Need
              <select value={filter.specialty} onChange={(e) => setFilter((f) => ({ ...f, specialty: e.target.value }))}>
                <option value="emergency">Emergency</option>
                <option value="cardiology">Cardiology</option>
                <option value="pediatrics">Pediatrics</option>
                <option value="orthopedics">Orthopedics</option>
                <option value="">Any</option>
              </select>
            </label>
            <label>Facility type
              <select value={filter.type} onChange={(e) => setFilter((f) => ({ ...f, type: e.target.value }))}>
                <option value="">Any</option>
                <option value="hospital">Hospital</option>
                <option value="urgent_care">Urgent care</option>
                <option value="clinic">Clinic</option>
              </select>
            </label>
          </div>
          <div className="actions">
            <button className="primary" disabled={!origin || loading} onClick={() => search()}>{loading ? 'Routing…' : 'Re-run'}</button>
          </div>
          {error && <div className="banner error">{error}</div>}
        </div>

        {result && (
          <div className="card">
            <h2>Best options</h2>
            <p className="muted small">Computed in {result.computeMillis} ms on the routing service · {result.roundTripMs} ms round trip</p>
            {result.options.length === 0 && <p className="muted">No reachable facility matches.</p>}
            <ul className="options">
              {result.options.map((o, i) => (
                <li key={o.id} className={i === selected ? 'selected' : ''} onClick={() => setSelected(i)}>
                  <div>
                    <strong>{i + 1}. {o.name}</strong>
                    <div className="small">
                      {(o.route.durationSeconds / 60).toFixed(1)} min drive · {(o.route.distanceMeters / 1000).toFixed(1)} km
                      {o.type !== 'clinic' && ` · ${o.waitMinutes} min wait`}
                    </div>
                    <div className="muted small">{o.route.nodesExpanded} nodes searched</div>
                  </div>
                  <span className="total">{o.totalMinutes}<small> min</small></span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </aside>
    </div>
  );
}
