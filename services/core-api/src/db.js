import pg from 'pg';
import { config } from './config.js';

// Return BIGINT ids as numbers; our ids stay well below 2^53.
pg.types.setTypeParser(20, (v) => Number(v));
// NUMERIC -> number (used for distances and averages).
pg.types.setTypeParser(1700, (v) => Number(v));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  // Verified TLS; the image trusts the RDS CA bundle via NODE_EXTRA_CA_CERTS.
  ssl: config.dbSsl || undefined,
  max: config.dbPoolSize,
  idleTimeoutMillis: 30_000,
  // Fail fast instead of queueing requests forever when the DB is unhealthy.
  connectionTimeoutMillis: 5_000,
  statement_timeout: 5_000,
});

pool.on('error', (err) => console.error('[db] idle client error', err.message));

export function query(text, params) {
  return pool.query(text, params);
}

export async function waitForDb({ attempts = 30, delayMs = 2000 } = {}) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      console.log(`[db] not ready (${i}/${attempts}): ${err.message}`);
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('database unavailable');
}
