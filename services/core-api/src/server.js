import http from 'node:http';
import express from 'express';
import cors from 'cors';
import { config } from './config.js';
import { pool, waitForDb } from './db.js';
import { errorHandler } from './errors.js';
import { counters, latencyMiddleware } from './metrics.js';
import { buildRouter } from './routes.js';
import { RealtimeHub } from './realtime/hub.js';
import { VitalsProcessor } from './realtime/processor.js';
import { persistAlert, persistReadings } from './realtime/persistence.js';
import { startSimulator } from './realtime/simulator.js';

const app = express();
const server = http.createServer(app);
const hub = new RealtimeHub(server, { path: '/ws' });

const processor = new VitalsProcessor({
  persistReadings,
  persistAlert,
  onReading: (r) => {
    counters.vitalsIngested++;
    hub.queueVitals(r);
  },
  onAlert: (a) => {
    counters.alertsRaised++;
    hub.broadcast('alert', a);
  },
});

app.disable('x-powered-by');
app.use(cors({ origin: config.corsOrigin }));
app.use(express.json({ limit: '1mb' }));
app.use(latencyMiddleware);
app.use('/api', buildRouter({ processor }));
app.use((_req, res) => res.status(404).json({ error: 'not found' }));
app.use(errorHandler);

const flushTimer = setInterval(async () => {
  const t0 = performance.now();
  try {
    const n = await processor.flush();
    if (n > 0) {
      counters.vitalsFlushes++;
      counters.vitalsFlushMsTotal += performance.now() - t0;
    }
  } catch (err) {
    console.error('[vitals] flush failed, will retry', err.message);
  }
}, config.vitalsFlushMs);

let stopSimulator = () => {};

async function main() {
  await waitForDb();
  server.listen(config.port, () => console.log(`[api] listening on :${config.port}`));
  if (config.simulator) {
    stopSimulator = await startSimulator({
      processor,
      onFacilityUpdate: (rows) => hub.broadcast('facility_wait', rows),
    });
  }
}

async function shutdown(signal) {
  console.log(`[api] ${signal} received, draining`);
  stopSimulator();
  clearInterval(flushTimer);
  hub.close();
  server.close();
  await processor.flush().catch(() => {});
  await pool.end();
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

main().catch((err) => {
  console.error('[api] failed to start', err);
  process.exit(1);
});
