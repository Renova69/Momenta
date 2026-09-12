import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { pool } from './db';

/**
 * Forward-only SQL migration runner.
 *
 * Every file in `database/migrations` is applied once, in filename order, and
 * recorded in `schema_migrations`. Existing databases created before this runner
 * existed are safe to migrate: each migration is written idempotently (guarded
 * with IF NOT EXISTS / ON CONFLICT), so replaying one that was already applied
 * by hand or by the Docker init directory is a no-op.
 */

const DEFAULT_MIGRATIONS_DIR = path.join(process.cwd(), 'database', 'migrations');

// Fixed key so concurrent instances (Cloud Run, docker compose scale) serialise.
const ADVISORY_LOCK_KEY = 8274419065321771n;

export interface MigrationResult {
  applied: string[];
  alreadyApplied: string[];
  checksumDrift: string[];
}

function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql).digest('hex').substring(0, 32);
}

function listMigrationFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) {
    throw new Error(`[migrate] Migrations directory not found: ${dir}`);
  }
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b, 'en'));
}

export async function runMigrations(
  migrationsDir: string = DEFAULT_MIGRATIONS_DIR
): Promise<MigrationResult> {
  const files = listMigrationFiles(migrationsDir);
  const result: MigrationResult = { applied: [], alreadyApplied: [], checksumDrift: [] };

  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY.toString()]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   TEXT PRIMARY KEY,
        checksum   TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const { rows } = await client.query<{ filename: string; checksum: string }>(
      'SELECT filename, checksum FROM schema_migrations'
    );
    const ledger = new Map(rows.map((r) => [r.filename, r.checksum]));

    for (const filename of files) {
      const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
      const sum = checksum(sql);
      const recorded = ledger.get(filename);

      if (recorded !== undefined) {
        if (recorded !== sum) {
          result.checksumDrift.push(filename);
          console.warn(
            `[migrate] ${filename} changed since it was applied. Already-applied migrations are ` +
            'never re-run — add a new migration instead of editing this one.'
          );
        }
        result.alreadyApplied.push(filename);
        continue;
      }

      // Each migration runs as one multi-statement simple query so dollar-quoted
      // DO $$ ... $$ blocks survive intact, wrapped in its own transaction.
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)',
          [filename, sum]
        );
        await client.query('COMMIT');
        result.applied.push(filename);
        console.log(`[migrate] applied ${filename}`);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(
          `[migrate] ${filename} failed: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY.toString()]).catch(() => {});
    client.release();
  }
}

/** CLI entry: `npm run migrate`. */
async function main() {
  try {
    const { applied, alreadyApplied, checksumDrift } = await runMigrations();
    if (applied.length === 0) {
      console.log(`[migrate] Database up to date (${alreadyApplied.length} migrations already applied).`);
    } else {
      console.log(`[migrate] Applied ${applied.length} migration(s); ${alreadyApplied.length} already up to date.`);
    }
    if (checksumDrift.length > 0) {
      console.warn(`[migrate] ${checksumDrift.length} applied migration(s) have been edited since: ${checksumDrift.join(', ')}`);
    }
    await pool.end();
    process.exit(0);
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && /migrate\.[tj]s$/.test(process.argv[1].replace(/\\/g, '/'));
if (invokedDirectly) {
  void main();
}
