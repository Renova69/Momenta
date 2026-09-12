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
import { pool } from '../server/lib/db';
import { storageAdapter, toStoragePath } from '../server/lib/storage';
import { formatBytes } from '../server/lib/planLimits';

async function sizeOf(storagePath: string | null): Promise<number> {
  if (!storagePath) return 0;

  const stream = await storageAdapter.getStream(storagePath).catch(() => null);
  if (!stream) return 0;

  return new Promise<number>((resolve) => {
    let total = 0;
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
    });
    stream.on('end', () => resolve(total));
    stream.on('error', () => resolve(0));
  });
}

async function main() {
  const { rows: photos } = await pool.query(
    'SELECT id, storage_path, original_storage_path, thumbnail_url, storage_bytes FROM photos ORDER BY created_at ASC'
  );
  console.log(`[recount] measuring ${photos.length} photo(s)...`);

  let updatedPhotos = 0;
  for (const photo of photos) {
    // DB-14: the display copy and original were measured, but not the
    // thumbnail - every photo has one, so every recount silently undercounted
    // by that amount and could shrink storage_bytes below the true footprint.
    const measured =
      (await sizeOf(photo.storage_path)) +
      (await sizeOf(photo.original_storage_path)) +
      (await sizeOf(toStoragePath(photo.thumbnail_url)));
    if (measured > 0 && measured !== Number(photo.storage_bytes)) {
      await pool.query('UPDATE photos SET storage_bytes = $1 WHERE id = $2', [measured, photo.id]);
      updatedPhotos += 1;
    }
  }

  const { rows: audio } = await pool.query('SELECT id, audio_url, storage_bytes FROM audio_guestbook');
  console.log(`[recount] measuring ${audio.length} audio entr(ies)...`);

  let updatedAudio = 0;
  for (const entry of audio) {
    const url = entry.audio_url as string;
    const path = url && url.includes('/uploads/') ? url.substring(url.indexOf('/uploads/')) : url;
    const measured = await sizeOf(path);
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

  await pool.end();
}

main().catch(async (err) => {
  console.error('[recount] failed:', err);
  await pool.end().catch(() => {});
  process.exit(1);
});
