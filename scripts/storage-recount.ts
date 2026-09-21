/**
 * Rebuild storage accounting from what is actually stored.
 *
 *   npm run storage:recount
 *
 * Photos created before migration 007 have no recorded byte size, so their
 * event totals under-report. This measures each stored object and rewrites
 * `photos.storage_bytes`, `audio_guestbook.storage_bytes` and the per-event
 * running totals.
 *
 * Read-only against storage; it never deletes anything.
 */
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../server/lib/db';
import { storageAdapter, toStoragePath } from '../server/lib/storage';
import { formatBytes } from '../server/lib/planLimits';
import { errorLabel } from '../server/lib/errors';

export async function sizeOf(storagePath: string | null): Promise<number> {
  if (!storagePath) return 0;

  // A file that cannot be opened is not a file of zero bytes either: the
  // caller skips the row rather than writing a smaller number over a correct
  // one.
  const stream = await storageAdapter.getStream(storagePath);
  if (!stream) return 0;

  return new Promise<number>((resolve, reject) => {
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
    });
    stream.on('end', () => resolve(total));
    // A failed read is not "this file is empty". Resolving 0 let a transient
    // storage error undercount a photo whose other copies read fine, and the
    // recount then wrote that smaller number over a correct one — accounting
    // drifting downwards, with nothing to notice it but another full recount.
    stream.on('error', reject);
  });
}

export async function main() {
  const { rows: photos } = await pool.query(
    'SELECT id, storage_path, original_storage_path, thumbnail_url, storage_bytes FROM photos ORDER BY created_at ASC'
  );
  console.log(`[recount] measuring ${photos.length} photo(s)...`);

  let updatedPhotos = 0;
  let skippedPhotos = 0;
  for (const photo of photos) {
    // DB-14: the display copy and original were measured, but not the
    // thumbnail - every photo has one, so every recount silently undercounted
    // by that amount and could shrink storage_bytes below the true footprint.
    let measured: number;
    try {
      measured =
        (await sizeOf(photo.storage_path)) +
        (await sizeOf(photo.original_storage_path)) +
        (await sizeOf(toStoragePath(photo.thumbnail_url)));
    } catch (err) {
      // Skip the row rather than write a number this run cannot stand behind.
      skippedPhotos += 1;
      console.warn(`[recount] could not measure photo ${photo.id}, leaving it alone:`, errorLabel(err));
      continue;
    }
    if (measured > 0 && measured !== Number(photo.storage_bytes)) {
      await pool.query('UPDATE photos SET storage_bytes = $1 WHERE id = $2', [measured, photo.id]);
      updatedPhotos += 1;
    }
  }

  const { rows: audio } = await pool.query('SELECT id, audio_url, storage_bytes FROM audio_guestbook');
  console.log(`[recount] measuring ${audio.length} audio entr(ies)...`);

  let updatedAudio = 0;
  let skippedAudio = 0;
  for (const entry of audio) {
    const url = entry.audio_url as string;
    const path = url && url.includes('/uploads/') ? url.substring(url.indexOf('/uploads/')) : url;
    let measured: number;
    try {
      measured = await sizeOf(path);
    } catch (err) {
      skippedAudio += 1;
      console.warn(`[recount] could not measure audio ${entry.id}, leaving it alone:`, errorLabel(err));
      continue;
    }
    if (measured > 0 && measured !== Number(entry.storage_bytes)) {
      await pool.query('UPDATE audio_guestbook SET storage_bytes = $1 WHERE id = $2', [measured, entry.id]);
      updatedAudio += 1;
    }
  }

  // Re-seed the per-event totals from the corrected rows.
  await pool.query(`
    UPDATE events e
       SET storage_bytes = COALESCE(p.total, 0) + COALESCE(a.total, 0)
      FROM (SELECT id FROM events) src
      LEFT JOIN (SELECT event_id, SUM(storage_bytes) AS total FROM photos GROUP BY event_id) p
             ON p.event_id = src.id
      LEFT JOIN (SELECT event_id, SUM(storage_bytes) AS total FROM audio_guestbook GROUP BY event_id) a
             ON a.event_id = src.id
     WHERE e.id = src.id
  `);

  const { rows: totals } = await pool.query(
    'SELECT COUNT(*)::int AS events, COALESCE(SUM(storage_bytes), 0)::bigint AS total FROM events'
  );

  console.log(
    `[recount] updated ${updatedPhotos} photo row(s) and ${updatedAudio} audio row(s).\n` +
      `[recount] ${totals[0].events} event(s) now account for ${formatBytes(Number(totals[0].total))}.`
  );

  if (skippedPhotos > 0 || skippedAudio > 0) {
    // Said plainly, because the totals above are then not a full recount: the
    // skipped rows kept whatever number they already had.
    console.warn(
      `[recount] could not measure ${skippedPhotos} photo row(s) and ${skippedAudio} audio row(s); ` +
        'they keep their previous size. Run this again once storage is reachable.'
    );
  }

  await pool.end();
}

// Only when run as a command. A test that imports `sizeOf` must not open a
// database pool and rewrite every row in it as a side effect of the import.
const invokedDirectly =
  process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main().catch(async (err) => {
    console.error('[recount] failed:', err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
}
