import { useState } from 'react';
import { useRealtime } from './useRealtime.js';
import Dashboard from './pages/Dashboard.jsx';
import Monitoring from './pages/Monitoring.jsx';
import Scheduling from './pages/Scheduling.jsx';
import Routing from './pages/Routing.jsx';

const TABS = [
  { id: 'dashboard', label: 'Overview' },
  { id: 'monitoring', label: 'Live monitoring' },
  { id: 'scheduling', label: 'Scheduling' },
  { id: 'routing', label: 'Emergency routing' },
];

export default function App() {
  const [tab, setTab] = useState('dashboard');
  const realtime = useRealtime();
  const openAlerts = realtime.alerts.filter((a) => !a.acknowledged).length;

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <path d="M2 12h4l3-8 4 16 3-8h6" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
          Lifeline
        </div>
        <nav>
          {TABS.map((t) => (
            <button key={t.id} className={tab === t.id ? 'active' : ''} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === 'monitoring' && openAlerts > 0 && <span className="pill critical">{openAlerts}</span>}
            </button>
          ))}
        </nav>
        <div className={`conn ${realtime.connected ? 'on' : 'off'}`}>{realtime.connected ? 'Live' : 'Reconnecting…'}</div>
      </header>
      <main>
        {tab === 'dashboard' && <Dashboard realtime={realtime} />}
        {tab === 'monitoring' && <Monitoring realtime={realtime} />}
        {tab === 'scheduling' && <Scheduling />}
        {tab === 'routing' && <Routing realtime={realtime} />}
      </main>
    </div>
  );
}
