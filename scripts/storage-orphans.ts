/**
 * Find and optionally remove stored objects no database row references.
 *
 *   npm run storage:orphans          # report only
 *   npm run storage:orphans -- --delete
 *
 * Media lives under `events/<eventId>/` (and `quarantine/events/<eventId>/`),
 * but nothing in Postgres can reach out and delete a file. Deleting an event
 * row therefore cascades the photo and audio rows while leaving their bytes
 * behind forever — this repository's most-repeated bug, found four separate
 * times, most recently in its own R2 integration suite.
 *
 * **Both storage providers.** This walked local disk only and printed a notice
 * under `STORAGE_PROVIDER=r2`, which is the provider production runs — so the
 * one safety net for unreferenced bytes did not function where it was needed.
 * The R2 path below closes that.
 *
 * Reports by default. Deleting is opt-in, because these are photographs.
 *
 * ---
 *
 * Three things make deletion safe, and all three matter more than the feature:
 *
 * 1. **A key that cannot be parsed is never an orphan.** Anything that does not
 *    match a recognised event-scoped layout is counted as unknown and left
 *    alone. The cost of keeping a stray object is a few cents; the cost of the
 *    opposite mistake is a wedding.
 *
 * 2. **A partial listing is never treated as complete.** R2 pages results, and
 *    a listing that stopped early would make every object on the pages never
 *    read look unreferenced. Any failure mid-pagination aborts the whole run
 *    rather than reporting what it managed to collect.
 *
 * 3. **An empty event table aborts.** If the database returns no events at all
 *    while the bucket holds objects, the likeliest explanation is that this is
 *    pointed at the wrong database — not that every wedding was deleted. That
 *    reading would delete the entire bucket, so it refuses instead.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { S3Client, ListObjectsV2Command, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { pool } from '../server/lib/db';
import { CONFIG } from '../server/lib/config';
import { formatBytes } from '../server/lib/planLimits';

/**
 * The event id an object key belongs to, or null when the key is not in a
 * layout this understands.
 *
 * Returning null is the safe answer and the common one for anything the app
 * did not write. Both live layouts are recognised:
 *
 *   events/<uuid>/wedding-photo-...jpg
 *   quarantine/events/<uuid>/wedding-photo-...jpg
 */
export function eventIdFromKey(key: string): string | null {
  const match = key.match(/^(?:quarantine\/)?events\/([^/]+)\/.+/);
  if (!match) return null;
  const id = match[1];
  // A directory marker (`events/<id>/`) has no object after it and is not a
  // file to reclaim.
  return id.length > 0 ? id : null;
}

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

interface BucketObject {
  key: string;
  bytes: number;
}

/**
 * Every object in the bucket.
 *
 * Exhaustive or nothing: a truncated listing reported as complete would mark
 * live photos as orphaned, and with `--delete` that is unrecoverable. A failure
 * on any page throws rather than returning what it has.
 */
async function listAllObjects(s3: S3Client): Promise<BucketObject[]> {
  const objects: BucketObject[] = [];
  let token: string | undefined;
  let pages = 0;

  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: CONFIG.R2_BUCKET_NAME, ContinuationToken: token })
    );
    for (const item of page.Contents ?? []) {
      if (item.Key) objects.push({ key: item.Key, bytes: item.Size ?? 0 });
    }
    // IsTruncated with no token would silently end the loop one page short.
    if (page.IsTruncated && !page.NextContinuationToken) {
      throw new Error('R2 reported more results but returned no continuation token — refusing a partial listing.');
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
    pages += 1;
  } while (token);

  console.log(`[orphans] Listed ${objects.length} object(s) across ${pages} page(s).`);
  return objects;
}

async function scanR2(): Promise<void> {
  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${CONFIG.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: CONFIG.R2_ACCESS_KEY_ID,
      secretAccessKey: CONFIG.R2_SECRET_ACCESS_KEY,
    },
  });

  const objects = await listAllObjects(s3);
  const { rows } = await pool.query<{ id: string }>('SELECT id::text AS id FROM events');
  const known = new Set(rows.map((r) => r.id));

  // Safety 3: no events but objects present reads as a misconfigured database,
  // not as a bucket full of orphans.
  if (known.size === 0 && objects.length > 0) {
    console.error(
      `[orphans] The events table is empty while the bucket holds ${objects.length} object(s).\n` +
        '[orphans] That is far more likely to be the wrong DATABASE_URL than a bucket of orphans,\n' +
        '[orphans] and acting on it would delete everything. Refusing.'
    );
    process.exitCode = 1;
    return;
  }

  const byEvent = new Map<string, { files: number; bytes: number; keys: string[] }>();
  let unparseable = 0;
  let unparseableBytes = 0;
  let live = 0;

  for (const object of objects) {
    const eventId = eventIdFromKey(object.key);
    if (!eventId) {
      // Safety 1: not a layout we understand, so not ours to delete.
      unparseable += 1;
      unparseableBytes += object.bytes;
      continue;
    }
    if (known.has(eventId)) {
      live += 1;
      continue;
    }
    const entry = byEvent.get(eventId) ?? { files: 0, bytes: 0, keys: [] };
    entry.files += 1;
    entry.bytes += object.bytes;
    entry.keys.push(object.key);
    byEvent.set(eventId, entry);
  }

  const totalBytes = [...byEvent.values()].reduce((sum, e) => sum + e.bytes, 0);
  const totalFiles = [...byEvent.values()].reduce((sum, e) => sum + e.files, 0);

  console.log(
    `[orphans] ${known.size} event(s) in the database; ${live} object(s) belong to one.`
  );
  console.log(
    `[orphans] ${byEvent.size} orphaned prefix(es), ${totalFiles} object(s), ${formatBytes(totalBytes)}.`
  );
  if (unparseable > 0) {
    console.log(
      `[orphans] ${unparseable} object(s) (${formatBytes(unparseableBytes)}) are not in an event-scoped\n` +
        '[orphans] layout and were left alone — an unrecognised key is never treated as an orphan.'
    );
  }

  for (const [eventId, entry] of [...byEvent.entries()].slice(0, 10)) {
    console.log(`    ${eventId}  ${String(entry.files).padStart(5)} objects  ${formatBytes(entry.bytes)}`);
  }
  if (byEvent.size > 10) console.log(`    ... and ${byEvent.size - 10} more`);

  if (!shouldDelete) {
    if (byEvent.size > 0) console.log('\n[orphans] REPORT ONLY. Re-run with --delete to remove them.');
    return;
  }

  let removed = 0;
  let failed = 0;
  for (const entry of byEvent.values()) {
    for (const key of entry.keys) {
      try {
        await s3.send(new DeleteObjectCommand({ Bucket: CONFIG.R2_BUCKET_NAME, Key: key }));
        removed += 1;
      } catch (err) {
        failed += 1;
        console.warn(`[orphans] could not remove ${key}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  console.log(`\n[orphans] Removed ${removed} object(s), reclaiming ${formatBytes(totalBytes)}.`);
  if (failed > 0) console.log(`[orphans] ${failed} object(s) could not be removed and remain.`);
}

async function main() {
  if (CONFIG.STORAGE_PROVIDER === 'r2') {
    await scanR2();
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

/**
 * Run only when invoked as a script, not when imported.
 *
 * `eventIdFromKey` is exported so it can be tested directly — it is the
 * function that decides what `--delete` removes from a live bucket, so it
 * needs tests more than anything else here. Without this guard, importing it
 * starts main(): a test run would scan storage and, worse, call pool.end() and
 * close the connection pool out from under every other spec sharing the
 * worker. It survived only by finishing before that landed, which is a race,
 * not a design.
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch(async (err) => {
    console.error('[orphans] failed:', err);
    await pool.end().catch(() => undefined);
    process.exit(1);
  });
}
