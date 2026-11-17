import { query } from '../db.js';

// Generates 1 Hz vitals for monitored patients (stand-in for bedside / wearable
// devices) and drifts ER wait times so routing reacts to live conditions.

const BASELINES = {
  low: { heart_rate: 72, spo2: 98, systolic_bp: 120, resp_rate: 14, temperature: 36.8 },
  medium: { heart_rate: 84, spo2: 96, systolic_bp: 132, resp_rate: 17, temperature: 37.1 },
  high: { heart_rate: 96, spo2: 94, systolic_bp: 145, resp_rate: 20, temperature: 37.6 },
};
const NOISE = { heart_rate: 2.5, spo2: 0.4, systolic_bp: 2.5, resp_rate: 0.6, temperature: 0.04 };
const EPISODE = { heart_rate: 45, spo2: -8, systolic_bp: -35, resp_rate: 9, temperature: 1.2 };

const gauss = () => {
  const u = 1 - Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * Math.random());
};

export async function startSimulator({ processor, onFacilityUpdate }) {
  const { rows: patients } = await query(`SELECT id, risk_level FROM patients WHERE monitored ORDER BY id`);
  const state = new Map(
    patients.map((p) => [p.id, { base: BASELINES[p.risk_level], current: { ...BASELINES[p.risk_level] }, episode: 0, episodeLen: 0 }]),
  );

  const vitalsTimer = setInterval(async () => {
    for (const [patientId, s] of state) {
      // Rare deterioration episodes so alerts actually fire during a demo.
      if (s.episode === 0 && Math.random() < 0.003) {
        s.episodeLen = 30 + Math.floor(Math.random() * 30);
        s.episode = s.episodeLen;
      }
      const intensity = s.episode > 0 ? Math.sin((Math.PI * (s.episodeLen - s.episode)) / s.episodeLen) : 0;
      if (s.episode > 0) s.episode--;

      const reading = { patient_id: patientId };
      for (const k of Object.keys(NOISE)) {
        const target = s.base[k] + EPISODE[k] * intensity;
        // Mean-reverting random walk toward the (possibly shifted) target.
        s.current[k] += 0.3 * (target - s.current[k]) + NOISE[k] * gauss();
        reading[k] = +s.current[k].toFixed(k === 'temperature' ? 2 : 1);
      }
      reading.spo2 = Math.min(100, reading.spo2);
      try {
        await processor.ingest(reading);
      } catch (err) {
        console.error('[simulator] ingest failed', err.message);
      }
    }
  }, 1000);

  const facilityTimer = setInterval(async () => {
    try {
      const { rows } = await query(
        `UPDATE facilities
            SET current_wait_minutes = GREATEST(0, LEAST(180, current_wait_minutes + floor(random() * 11 - 5)::int)),
                updated_at = now()
          WHERE type IN ('hospital', 'urgent_care')
          RETURNING id, current_wait_minutes, updated_at`,
      );
      onFacilityUpdate?.(rows);
    } catch (err) {
      console.error('[simulator] facility update failed', err.message);
    }
  }, 10_000);

  console.log(`[simulator] streaming vitals for ${state.size} monitored patients`);
  return () => {
    clearInterval(vitalsTimer);
    clearInterval(facilityTimer);
  };
}
