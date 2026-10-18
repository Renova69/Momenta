/**
 * Back up the database.
 *
 *   npm run db:backup
 *
 * Nothing backed anything up. The database is the only record of whose album
 * is whose and which file belongs to which photo; lose it and every wedding's
 * photos become an unlabelled heap, whatever survives in storage.
 *
 * Writes `wedmoments-<UTC time>.dump` (pg_dump's compressed custom format)
 * and a manifest beside it: the exact row count of every table, taken in the
 * same snapshot as the dump, and the dump's SHA-256. `npm run db:restore-check`
 * restores a dump into a throwaway database and compares it with the manifest.
 * The dump is checked to be readable before it is kept, and only the newest
 * BACKUP_KEEP (default 14) are kept.
 *
 * Settings, all optional: BACKUP_DIR (default ./backups), BACKUP_KEEP,
 * BACKUP_PG_TOOLS (auto | local | docker), BACKUP_PG_CONTAINER (default
 * wedmoments-db). Exits non-zero on any failure, for cron.
 *
 * A dump on the same disk as the database protects against mistakes — a bad
 * migration, a wrong delete — not against losing the disk. Copy the backup
 * folder somewhere else as well (docs/OPERATIONS.md, section 6).
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Client } from 'pg';
import { resolvePgTarget, runFromFile, runToFile } from './lib/pgTools';

export const BACKUP_PATTERN = /^wedmoments-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z\.dump$/;

export interface BackupManifest {
  createdAt: string;
  database: string;
  serverVersion: string;
  /** True when the counts and the dump come from one snapshot. */
  consistent: boolean;
  tables: Record<string, number>;
  latestMigration: string | null;
  bytes: number;
  sha256: string;
}

export interface BackupResult {
  file: string;
  manifest: BackupManifest;
  pruned: string[];
}

/** `wedmoments-2026-10-17T12-30-05Z.dump`: sortable by name, safe on every filesystem. */
export function backupFileName(now: Date): string {
  return `wedmoments-${now.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/:/g, '-')}.dump`;
}

/** Backups beyond the newest `keep`, oldest last. Names sort by time. */
export function backupsToPrune(names: string[], keep: number): string[] {
  return names
    .filter((n) => BACKUP_PATTERN.test(n))
    .sort()
    .reverse()
    .slice(Math.max(keep, 1));
}

export function sha256File(file: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** Exact row counts of every table in the public schema. */
export async function countRows(client: Client): Promise<Record<string, number>> {
  const { rows } = await client.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`
  );
  const counts: Record<string, number> = {};
  for (const { table_name: name } of rows) {
    const result = await client.query<{ n: string }>(`SELECT count(*)::bigint AS n FROM ${client.escapeIdentifier(name)}`);
    counts[name] = Number(result.rows[0].n);
  }
  return counts;
}

export async function runBackup(options: {
  databaseUrl: string;
  dir: string;
  keep: number;
  now?: Date;
  env?: NodeJS.ProcessEnv;
}): Promise<BackupResult> {
  const now = options.now ?? new Date();
  // Owner-only: a dump holds every guest's data. (Ignored on Windows, where
  // the folder's permissions come from its parent.)
  fs.mkdirSync(options.dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(options.dir, 0o700);
  const file = path.join(options.dir, backupFileName(now));
  const partial = `${file}.partial`;

  const client = new Client({ connectionString: options.databaseUrl });
  await client.connect();
  try {
    const version = await client.query<{ v: string; num: string }>(
      "SELECT current_setting('server_version') AS v, current_setting('server_version_num') AS num"
    );
    const serverMajor = Math.floor(Number(version.rows[0].num) / 10000);
    const target = resolvePgTarget(options.databaseUrl, serverMajor, options.env);

    // One snapshot for the counts and the dump, so the manifest describes
    // exactly what was dumped. A connection pooler in transaction mode cannot
    // export one; the backup then goes ahead and says its counts are approximate.
    let snapshot: string | null = null;
    await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      snapshot = (await client.query<{ id: string }>('SELECT pg_export_snapshot() AS id')).rows[0].id;
    } catch {
      await client.query('ROLLBACK');
      await client.query('BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
    }

    const tables = await countRows(client);
    const migrations = await client
      .query<{ filename: string }>('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1')
      .catch(() => ({ rows: [] as { filename: string }[] }));

    const args = ['--format=custom', '--no-owner', '--no-privileges'];
    if (snapshot) args.push(`--snapshot=${snapshot}`);
    if (target.mode === 'docker') args.push('-d', target.database);
    try {
      await runToFile(target, 'pg_dump', args, partial);
    } finally {
      await client.query('COMMIT').catch(() => undefined);
    }

    // Readable, and holding every table's data, before it counts as a backup.
    const toc = await runFromFile(target, 'pg_restore', ['--list'], partial);
    const missing = Object.keys(tables).filter((t) => !new RegExp(`TABLE DATA public ${t} `).test(toc));
    if (missing.length > 0) throw new Error(`The dump has no data for: ${missing.join(', ')}`);

    fs.renameSync(partial, file);
    const manifest: BackupManifest = {
      createdAt: now.toISOString(),
      database: target.database,
      serverVersion: version.rows[0].v,
      consistent: snapshot !== null,
      tables,
      latestMigration: migrations.rows[0]?.filename ?? null,
      bytes: fs.statSync(file).size,
      sha256: sha256File(file),
    };
    fs.writeFileSync(`${file}.json`, JSON.stringify(manifest, null, 2), { mode: 0o600 });

    const pruned = backupsToPrune(fs.readdirSync(options.dir), options.keep);
    for (const name of pruned) {
      fs.rmSync(path.join(options.dir, name), { force: true });
      fs.rmSync(path.join(options.dir, `${name}.json`), { force: true });
    }
    return { file, manifest, pruned };
  } catch (err) {
    fs.rmSync(partial, { force: true });
    throw err;
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function main(): Promise<void> {
  const { CONFIG } = await import('../server/lib/config');
  const dir = path.resolve(process.env.BACKUP_DIR || 'backups');
  // The rule the compose loop follows (N-177): a whole number of at least 1, else 14.
  const parsedKeep = Number.parseInt(process.env.BACKUP_KEEP || '14', 10);
  const keep = parsedKeep >= 1 ? parsedKeep : 14;
  const result = await runBackup({ databaseUrl: String(CONFIG.DATABASE_URL), dir, keep });
  const { manifest } = result;
  const rows = Object.values(manifest.tables).reduce((a, b) => a + b, 0);
  console.log(`[backup] ${result.file}`);
  console.log(
    `[backup] ${(manifest.bytes / 1024 / 1024).toFixed(1)} MB, ${Object.keys(manifest.tables).length} tables, ${rows} rows` +
      (manifest.consistent ? '' : ' (counts approximate: no snapshot through this connection)')
  );
  if (result.pruned.length > 0) console.log(`[backup] removed ${result.pruned.length} older backup(s)`);
}

// Only run as a CLI, so tests can import runBackup().
if (process.argv[1]?.includes('db-backup')) {
  main().catch((err) => {
    console.error('[backup] FAILED:', err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
