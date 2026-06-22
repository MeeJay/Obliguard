import './src/env';
import path from 'path';
import type { Knex } from 'knex';

const isCompiled = __filename.endsWith('.js');

const config: Knex.Config = {
  client: 'pg',
  connection: process.env.DATABASE_URL || 'postgres://obliview:changeme@localhost:5432/obliview',
  searchPath: ['public'],
  migrations: {
    directory: isCompiled
      ? path.join(__dirname, 'src/db/migrations')
      : './src/db/migrations',
    extension: isCompiled ? 'js' : 'ts',
    loadExtensions: isCompiled ? ['.js'] : ['.ts'],
    schemaName: 'public',
  },
  seeds: {
    directory: isCompiled
      ? path.join(__dirname, 'src/db/seeds')
      : './src/db/seeds',
    extension: isCompiled ? 'js' : 'ts',
    loadExtensions: isCompiled ? ['.js'] : ['.ts'],
  },
  pool: {
    min: 2,
    // Env-overridable so a busy instance can be given headroom without a code
    // change. Keep modest by default — a shared Postgres caps total connections
    // across all Obli* instances.
    max: Number(process.env.DATABASE_POOL_MAX) || 10,
    // Fail fast instead of hanging forever when the pool is contended: a request
    // that can't get a connection in 20s errors out (and the UI shows an error)
    // rather than spinning indefinitely, and the slot is freed for the next one.
    acquireTimeoutMillis: 20000,
    // Release idle connections back to Postgres so they don't sit pinned.
    idleTimeoutMillis: 30000,
    reapIntervalMillis: 1000,
  },
};

export default config;
