import { query } from '../db.js';

// Multi-row insert via UNNEST: one statement and one round trip per batch,
// regardless of batch size, with a fixed parameter count (no 65k param limit).
export async function persistReadings(batch) {
  const cols = { patient_id: [], recorded_at: [], heart_rate: [], spo2: [], systolic_bp: [], resp_rate: [], temperature: [], ews_score: [] };
  for (const r of batch) for (const k of Object.keys(cols)) cols[k].push(r[k]);
  await query(
    `INSERT INTO vitals (patient_id, recorded_at, heart_rate, spo2, systolic_bp, resp_rate, temperature, ews_score)
     SELECT * FROM UNNEST($1::int[], $2::timestamptz[], $3::real[], $4::real[], $5::real[], $6::real[], $7::real[], $8::smallint[])`,
    Object.values(cols),
  );
}

export async function persistAlert(a) {
  const { rows } = await query(
    `INSERT INTO alerts (patient_id, severity, kind, message)
     VALUES ($1, $2, $3, $4)
     RETURNING id, patient_id, created_at, severity, kind, message, acknowledged`,
    [a.patient_id, a.severity, a.kind, a.message],
  );
  return rows[0];
}
