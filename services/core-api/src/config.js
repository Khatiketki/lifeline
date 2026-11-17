const env = process.env;

export const config = {
  port: Number(env.PORT ?? 4000),
  // When PGHOST is set (e.g. on ECS, with PGPASSWORD injected from Secrets
  // Manager) node-postgres reads the standard PG* variables instead.
  databaseUrl: env.DATABASE_URL ?? (env.PGHOST ? undefined : 'postgres://lifeline:lifeline@localhost:5432/lifeline'),
  dbSsl: env.DB_SSL === 'true',
  dbPoolSize: Number(env.DB_POOL_SIZE ?? 20),
  routingUrl: env.ROUTING_URL ?? 'http://localhost:8080',
  clinicTimeZone: env.CLINIC_TZ ?? 'America/New_York',
  simulator: (env.SIMULATOR ?? 'true') === 'true',
  vitalsFlushMs: Number(env.VITALS_FLUSH_MS ?? 2000),
  corsOrigin: env.CORS_ORIGIN ?? '*',
};
