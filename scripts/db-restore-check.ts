/**
 * Prove a backup can be restored.
 *
 *   npm run db:restore-check                     — the newest backup in BACKUP_DIR
 *   npm run db:restore-check -- <file.dump>      — a given one
 *   npm run db:restore-check -- <file> --keep    — leave the restored copy behind
 *
 * A backup nobody has restored is a hope, not a backup. This restores one into
 * a new, throwaway database on the same server — `wedmoments_restore_check_*`,
 * never the live one — and compares it with the manifest `npm run db:backup`
 * wrote beside it: the dump's checksum, then every table's row count. The
 * throwaway database is dropped afterwards unless `--keep` is given.
 *
 * Restoring over the live database is a different, deliberate act, written
 * out step by step in docs/OPERATIONS.md, section 6. Nothing here does it.
 */
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { resolvePgTarget, runFromFile, withDatabase } from './lib/pgTools';
import { BACKUP_PATTERN, countRows, sha256File, type BackupManifest } from './db-backup';

export const SCRATCH_PREFIX = 'wedmoments_restore_check_';

export interface RestoreCheckResult {
  scratchDatabase: string;
  kept: boolean;
  tables: number;
  rows: number;
  /** Tables whose restored count differs from the manifest. */
  mismatches: { table: string; expected: number | null; restored: number | null }[];
  manifestConsistent: boolean;
}

/** The newest backup in a folder, or null. */
export function newestBackup(dir: string): string | null {
  if (!fs.existsSync(dir)) return null;
  const names = fs.readdirSync(dir).filter((n) => BACKUP_PATTERN.test(n)).sort();
  return names.length > 0 ? path.join(dir, names[names.length - 1]) : null;
}

/** Every table whose count differs, in either direction, or exists on one side only. */
export function compareCounts(
  expected: Record<string, number>,
  restored: Record<string, number>
): RestoreCheckResult['mismatches'] {
  const names = [...new Set([...Object.keys(expected), ...Object.keys(restored)])].sort();
  return names
    .filter((t) => expected[t] !== restored[t])
    .map((t) => ({ table: t, expected: expected[t] ?? null, restored: restored[t] ?? null }));
}

export async function runRestoreCheck(options: {
  databaseUrl: string;
  file: string;
  keep?: boolean;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<RestoreCheckResult> {
  const manifestFile = `${options.file}.json`;
  if (!fs.existsSync(manifestFile)) throw new Error(`No manifest beside the dump: ${manifestFile}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')) as BackupManifest;
  if (sha256File(options.file) !== manifest.sha256) {
    throw new Error('The dump does not match its manifest checksum: it was changed or damaged after it was written.');
  }

  const scratch = `${SCRATCH_PREFIX}${(options.now ?? new Date()).toISOString().replace(/\D/g, '').slice(0, 14)}`;
  const admin = new Client({ connectionString: options.databaseUrl });
  await admin.connect();
  let created = false;
  try {
    const live = (await admin.query<{ db: string }>('SELECT current_database() AS db')).rows[0].db;
    if (scratch === live || !scratch.startsWith(SCRATCH_PREFIX)) throw new Error('Refusing to restore into the live database.');
    const num = (await admin.query<{ num: string }>("SELECT current_setting('server_version_num') AS num")).rows[0].num;
    const target = resolvePgTarget(options.databaseUrl, Math.floor(Number(num) / 10000), options.env);

    await admin.query(`CREATE DATABASE ${admin.escapeIdentifier(scratch)}`);
    created = true;
    await runFromFile(
      target,
      'pg_restore',
      ['--no-owner', '--no-privileges', '--exit-on-error', '-d', scratch],
      options.file
    );

    const restoredClient = new Client({ connectionString: withDatabase(options.databaseUrl, scratch) });
    await restoredClient.connect();
    let restored: Record<string, number>;
    try {
      restored = await countRows(restoredClient);
    } finally {
      await restoredClient.end().catch(() => undefined);
    }

    return {
      scratchDatabase: scratch,
      kept: !!options.keep,
      tables: Object.keys(restored).length,
      rows: Object.values(restored).reduce((a, b) => a + b, 0),
      mismatches: compareCounts(manifest.tables, restored),
      manifestConsistent: manifest.consistent,
    };
  } finally {
    if (created && !options.keep) {
      await admin.query(`DROP DATABASE IF EXISTS ${admin.escapeIdentifier(scratch)} WITH (FORCE)`).catch((err) => {
        console.warn(`[restore-check] could not drop ${scratch}:`, err instanceof Error ? err.message : String(err));
      });
    }
    await admin.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const { CONFIG } = await import('../server/lib/config');
  const args = process.argv.slice(2);
  const keep = args.includes('--keep');
  const given = args.find((a) => !a.startsWith('--'));
  const file = given ? path.resolve(given) : newestBackup(path.resolve(process.env.BACKUP_DIR || 'backups'));
  if (!file) throw new Error('No backup to check. Run npm run db:backup first, or name a .dump file.');

  const result = await runRestoreCheck({ databaseUrl: String(CONFIG.DATABASE_URL), file, keep });
  console.log(`[restore-check] ${path.basename(file)} restored into ${result.scratchDatabase}${result.kept ? ' (kept)' : ' (dropped)'}`);
  console.log(`[restore-check] ${result.tables} tables, ${result.rows} rows`);
  if (result.mismatches.length === 0) {
    console.log('[restore-check] every table matches the manifest');
    return;
  }
  for (const m of result.mismatches) {
    console.log(`[restore-check]   ${m.table}: manifest ${m.expected ?? 'absent'}, restored ${m.restored ?? 'absent'}`);
  }
  if (result.manifestConsistent) throw new Error(`${result.mismatches.length} table(s) differ from the manifest`);
  console.log('[restore-check] the manifest counts were approximate (no snapshot), so differences are reported, not failed');
}

// Only run as a CLI, so tests can import runRestoreCheck().
if (process.argv[1]?.includes('db-restore-check')) {
  main().catch((err) => {
    console.error('[restore-check] FAILED:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
