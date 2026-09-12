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

const TEST_TABLE = 'migrate_spec_scratch';
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
  await cleanUp([
    '900_spec_create.sql',
    '901_spec_alter.sql',
    '902_spec_broken.sql',
    '903_spec_after_broken.sql',
  ]);
});

describe('SQL migration runner', () => {
  it('applies pending migrations in filename order and records them', async () => {
    writeMigration('900_spec_create.sql', `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id INT PRIMARY KEY);`);
    writeMigration('901_spec_alter.sql', `ALTER TABLE ${TEST_TABLE} ADD COLUMN IF NOT EXISTS label TEXT;`);

    const result = await runMigrations(tempDir);

    // Order matters: the ALTER cannot run before the CREATE.
    expect(result.applied).toEqual(['900_spec_create.sql', '901_spec_alter.sql']);
    expect(result.checksumDrift).toEqual([]);

    const { rows } = await query(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = $1 ORDER BY column_name`,
      [TEST_TABLE]
    );
    expect(rows.map((r) => r.column_name)).toEqual(['id', 'label']);

    const ledger = await ledgerFor(['900_spec_create.sql', '901_spec_alter.sql']);
    expect(ledger).toHaveLength(2);

    await cleanUp(['900_spec_create.sql', '901_spec_alter.sql']);
  });

  it('is idempotent — a second run applies nothing', async () => {
    writeMigration('900_spec_create.sql', `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id INT PRIMARY KEY);`);

    const first = await runMigrations(tempDir);
    expect(first.applied).toEqual(['900_spec_create.sql']);

    const second = await runMigrations(tempDir);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toContain('900_spec_create.sql');

    await cleanUp(['900_spec_create.sql']);
  });

  it('reports drift when an already-applied migration is edited, and does not re-run it', async () => {
    writeMigration('900_spec_create.sql', `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id INT PRIMARY KEY);`);
    await runMigrations(tempDir);

    // Editing an applied migration is the mistake this warning exists to catch:
    // the change would never reach a database that already ran the old version.
    writeMigration(
      '900_spec_create.sql',
      `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id INT PRIMARY KEY); -- edited after the fact`
    );

    const result = await runMigrations(tempDir);
    expect(result.checksumDrift).toEqual(['900_spec_create.sql']);
    expect(result.applied).toEqual([]);

    await cleanUp(['900_spec_create.sql']);
  });

  it('rolls a failing migration back and stops, leaving the ledger clean', async () => {
    writeMigration('900_spec_create.sql', `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id INT PRIMARY KEY);`);
    writeMigration(
      '902_spec_broken.sql',
      `ALTER TABLE ${TEST_TABLE} ADD COLUMN broken_col TEXT; SELECT this_function_does_not_exist();`
    );
    writeMigration('903_spec_after_broken.sql', `ALTER TABLE ${TEST_TABLE} ADD COLUMN never_added TEXT;`);

    await expect(runMigrations(tempDir)).rejects.toThrow(/902_spec_broken/);

    // The broken migration's own statements must not survive...
    const { rows: cols } = await query(
      'SELECT column_name FROM information_schema.columns WHERE table_name = $1',
      [TEST_TABLE]
    );
    const names = cols.map((c) => c.column_name);
    expect(names).not.toContain('broken_col');
    // ...and the run stops rather than skipping ahead.
    expect(names).not.toContain('never_added');

    const ledger = await ledgerFor(['902_spec_broken.sql', '903_spec_after_broken.sql']);
    expect(ledger).toHaveLength(0);

    await cleanUp(['900_spec_create.sql', '902_spec_broken.sql', '903_spec_after_broken.sql']);
  });

  it('fails loudly when the migrations directory is missing', async () => {
    await expect(runMigrations(path.join(tempDir, 'does-not-exist'))).rejects.toThrow(
      /Migrations directory not found/
    );
  });

  it('ignores non-SQL files in the directory', async () => {
    writeMigration('900_spec_create.sql', `CREATE TABLE IF NOT EXISTS ${TEST_TABLE} (id INT PRIMARY KEY);`);
    fs.writeFileSync(path.join(tempDir, 'README.md'), '# not a migration', 'utf8');
    fs.writeFileSync(path.join(tempDir, 'notes.txt'), 'ignore me', 'utf8');

    const result = await runMigrations(tempDir);
    expect(result.applied).toEqual(['900_spec_create.sql']);

    await cleanUp(['900_spec_create.sql']);
  });
});
