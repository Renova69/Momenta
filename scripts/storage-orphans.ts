/**
 * Find and optionally remove stored files no database row references.
 *
 *   npm run storage:orphans          # report only
 *   npm run storage:orphans -- --delete
 *
 * Media is stored under `uploads/events/<eventId>/`, but nothing in Postgres can
 * reach out and delete a file. Deleting an event row therefore cascades the
 * photo and audio rows while leaving their bytes behind forever.
 *
 * Today no route deletes an event — the retention sweep purges storage first,
 * on purpose — so this mostly cleans up after test runs and manual database
 * work. It exists as a safety net for the day an event-delete feature is added:
 * whoever writes it must purge storage first, and this will show if they didn't.
 *
 * Reports by default. Deleting is opt-in, because these are photographs.
 */
import fs from 'fs';
import path from 'path';
import { pool } from '../server/lib/db';
import { CONFIG } from '../server/lib/config';
import { formatBytes } from '../server/lib/planLimits';

const shouldDelete = process.argv.includes('--delete');

interface OrphanDir {
  eventId: string;
  dir: string;
  files: number;
  bytes: number;
}

function directorySize(dir: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = directorySize(full);
      files += nested.files;
      bytes += nested.bytes;
    } else {
      files += 1;
      bytes += fs.statSync(full).size;
    }
  }
  return { files, bytes };
}

async function main() {
  if (CONFIG.STORAGE_PROVIDER === 'r2') {
    console.log(
      '[orphans] STORAGE_PROVIDER=r2 — this script only walks local disk.\n' +
        '[orphans] For R2, list the bucket by `events/` prefix and compare against\n' +
        '[orphans] SELECT id FROM events, or set a lifecycle rule.'
    );
    await pool.end();
    return;
  }

  const eventsRoot = path.join(CONFIG.UPLOADS_DIR, 'events');
  if (!fs.existsSync(eventsRoot)) {
    console.log(`[orphans] Nothing to scan: ${eventsRoot} does not exist.`);
    await pool.end();
    return;
  }

  const onDisk = fs
    .readdirSync(eventsRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name);

  const { rows } = await pool.query<{ id: string }>('SELECT id FROM events');
  const known = new Set(rows.map((r) => r.id));

  const orphans: OrphanDir[] = [];
  for (const eventId of onDisk) {
    if (known.has(eventId)) continue;
    const dir = path.join(eventsRoot, eventId);
    const { files, bytes } = directorySize(dir);
    orphans.push({ eventId, dir, files, bytes });
  }

  const totalBytes = orphans.reduce((sum, o) => sum + o.bytes, 0);
  const totalFiles = orphans.reduce((sum, o) => sum + o.files, 0);

  console.log(`[orphans] ${onDisk.length} event folder(s) on disk, ${known.size} event(s) in the database.`);
  console.log(
    `[orphans] ${orphans.length} orphaned folder(s), ${totalFiles} file(s), ${formatBytes(totalBytes)}.`
  );

  for (const orphan of orphans.slice(0, 10)) {
    console.log(`    ${orphan.eventId}  ${String(orphan.files).padStart(5)} files  ${formatBytes(orphan.bytes)}`);
  }
  if (orphans.length > 10) console.log(`    ... and ${orphans.length - 10} more`);

  if (!shouldDelete) {
    if (orphans.length > 0) {
      console.log('\n[orphans] REPORT ONLY. Re-run with --delete to remove them.');
    }
    await pool.end();
    return;
  }

  let removed = 0;
  for (const orphan of orphans) {
    try {
      fs.rmSync(orphan.dir, { recursive: true, force: true });
      removed += 1;
    } catch (err) {
      console.warn(`[orphans] could not remove ${orphan.dir}:`, err instanceof Error ? err.message : err);
    }
  }

  console.log(`\n[orphans] Removed ${removed} folder(s), reclaiming ${formatBytes(totalBytes)}.`);
  await pool.end();
}

main().catch(async (err) => {
  console.error('[orphans] failed:', err);
  await pool.end().catch(() => undefined);
  process.exit(1);
});
