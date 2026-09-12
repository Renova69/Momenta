import { Pool, PoolClient } from 'pg';
import { pool } from './db';
import { CONFIG } from './config';
import { storageAdapter, toStoragePath, toAbsoluteUrl, isQuarantined } from './storage';
import { issuePreviewToken } from './previewToken';
import { errorLabel } from './errors';

/**
 * MED-03/SEC-M5 — promotion and host-preview helpers for quarantined photos.
 *
 * A photo pending moderation or still disposable-locked is saved with
 * `{ quarantine: true }` (`server/lib/storage.ts`) instead of the normal
 * public path, so the raw file is unreachable even if its URL is guessed.
 * These functions move it back to the public path once it is actually safe
 * to be public, and let the owning host preview it before then.
 */

export type PreviewVariant = 'display' | 'thumbnail' | 'original';

/** Signed URL a host can load directly in an `<img>` while a photo is quarantined. */
export function buildPreviewUrl(photoId: string, hostUserId: string, variant: PreviewVariant): string {
  const token = issuePreviewToken(photoId, hostUserId);
  return `${CONFIG.PUBLIC_BASE_URL}/api/photos/${photoId}/preview?variant=${variant}&token=${encodeURIComponent(token)}`;
}

/**
 * Move a single photo's quarantined copies (display/original/thumbnail) to
 * their public paths and update the row to match. A no-op for a photo whose
 * copies are already public — safe to call unconditionally.
 */
export async function promotePhotoFromQuarantine(
  photoId: string,
  db: Pool | PoolClient = pool
): Promise<void> {
  const { rows } = await db.query(
    'SELECT storage_path, original_storage_path, thumbnail_url FROM photos WHERE id = $1',
    [photoId]
  );
  if (rows.length === 0) return;
  const row = rows[0];
  const thumbPath = toStoragePath(row.thumbnail_url);

  if (!isQuarantined(row.storage_path) && !isQuarantined(row.original_storage_path) && !isQuarantined(thumbPath)) {
    return;
  }

  const [display, original, thumb] = await Promise.all([
    row.storage_path ? storageAdapter.promoteFromQuarantine(row.storage_path) : null,
    row.original_storage_path ? storageAdapter.promoteFromQuarantine(row.original_storage_path) : null,
    thumbPath ? storageAdapter.promoteFromQuarantine(thumbPath) : null,
  ]);

  await db.query(
    `UPDATE photos SET
       storage_path = COALESCE($2, storage_path),
       full_url = COALESCE($3, full_url),
       original_storage_path = COALESCE($4, original_storage_path),
       original_url = COALESCE($5, original_url),
       thumbnail_url = COALESCE($6, thumbnail_url),
       is_quarantined = false
     WHERE id = $1`,
    [
      photoId,
      display?.storagePath ?? null,
      display ? toAbsoluteUrl(display.storagePath) : null,
      original?.storagePath ?? null,
      original ? toAbsoluteUrl(original.storagePath) : null,
      thumb ? toAbsoluteUrl(thumb.storagePath) : null,
    ]
  );
}

/**
 * How many photos are promoted at once.
 *
 * Each promotion is a SELECT, up to three storage copy+delete round trips,
 * and an UPDATE. Unbounded, a reveal on a 300-photo album opened 900 storage
 * operations and as many pooled connections as it could take — against a pool
 * of 40 — so the whole API timed out. Four at a time still drains an album
 * quickly while leaving the pool to serve the guests who are refreshing.
 */
const PROMOTION_CONCURRENCY = 4;

/** Photos whose files are still in quarantine but are now safe to be public. */
const ELIGIBLE_SQL = `
  SELECT id FROM photos
   WHERE event_id = $1
     AND is_quarantined
     AND status IN ('approved', 'featured')
     AND (is_locked = false OR $2 = false)`;

/** Run `worker` over `items`, at most `limit` at a time, in order. */
async function mapWithConcurrency<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor++];
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * Promote every still-quarantined photo in an event that has just become
 * eligible for it — called from the read path (`GET /api/photos`) so a
 * disposable-mode reveal (a passive deadline, not a discrete action) still
 * results in promotion instead of guests getting a 404'd image forever.
 *
 * `disposableLocked` mirrors the same event-level flag `GET /api/photos`
 * already computes for guest visibility: when true, only photos that were
 * never locked qualify; when false (not disposable, or reveal has passed),
 * every approved/featured photo does.
 */
export async function promoteEligiblePhotos(eventId: string, disposableLocked: boolean): Promise<void> {
  // H4 — indexed (migration 021) instead of three leading-wildcard LIKEs that
  // no index could serve. This runs on every feed load by every guest, so the
  // common "nothing is quarantined" answer has to be nearly free; the partial
  // index makes it a single empty index scan, and this early return is the
  // path virtually every request takes.
  const { rows } = await pool.query(ELIGIBLE_SQL, [eventId, disposableLocked]);
  if (rows.length === 0) return;

  // A reveal deadline passing means every guest's next feed load matches the
  // same rows at the same instant. Left alone they all promote the same files
  // concurrently: wasted work at best, and at worst the loser of the race
  // finds the object already moved and throws.
  //
  // The lock is deliberately non-blocking. Waiting on it would be worse than
  // the problem it solves — each waiter would sit on a pooled connection
  // doing nothing, and a burst of guests would drain the pool exactly when
  // the promoting request needs connections of its own. Losing the race
  // simply means someone else is already doing this work, so there is nothing
  // useful to wait for: return, and let this request read the feed as it
  // stands. The very next load picks up whatever landed in the meantime.
  //
  // Session-level rather than transaction-scoped, because promotion does
  // network I/O to object storage — holding a transaction open across that
  // would park an idle-in-transaction connection for the length of an album.
  const client = await pool.connect();
  let held = false;
  try {
    const gate = await client.query<{ ok: boolean }>(
      'SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok',
      [`promote_${eventId}`]
    );
    if (!gate.rows[0]?.ok) return;
    held = true;

    // Re-read on the locked connection: between the first query and the lock,
    // another request may have promoted some or all of these already.
    const fresh = await client.query(ELIGIBLE_SQL, [eventId, disposableLocked]);

    await mapWithConcurrency(fresh.rows as { id: string }[], PROMOTION_CONCURRENCY, async (row) => {
      // Every statement runs on this one already-held connection rather than
      // taking more from the pool — node-pg queues them, so the concurrency
      // above overlaps the storage round trips (the slow part) without ever
      // needing a second connection. One album promotion costs exactly one.
      //
      // One photo failing must not abandon the rest of the album.
      await promotePhotoFromQuarantine(row.id, client).catch((err) => {
        console.warn(`[Quarantine] Could not promote photo ${row.id}:`, errorLabel(err));
      });
    });
  } finally {
    if (held) {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`promote_${eventId}`])
        .catch(() => undefined);
    }
    client.release();
  }
}
