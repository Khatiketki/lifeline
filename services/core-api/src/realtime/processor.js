import { earlyWarningScore } from './ews.js';

const WINDOW = 60;           // readings kept per patient (~1 min at 1 Hz)
const MIN_FOR_ZSCORE = 20;
const Z_THRESHOLD = 3.5;
const MIN_HR_DELTA = 15;     // bpm
const ALERT_COOLDOWN_MS = 60_000;
const MAX_BUFFER = 50_000;   // back-pressure guard if the DB stalls

/**
 * Stream processor for incoming vitals:
 *  - scores every reading (EWS) and detects statistical anomalies against a
 *    per-patient sliding window,
 *  - de-duplicates alerts with a per-patient/kind cooldown,
 *  - buffers readings and persists them in batches (one round trip per flush).
 *
 * I/O is injected so the processor can be tested without a database.
 */
export class VitalsProcessor {
  constructor({ persistReadings, persistAlert, onReading = () => {}, onAlert = () => {}, now = () => Date.now() }) {
    this.persistReadings = persistReadings;
    this.persistAlert = persistAlert;
    this.onReading = onReading;
    this.onAlert = onAlert;
    this.now = now;
    this.windows = new Map();
    this.lastAlert = new Map();
    this.buffer = [];
    this.flushing = false;
  }

  window(patientId) {
    let w = this.windows.get(patientId);
    if (!w) {
      w = [];
      this.windows.set(patientId, w);
    }
    return w;
  }

  async ingest(raw) {
    const reading = {
      patient_id: Number(raw.patient_id ?? raw.patientId),
      recorded_at: raw.recorded_at ? new Date(raw.recorded_at) : new Date(this.now()),
      heart_rate: num(raw.heart_rate),
      spo2: num(raw.spo2),
      systolic_bp: num(raw.systolic_bp),
      resp_rate: num(raw.resp_rate),
      temperature: num(raw.temperature),
    };
    if (!Number.isInteger(reading.patient_id) || reading.patient_id <= 0) throw new Error('invalid patient_id');

    const ews = earlyWarningScore(reading);
    reading.ews_score = ews.total;

    const w = this.window(reading.patient_id);
    const anomaly = this.detectAnomaly(w, reading);
    w.push(reading);
    if (w.length > WINDOW) w.shift();

    if (this.buffer.length < MAX_BUFFER) this.buffer.push(reading);
    this.onReading({ ...reading, ews_level: ews.level });

    const alerts = [];
    if (ews.level !== 'normal') {
      alerts.push({
        kind: 'ews',
        severity: ews.level,
        message: `Early warning score ${ews.total} (${describe(ews.parts)})`,
      });
    }
    if (anomaly) alerts.push(anomaly);
    for (const a of alerts) await this.raise(reading.patient_id, a);
    return { reading, ews, alerts };
  }

  detectAnomaly(window, reading) {
    if (window.length < MIN_FOR_ZSCORE || reading.heart_rate == null) return null;
    const hr = window.map((r) => r.heart_rate).filter((v) => v != null);
    const mean = hr.reduce((a, b) => a + b, 0) / hr.length;
    const sd = Math.sqrt(hr.reduce((a, b) => a + (b - mean) ** 2, 0) / hr.length);
    if (sd < 1) return null; // flat signal: z-scores are meaningless
    const z = (reading.heart_rate - mean) / sd;
    // Require a clinically meaningful jump too; on a very steady signal a
    // tiny change can still produce a large z-score.
    if (Math.abs(z) < Z_THRESHOLD || Math.abs(reading.heart_rate - mean) < MIN_HR_DELTA) return null;
    return {
      kind: 'hr_anomaly',
      severity: 'warning',
      message: `Heart rate ${reading.heart_rate.toFixed(0)} bpm deviates from 1-min baseline ${mean.toFixed(0)} bpm (z=${z.toFixed(1)})`,
    };
  }

  async raise(patientId, alert) {
    const key = `${patientId}:${alert.kind}:${alert.severity}`;
    const t = this.now();
    if (t - (this.lastAlert.get(key) ?? -Infinity) < ALERT_COOLDOWN_MS) return;
    this.lastAlert.set(key, t);
    const stored = await this.persistAlert({ patient_id: patientId, ...alert });
    this.onAlert(stored ?? { patient_id: patientId, ...alert, created_at: new Date(t) });
  }

  async flush() {
    if (this.flushing || this.buffer.length === 0) return 0;
    this.flushing = true;
    const batch = this.buffer;
    this.buffer = [];
    try {
      await this.persistReadings(batch);
      return batch.length;
    } catch (err) {
      // Put the batch back (bounded) so a transient DB error doesn't lose data.
      this.buffer = batch.concat(this.buffer).slice(0, MAX_BUFFER);
      throw err;
    } finally {
      this.flushing = false;
    }
  }

  latest(patientId) {
    const w = this.windows.get(patientId);
    return w?.[w.length - 1] ?? null;
  }
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function describe(parts) {
  return Object.entries(parts)
    .filter(([, s]) => s > 0)
    .map(([k, s]) => `${k}+${s}`)
    .join(', ');
}
