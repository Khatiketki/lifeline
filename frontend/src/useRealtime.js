import { useEffect, useRef, useState } from 'react';

const HISTORY = 60;

/**
 * Subscribes to the core API WebSocket and keeps:
 *  - the latest reading + short history per patient (for sparklines)
 *  - a rolling feed of alerts
 * Reconnects with backoff if the socket drops.
 */
export function useRealtime() {
  const [vitals, setVitals] = useState({});
  const [alerts, setAlerts] = useState([]);
  const [facilityWaits, setFacilityWaits] = useState({});
  const [connected, setConnected] = useState(false);
  const retry = useRef(0);

  useEffect(() => {
    let socket;
    let timer;
    let closed = false;

    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      socket = new WebSocket(`${proto}://${location.host}/ws`);
      socket.onopen = () => {
        retry.current = 0;
        setConnected(true);
      };
      socket.onclose = () => {
        setConnected(false);
        if (closed) return;
        const delay = Math.min(10_000, 500 * 2 ** retry.current++);
        timer = setTimeout(connect, delay);
      };
      socket.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'vitals') {
          setVitals((prev) => {
            const next = { ...prev };
            for (const r of msg.data) {
              const hist = prev[r.patient_id]?.history ?? [];
              next[r.patient_id] = { latest: r, history: [...hist, r].slice(-HISTORY) };
            }
            return next;
          });
        } else if (msg.type === 'alert') {
          setAlerts((prev) => [msg.data, ...prev].slice(0, 50));
        } else if (msg.type === 'facility_wait') {
          setFacilityWaits((prev) => {
            const next = { ...prev };
            for (const f of msg.data) next[f.id] = f.current_wait_minutes;
            return next;
          });
        }
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    };
  }, []);

  return { vitals, alerts, setAlerts, facilityWaits, connected };
}
