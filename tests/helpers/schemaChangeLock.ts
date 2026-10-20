import { pool } from '../../server/lib/db';

/**
 * Keeps the backup round trip and the specs that change the schema apart.
 *
 * Spec files run side by side against one database. migrate.spec.ts creates
 * and drops a scratch table; dbBackup.spec.ts dumps the whole database. The
 * backup lists the tables inside one snapshot, then counts each one and
 * `pg_dump` locks each one, and both look the names up in the live catalogue.
 * A table dropped in between fails the backup with "relation does not exist".
 * It failed that way once, under Vitest 5's scheduling, and could have under
 * any other.
 *
 * Production needs none of this: nothing there changes the schema while the
 * backup runs except a deploy's migrations, and a failed backup is retried.
 *
 * Holds a session-level advisory lock on a client of its own until the
 * returned function is called. The key is a string, hashed the way the app
 * hashes its own lock names, so it cannot collide with one of them.
 */
const SCHEMA_CHANGE_LOCK = 'wedmoments-tests:schema-change';

export async function holdSchemaChangeLock(): Promise<() => Promise<void>> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [SCHEMA_CHANGE_LOCK]);
  } catch (err) {
    client.release();
    throw err;
  }
  return async () => {
    try {
      await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [SCHEMA_CHANGE_LOCK]);
    } finally {
      client.release();
    }
  };
}
