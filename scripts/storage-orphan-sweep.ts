/**
 * Reclaims stored media that no event points at any more.
 *
 *   npm run storage:orphan-report                    list what is orphaned
 *   npm run storage:orphan-sweep                     delete it
 *
 * Deleting an event row does not delete its photos. Nothing cascades from
 * Postgres into a filesystem or an object store, so a row removed by anything
 * other than the retention purge — a spec's own cleanup, a manual DELETE, a
 * purge that failed halfway — strands its media permanently: once the row is
 * gone there is no path left to look the files up by. On this machine that had
 * accumulated 4,260 objects (200 MB) in R2 and roughly 4,000 directories on
 * local disk.
 *
 * Sweeps BOTH local disk and R2 when credentials exist, rather than only the
 * currently configured provider: media outlives a STORAGE_PROVIDER switch, and
 * files written before such a change are exactly the ones nothing else will
 * ever revisit.
 *
 * ---------------------------------------------------------------------------
 * SAFETY — read before changing anything here
 *
 * "Delete storage with no matching database row" is one bad query away from
 * deleting every wedding photo in the system, and there is no undo. Hence:
 *
 *   1. Dry run unless SWEEP_CONFIRM=true. Reporting is always the default.
 *   2. Refuses to run when the events table is empty or unreadable — precisely
 *      the state in which a naive sweep deletes everything.
 *   3. Ignores anything younger than MIN_AGE_MINUTES (default 60). An upload in
 *      flight has written its file before it has committed its row; without
 *      that window the sweep races live traffic and deletes real photos.
 *   4. Only considers paths of the exact shape `events/<uuid>/...`. Anything
 *      else in the bucket or the directory is left alone.
 * ---------------------------------------------------------------------------
 */
import fs from 'fs';
import path from 'path';
import { S3Client, ListObjectsV2Command, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { CONFIG } from '../server/lib/config';
import { pool } from '../server/lib/db';
import { errorLabel } from '../server/lib/errors';

const CONFIRMED = process.env.SWEEP_CONFIRM === 'true';
const MIN_AGE_MS = parseInt(process.env.MIN_AGE_MINUTES || '60', 10) * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The event id an R2 object key belongs to, or null when the key is not one
 * this app wrote.
 *
 * Exported so the prefix handling can be tested without a bucket — getting it
 * wrong is silent in exactly the direction that matters: objects the sweep
 * cannot see are never reported and never cleaned, and nothing anywhere says
 * so.
 */
export function eventIdFromR2Key(key: string): string | null {
  const parts = String(key).split('/');
  const id = parts[0] === 'quarantine' ? parts[2] : parts[1];
  if (parts[0] !== 'quarantine' && parts[0] !== 'events') return null;
  if (parts[0] === 'quarantine' && parts[1] !== 'events') return null;
  return id && UUID_RE.test(id) ? id : null;
}

interface Tally {
  entries: number;
  bytes: number;
  skippedYoung: number;
}

const emptyTally = (): Tally => ({ entries: 0, bytes: 0, skippedYoung: 0 });
const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function loadLiveEventIds(): Promise<Set<string>> {
  const { rows } = await pool.query<{ id: string }>('SELECT id FROM events');
  if (rows.length === 0) {
    // Guard 2. An empty result is indistinguishable from "every event was
    // deleted", and acting on it would remove all media in a single pass.
    throw new Error(
      'The events table is empty. Refusing to sweep: with no live events every stored file looks ' +
        'orphaned, and this would delete all of them. Point at the right database, or clean up by hand.'
    );
  }
  return new Set(rows.map((row) => String(row.id)));
}

function directorySize(dir: string): number {
  let total = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    total += entry.isDirectory() ? directorySize(full) : fs.statSync(full).size;
  }
  return total;
}

function sweepLocalRoot(root: string, live: Set<string>, label: string): Tally {
  const tally = emptyTally();
  const eventsDir = path.join(root, 'events');
  if (!fs.existsSync(eventsDir)) return tally;

  for (const entry of fs.readdirSync(eventsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue; // Guard 4
    if (live.has(entry.name)) continue;

    const dir = path.join(eventsDir, entry.name);
    if (Date.now() - fs.statSync(dir).mtimeMs < MIN_AGE_MS) {
      tally.skippedYoung += 1; // Guard 3
      continue;
    }

    tally.entries += 1;
    tally.bytes += directorySize(dir);
    if (CONFIRMED) fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(
    `  ${label.padEnd(22)} ${tally.entries} orphaned event dir(s), ${mb(tally.bytes)}` +
      (tally.skippedYoung > 0 ? `  (${tally.skippedYoung} too recent to touch)` : '')
  );
  return tally;
}

async function sweepR2(live: Set<string>): Promise<Tally> {
  const tally = emptyTally();
  if (!CONFIG.R2_ACCOUNT_ID || !CONFIG.R2_ACCESS_KEY_ID || !CONFIG.R2_SECRET_ACCESS_KEY) {
    console.log('  R2                     (no credentials configured — skipped)');
    return tally;
  }

  const s3 = new S3Client({
    region: 'auto',
    endpoint: `https://${CONFIG.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId: CONFIG.R2_ACCESS_KEY_ID, secretAccessKey: CONFIG.R2_SECRET_ACCESS_KEY },
  });

  // Both roots that storage.ts writes to, not just the public one.
  //
  // This scanned `Prefix: 'events/'` alone, so every object under
  // `quarantine/events/...` was invisible to it — permanently. A photo saved
  // while pending moderation or disposable-locked (MED-03/SEC-M5) lives there
  // until it is promoted, and if its event is deleted before that happens the
  // objects are orphaned somewhere nothing would ever look. On this bucket
  // that was 446 objects the sweep could not see, against 12 it could.
  //
  // The local disk sweep above already walks both roots, which is what makes
  // this an oversight in the R2 path rather than a deliberate exclusion.
  const PREFIXES = [
    { prefix: 'events/', idIndex: 1 },
    { prefix: 'quarantine/events/', idIndex: 2 },
  ];

  const doomed: string[] = [];
  for (const { prefix, idIndex } of PREFIXES) {
    let token: string | undefined;
    do {
      const page = await s3.send(
        new ListObjectsV2Command({
          Bucket: CONFIG.R2_BUCKET_NAME,
          Prefix: prefix,
          ContinuationToken: token,
          MaxKeys: 1000,
        })
      );
      for (const object of page.Contents ?? []) {
        const key = String(object.Key);
        const eventId = key.split('/')[idIndex] ?? '';
        if (!UUID_RE.test(eventId)) continue; // Guard 4
        if (live.has(eventId)) continue;
        if (object.LastModified && Date.now() - object.LastModified.getTime() < MIN_AGE_MS) {
          tally.skippedYoung += 1; // Guard 3
          continue;
        }
        doomed.push(key);
        tally.entries += 1;
        tally.bytes += object.Size ?? 0;
      }
      token = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (token);
  }

  console.log(
    `  ${`R2 (${CONFIG.R2_BUCKET_NAME})`.padEnd(22)} ${tally.entries} orphaned object(s), ${mb(tally.bytes)}` +
      (tally.skippedYoung > 0 ? `  (${tally.skippedYoung} too recent to touch)` : '')
  );

  if (CONFIRMED && doomed.length > 0) {
    // DeleteObjects accepts at most 1000 keys per call.
    for (let i = 0; i < doomed.length; i += 1000) {
      const batch = doomed.slice(i, i + 1000);
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: CONFIG.R2_BUCKET_NAME,
          Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
        })
      );
      console.log(`    deleted ${Math.min(i + 1000, doomed.length)}/${doomed.length}`);
    }
  }

  return tally;
}

async function main(): Promise<void> {
  const live = await loadLiveEventIds();

  console.log('');
  console.log(`Storage orphan sweep — ${live.size} live event(s) in the database`);
  console.log(
    CONFIRMED
      ? `Mode: DELETING (ignoring anything newer than ${MIN_AGE_MS / 60000} minutes)`
      : `Mode: report only — set SWEEP_CONFIRM=true to delete. Ignoring anything newer than ${MIN_AGE_MS / 60000} minutes.`
  );
  console.log('');

  const tallies = [
    sweepLocalRoot(CONFIG.UPLOADS_DIR, live, 'local uploads'),
    sweepLocalRoot(CONFIG.QUARANTINE_DIR, live, 'local quarantine'),
    await sweepR2(live),
  ];

  const entries = tallies.reduce((sum, t) => sum + t.entries, 0);
  const bytes = tallies.reduce((sum, t) => sum + t.bytes, 0);
  console.log('');
  console.log(`${CONFIRMED ? 'Reclaimed' : 'Would reclaim'} ${mb(bytes)} across ${entries} orphaned entries.`);
  console.log('');
}

main()
  .catch((err) => {
    console.error('[storage-orphan-sweep] failed:', errorLabel(err));
    process.exitCode = 1;
  })
  .finally(() => pool.end());
