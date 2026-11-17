import { test } from 'node:test';
import assert from 'node:assert/strict';
import { earlyWarningScore } from '../src/realtime/ews.js';
import { VitalsProcessor } from '../src/realtime/processor.js';

const normal = { heart_rate: 72, spo2: 98, systolic_bp: 120, resp_rate: 14, temperature: 36.8 };

test('EWS is zero for normal vitals', () => {
  assert.deepEqual(earlyWarningScore(normal), { total: 0, level: 'normal', parts: { resp_rate: 0, spo2: 0, systolic_bp: 0, heart_rate: 0, temperature: 0 } });
});

test('EWS escalates for deteriorating vitals', () => {
  const r = earlyWarningScore({ heart_rate: 125, spo2: 91, systolic_bp: 95, resp_rate: 23, temperature: 38.5 });
  assert.equal(r.total, 2 + 3 + 2 + 2 + 1);
  assert.equal(r.level, 'critical');
  assert.equal(earlyWarningScore({ ...normal, spo2: 90 }).level, 'warning'); // single red-flag parameter
});

function makeProcessor() {
  let t = 0;
  const saved = [];
  const alerts = [];
  const p = new VitalsProcessor({
    persistReadings: async (batch) => saved.push(...batch),
    persistAlert: async (a) => ({ id: alerts.length + 1, ...a }),
    onAlert: (a) => alerts.push(a),
    now: () => t,
  });
  return { p, saved, alerts, advance: (ms) => (t += ms) };
}

test('buffers readings and flushes them in one batch', async () => {
  const { p, saved } = makeProcessor();
  for (let i = 0; i < 5; i++) await p.ingest({ patient_id: 1, ...normal });
  assert.equal(saved.length, 0);
  assert.equal(await p.flush(), 5);
  assert.equal(saved.length, 5);
  assert.equal(await p.flush(), 0);
});

test('re-queues a batch when persistence fails', async () => {
  let fail = true;
  const p = new VitalsProcessor({
    persistReadings: async () => { if (fail) throw new Error('db down'); },
    persistAlert: async () => null,
  });
  await p.ingest({ patient_id: 1, ...normal });
  await assert.rejects(p.flush());
  fail = false;
  assert.equal(await p.flush(), 1);
});

test('detects heart-rate anomaly against the sliding window', async () => {
  const { p, alerts, advance } = makeProcessor();
  for (let i = 0; i < 30; i++) {
    advance(1000);
    await p.ingest({ patient_id: 7, ...normal, heart_rate: 70 + (i % 5) });
  }
  assert.equal(alerts.length, 0);
  await p.ingest({ patient_id: 7, ...normal, heart_rate: 88 });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].kind, 'hr_anomaly');
});

test('alert cooldown suppresses duplicates', async () => {
  const { p, alerts, advance } = makeProcessor();
  const bad = { patient_id: 2, ...normal, spo2: 89 };
  await p.ingest(bad);
  advance(10_000);
  await p.ingest(bad);
  assert.equal(alerts.length, 1);
  advance(61_000);
  await p.ingest(bad);
  assert.equal(alerts.length, 2);
});

test('rejects readings without a valid patient id', async () => {
  const { p } = makeProcessor();
  await assert.rejects(p.ingest({ ...normal }), /patient_id/);
});
