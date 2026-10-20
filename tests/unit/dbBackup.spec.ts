import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CONFIG } from '../../server/lib/config';
import { libpqEnv, withDatabase, toolMajorVersion, toolCommand, pgToolsReachable, type PgTarget } from '../../scripts/lib/pgTools';
import { backupFileName, backupsToPrune, runBackup, sha256File } from '../../scripts/db-backup';
import { compareCounts, newestBackup, runRestoreCheck, SCRATCH_PREFIX } from '../../scripts/db-restore-check';
import { query } from '../../server/lib/db';
import { holdSchemaChangeLock } from '../helpers/schemaChangeLock';

/**
 * The database backup and the restore check. Nothing backed the database up;
 * these keep the two scripts honest, and run the real round trip — dump,
 * restore into a throwaway database, compare — wherever PostgreSQL's client
 * tools can be reached.
 */

let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-backup-spec-'));
});

afterAll(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('connecting without putting the password on a command line', () => {
  it('hands the password to the tools in the environment', () => {
    const env = libpqEnv('postgresql://ana:s3cr%40t@db.example.org:6543/wedding?sslmode=require');
    expect(env).toEqual({
      PGHOST: 'db.example.org',
      PGPORT: '6543',
      PGUSER: 'ana',
      PGDATABASE: 'wedding',
      PGPASSWORD: 's3cr@t',
      PGSSLMODE: 'require',
    });
  });

  it('never puts it in the arguments, in either mode', () => {
    const target = (mode: 'local' | 'docker'): PgTarget => ({
      mode,
      database: 'wedding',
      user: 'ana',
      container: 'wedmoments-db',
      env: { PGPASSWORD: 's3cret' },
    });
    for (const mode of ['local', 'docker'] as const) {
      const { command, args } = toolCommand(target(mode), 'pg_dump', ['--format=custom']);
      expect([command, ...args].join(' ')).not.toContain('s3cret');
    }
    expect(toolCommand(target('docker'), 'pg_dump', []).args).toEqual(['exec', '-i', 'wedmoments-db', 'pg_dump', '-U', 'ana']);
  });

  it('names another database on the same server', () => {
    expect(withDatabase('postgresql://u:p@h:5432/live?sslmode=require', 'copy')).toBe('postgresql://u:p@h:5432/copy?sslmode=require');
  });

  it('reads the tool’s major version', () => {
    expect(toolMajorVersion('pg_dump (PostgreSQL) 16.4')).toBe(16);
    expect(toolMajorVersion('nonsense')).toBeNull();
  });
});

describe('naming and keeping backups', () => {
  it('names a backup by its UTC time, sortable and safe on every filesystem', () => {
    expect(backupFileName(new Date('2026-10-17T12:30:05.123Z'))).toBe('wedmoments-2026-10-17T12-30-05Z.dump');
  });

  it('keeps the newest ones and leaves other files alone', () => {
    const names = [
      'wedmoments-2026-10-15T00-00-00Z.dump',
      'wedmoments-2026-10-17T00-00-00Z.dump',
      'wedmoments-2026-10-16T00-00-00Z.dump',
      'wedmoments-2026-10-16T00-00-00Z.dump.json',
      'notes.txt',
    ];
    expect(backupsToPrune(names, 2)).toEqual(['wedmoments-2026-10-15T00-00-00Z.dump']);
    expect(backupsToPrune(names, 0)).toEqual(['wedmoments-2026-10-16T00-00-00Z.dump', 'wedmoments-2026-10-15T00-00-00Z.dump']);
  });

  it('finds the newest backup in a folder', () => {
    const sub = fs.mkdtempSync(path.join(dir, 'newest-'));
    fs.writeFileSync(path.join(sub, 'wedmoments-2026-10-01T00-00-00Z.dump'), 'a');
    fs.writeFileSync(path.join(sub, 'wedmoments-2026-10-09T00-00-00Z.dump'), 'b');
    expect(newestBackup(sub)).toBe(path.join(sub, 'wedmoments-2026-10-09T00-00-00Z.dump'));
    expect(newestBackup(path.join(sub, 'missing'))).toBeNull();
  });
});

describe('checking a restore against its manifest', () => {
  it('reports every table that differs, or exists on one side only', () => {
    expect(compareCounts({ users: 3, photos: 10, events: 2 }, { users: 3, photos: 9, guests: 1 })).toEqual([
      { table: 'events', expected: 2, restored: null },
      { table: 'guests', expected: null, restored: 1 },
      { table: 'photos', expected: 10, restored: 9 },
    ]);
  });

  it('refuses a dump changed since it was written, before touching the database', async () => {
    const file = path.join(dir, 'wedmoments-2026-10-01T00-00-00Z.dump');
    fs.writeFileSync(file, 'original bytes');
    fs.writeFileSync(`${file}.json`, JSON.stringify({ sha256: sha256File(file), tables: {}, consistent: true }));
    fs.writeFileSync(file, 'damaged bytes');

    await expect(runRestoreCheck({ databaseUrl: 'postgresql://nobody@127.0.0.1:1/none', file })).rejects.toThrow(/checksum/);
  });

  it('needs the manifest the backup wrote', async () => {
    const file = path.join(dir, 'lonely.dump');
    fs.writeFileSync(file, 'x');
    await expect(runRestoreCheck({ databaseUrl: 'postgresql://nobody@127.0.0.1:1/none', file })).rejects.toThrow(/manifest/);
  });
});

// Runs wherever PostgreSQL's client tools or the database container can be
// reached: on a developer's machine, the container; on CI, the runner's tools.
//
// N-190 — CI sets REQUIRE_PG_TOOLS=1, so a runner without them fails here
// instead of skipping the round trip without a word: MASTER_AUDIT §3l says CI
// runs it on every change, and a silent skip would make that untrue.
describe('the round trip can run where it is required', () => {
  it.runIf(process.env.REQUIRE_PG_TOOLS === '1')('finds pg_dump and pg_restore', () => {
    expect(pgToolsReachable()).toBe(true);
  });
});

/**
 * A backup of the shared test database that no schema-changing spec can
 * interleave with; see tests/helpers/schemaChangeLock.ts.
 */
async function backupUnderLock(options: Parameters<typeof runBackup>[0]) {
  const release = await holdSchemaChangeLock();
  try {
    return await runBackup(options);
  } finally {
    await release();
  }
}

describe.runIf(pgToolsReachable())('the round trip against the real database', () => {
  it('backs up, restores into a throwaway database, and every table matches', async () => {
    const backup = await backupUnderLock({ databaseUrl: String(CONFIG.DATABASE_URL), dir, keep: 2 });

    expect(fs.existsSync(backup.file)).toBe(true);
    expect(backup.manifest.consistent).toBe(true);
    expect(backup.manifest.tables).toHaveProperty('events');
    expect(backup.manifest.sha256).toBe(sha256File(backup.file));

    const result = await runRestoreCheck({ databaseUrl: String(CONFIG.DATABASE_URL), file: backup.file });

    expect(result.scratchDatabase.startsWith(SCRATCH_PREFIX)).toBe(true);
    expect(result.mismatches).toEqual([]);
    expect(result.tables).toBe(Object.keys(backup.manifest.tables).length);
    const left = await query("SELECT 1 FROM pg_database WHERE datname = $1", [result.scratchDatabase]);
    expect(left.rows).toHaveLength(0);
  }, 120_000);
});

// A dump holds every guest's data: on a shared Linux host it must not be
// readable by other users. (Windows keeps no Unix permissions to check.)
describe.runIf(process.platform !== 'win32' && pgToolsReachable())('backup file permissions', () => {
  it('writes the folder, the dump and the manifest for their owner only', async () => {
    const sub = path.join(dir, 'private');
    const backup = await backupUnderLock({ databaseUrl: String(CONFIG.DATABASE_URL), dir: sub, keep: 1 });

    expect(fs.statSync(sub).mode & 0o077).toBe(0);
    expect(fs.statSync(backup.file).mode & 0o077).toBe(0);
    expect(fs.statSync(`${backup.file}.json`).mode & 0o077).toBe(0);
  }, 120_000);
});
