import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMigrations } from '../../server/lib/migrate';
import { query } from '../../server/lib/db';

/**
 * The migration runner executes on every server boot, and the one time it did
 * not exist the production database silently fell eight migrations behind —
 * `GET /api/photos` returned 500 on every call. These specs cover the behaviour
 * that failure depended on.
 *
 * Throwaway migrations run against the real database in their own temp
 * directory, creating and dropping a scratch table, so they never touch the
 * application schema.
 */

/**
 * Every fixture this file creates is namespaced to this run.
 *
 * The scratch table and the ledger filenames used to be fixed strings, and the
 * ledger is a real table shared by every run on this database. A run killed
 * part-way — a timed-out CI job, or a mutation-testing harness reaping a slow
 * vitest — leaves `900_spec_create.sql` recorded as applied. The next run then
 * fails exactly two tests, because `runMigrations` correctly declines to
 * re-apply a migration the ledger already has; that run's `afterAll` clears the
 * row, so the run after it passes.
 *
 * Fail once, pass on retry, nothing reproducible, blame the database. This was
 * chased as suite flakiness before it was reproduced deliberately: seeding one
 * leftover row fails those two tests and only those two.
 *
 * A unique suffix makes the collision impossible rather than unlikely, which is
 * the same bargain `testPortAllocation.spec.ts` strikes for ports. Cleanup
 * still runs, and still matters for tidiness — it just no longer decides
 * whether the next run passes.
 */
const RUN_ID = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const TEST_TABLE = `migrate_spec_scratch_${RUN_ID}`;

/** `900_create` → `900_spec_<run>_create.sql`, unique to this run. */
function migrationName(stem: string): string {
  return `9${stem}_spec_${RUN_ID}.sql`;
}

const CREATE = migrationName('00_create');
const ALTER = migrationName('01_alter');
const BROKEN = migrationName('02_broken');
const AFTER_BROKEN = migrationName('03_after_broken');

let tempDir: string;

function writeMigration(name: string, sql: string) {
  fs.writeFileSync(path.join(tempDir, name), sql, 'utf8');
}

async function ledgerFor(filenames: string[]) {
  const { rows } = await query(
    'SELECT filename, checksum FROM schema_migrations WHERE filename = ANY($1::text[]) ORDER BY filename',
    [filenames]
  );
  return rows;
}

async function cleanUp(filenames: string[]) {
  await query(`DROP TABLE IF EXISTS ${TEST_TABLE}`);
  await query('DELETE FROM schema_migrations WHERE filename = ANY($1::text[])', [filenames]);
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wedmoments-migrate-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

afterAll(async () => {
  await cleanUp([CREATE, ALTER, BROKEN, AFTER_BROKEN]);
});

describe('SQL migration runner', () => {
  it('applies pending migrations in filename order and records them', async () => {
    writeMigration(CREATE, `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id INT PRIMARY KEY);`);
    writeMigration(ALTER, `ALTER TABLE ${TEST_TABLE} ADD COLUMN IF NOT EXISTS label TEXT;`);

    const result = await runMigrations(tempDir);

    // Order matters: the ALTER cannot run before the CREATE.
    expect(result.applied).toEqual([CREATE, ALTER]);
    expect(result.checksumDrift).toEqual([]);

    const { rows } = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = $1 ORDER BY column_name`,
      [TEST_TABLE]
    );
    expect(rows.map((r) => r.column_name)).toEqual(['id', 'label']);

    const ledger = await ledgerFor([CREATE, ALTER]);
    expect(ledger).toHaveLength(2);

    await cleanUp([CREATE, ALTER]);
  });

  it('is idempotent — a second run applies nothing', async () => {
    writeMigration(CREATE, `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id INT PRIMARY KEY);`);

    const first = await runMigrations(tempDir);
    expect(first.applied).toEqual([CREATE]);

    const second = await runMigrations(tempDir);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toContain(CREATE);

    await cleanUp([CREATE]);
  });

  it('reports drift when an already-applied migration is edited, and does not re-run it', async () => {
    writeMigration(CREATE, `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id INT PRIMARY KEY);`);
    await runMigrations(tempDir);

    // Editing an applied migration is the mistake this warning exists to catch:
    // the change would never reach a database that already ran the old version.
    writeMigration(CREATE, `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id INT PRIMARY KEY); -- edited after the fact`);

    const result = await runMigrations(tempDir);
    expect(result.checksumDrift).toEqual([CREATE]);
    expect(result.applied).toEqual([]);

    await cleanUp([CREATE]);
  });

  it('rolls a failing migration back and stops, leaving the ledger clean', async () => {
    writeMigration(CREATE, `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id INT PRIMARY KEY);`);
    writeMigration(
      BROKEN,
      `ALTER TABLE ${TEST_TABLE} ADD COLUMN broken_col TEXT; SELECT this_function_does_not_exist();`
    );
    writeMigration(AFTER_BROKEN, `ALTER TABLE ${TEST_TABLE} ADD COLUMN never_added TEXT;`);

    // Named by the constant, not a literal, or this stops matching the moment
    // the filenames became run-scoped.
    await expect(runMigrations(tempDir)).rejects.toThrow(BROKEN);

    // The broken migration's own statements must not survive...
    const { rows: cols } = await query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', [
      TEST_TABLE,
    ]);
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain('broken_col');
    // ...and the run stops rather than skipping ahead.
    expect(names).not.toContain('never_added');

    const ledger = await ledgerFor([BROKEN, AFTER_BROKEN]);
    expect(ledger).toHaveLength(0);

    await cleanUp([CREATE, BROKEN, AFTER_BROKEN]);
  });

  it('keeps the database error behind a failed migration, not only its message', async () => {
    writeMigration(BROKEN, 'SELECT this_function_does_not_exist();');

    const failure = await runMigrations(tempDir).then(
      () => null,
      (err: unknown) => err
    );

    // The message alone loses the SQLSTATE and the position, which are what
    // an operator reading a failed boot needs to find the bad statement.
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).cause).toMatchObject({ code: '42883' });

    await cleanUp([BROKEN]);
  });

  it('fails loudly when the migrations directory is missing', async () => {
    await expect(runMigrations(path.join(tempDir, 'does-not-exist'))).rejects.toThrow(/Migrations directory not found/);
  });

  it('ignores non-SQL files in the directory', async () => {
    writeMigration(CREATE, `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id INT PRIMARY KEY);`);
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# not a migration', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'notes.txt'), 'ignore me', 'utf8');

    const result = await runMigrations(tempDir);
    expect(result.applied).toEqual([CREATE]);

    await cleanUp([CREATE]);
  });
});
