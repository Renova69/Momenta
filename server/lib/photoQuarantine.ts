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

type MovedFile = { publicUrl: string; storagePath: string };

/** The statuses under which a photo's files belong on the public path. */
const PUBLIC_STATUSES = ['approved', 'featured'];

/**
 * Run one move of a photo's files under a lock held for that photo alone.
 *
 * N-71 — an approval's promotion and a rejection's withhold each read the
 * row once, at the start, and never coordinated. A rejection made while the
 * promotion was still moving files saw "still quarantined" and did nothing,
 * and the promotion then made the rejected photo public. Under the lock each
 * move reads the status as it stands, after any move already under way has
 * written its row.
 *
 * Session-level, on a connection of its own, because the moves are storage
 * I/O that a transaction should not be held open across. A connection whose
 * unlock fails is closed rather than returned to the pool, so it cannot take
 * the lock back into the pool with it.
 */
export async function withPhotoMoveLock(
  db: Pool | PoolClient,
  photoId: string,
  move: (client: PoolClient) => Promise<void>
): Promise<void> {
  const ownConnection = db instanceof Pool;
  const client = ownConnection ? await db.connect() : db;
  const key = `photo_move_${photoId}`;
  let unlocked = true;
  try {
    await client.query('SELECT pg_advisory_lock(hashtextextended($1, 0))', [key]);
    unlocked = false;
    try {
      await move(client);
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [key])
        .then(() => {
          unlocked = true;
        })
        .catch(() => undefined);
    }
  } finally {
    if (ownConnection) client.release(!unlocked);
  }
}

interface PhotoFiles {
  storage_path: string | null;
  original_storage_path: string | null;
  thumbnail_url: string | null;
}

/**
 * Move a photo's three copies, and record in its row every move that landed.
 *
 * N-70 — the row used to be written only if all three moves succeeded. One
 * failed move left the row naming a file that had already moved, and every
 * retry then failed on that missing source, for good. Now the row always
 * names where each file is, `is_quarantined` changes only once all three
 * have moved, and a failure is raised after the row is written, so the
 * caller logs it and the next attempt moves only what is left.
 */
async function moveCopies(
  db: Pool | PoolClient,
  photoId: string,
  row: PhotoFiles,
  move: (storagePath: string) => Promise<MovedFile>,
  toUrl: (moved: MovedFile) => string,
  quarantined: boolean
): Promise<void> {
  const thumbPath = toStoragePath(row.thumbnail_url);
  const settled = await Promise.allSettled([
    row.storage_path ? move(row.storage_path) : Promise.resolve(null),
    row.original_storage_path ? move(row.original_storage_path) : Promise.resolve(null),
    thumbPath ? move(thumbPath) : Promise.resolve(null),
  ]);
  const [display, original, thumb] = settled.map((r) => (r.status === 'fulfilled' ? r.value : null));
  const failure = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected');

  await db.query(
    `UPDATE photos SET
       storage_path = COALESCE($2, storage_path),
       full_url = COALESCE($3, full_url),
       original_storage_path = COALESCE($4, original_storage_path),
       original_url = COALESCE($5, original_url),
       thumbnail_url = COALESCE($6, thumbnail_url),
       is_quarantined = CASE WHEN $7 THEN $8 ELSE is_quarantined END
     WHERE id = $1`,
    [
      photoId,
      display?.storagePath ?? null,
      display ? toUrl(display) : null,
      original?.storagePath ?? null,
      original ? toUrl(original) : null,
      thumb ? toUrl(thumb) : null,
      !failure,
      quarantined,
    ]
  );

  if (failure) throw failure.reason;
}

/**
 * Put a photo back behind quarantine, for a host who takes back an approval.
 *
 * Approving moves the files to the publicly served root. Sending the photo
 * back to `pending`, or rejecting it after it was approved, only changed the
 * row: the feed stopped showing it while the file stayed reachable by anyone
 * holding or guessing its URL. `is_quarantined` is documented as meaning
 * exactly that this cannot happen (MED-03/SEC-M5), so the files have to
 * follow the decision.
 */
export async function withholdPhotoToQuarantine(
  photoId: string,
  db: Pool | PoolClient = pool
): Promise<void> {
  await withPhotoMoveLock(db, photoId, async (client) => {
    const { rows } = await client.query(
      'SELECT status, storage_path, original_storage_path, thumbnail_url, is_quarantined FROM photos WHERE id = $1',
      [photoId]
    );
    if (rows.length === 0 || rows[0].is_quarantined) return;
    // Approved again since this withhold was asked for (N-71).
    if (PUBLIC_STATUSES.includes(rows[0].status)) return;

    await moveCopies(
      client,
      photoId,
      rows[0],
      (p) => storageAdapter.demoteToQuarantine(p),
      (moved) => moved.publicUrl,
      true
    );
  });
}

/**
 * Move a single photo's quarantined copies (display/original/thumbnail) to
 * their public paths and update the row to match. A no-op for a photo whose
 * copies are already public, or whose status is not public — safe to call
 * unconditionally.
 */
export async function promotePhotoFromQuarantine(
  photoId: string,
  db: Pool | PoolClient = pool
): Promise<void> {
  await withPhotoMoveLock(db, photoId, async (client) => {
    const { rows } = await client.query(
      'SELECT status, storage_path, original_storage_path, thumbnail_url FROM photos WHERE id = $1',
      [photoId]
    );
    if (rows.length === 0) return;
    const row = rows[0];
    // Rejected, or sent back to pending, since this promotion was asked for (N-71).
    if (!PUBLIC_STATUSES.includes(row.status)) return;

    if (
      !isQuarantined(row.storage_path) &&
      !isQuarantined(row.original_storage_path) &&
      !isQuarantined(toStoragePath(row.thumbnail_url))
    ) {
      return;
    }

    await moveCopies(
      client,
      photoId,
      row,
      (p) => storageAdapter.promoteFromQuarantine(p),
      (moved) => toAbsoluteUrl(moved.storagePath),
      false
    );
  });
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
     AND (is_locked = false OR $2 = false)
     -- N-47: promoting writes a new public copy, which a purge already
     -- under way for this album would never see.
     AND NOT EXISTS (SELECT 1 FROM events e WHERE e.id = photos.event_id
                       AND e.deleting_at IS NOT NULL AND e.deleting_at >= NOW() - INTERVAL '1 hour')`;

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
    // The lock has expired (or the host switched disposable mode off), so
    // the rows should stop saying otherwise. Left set, `is_locked` keeps
    // refusing likes and comments in engagement.ts long after the photos
    // themselves are public.
    if (!disposableLocked) {
      await client
        .query('UPDATE photos SET is_locked = false WHERE event_id = $1 AND is_locked', [eventId])
        .catch((err) => console.warn(`[Quarantine] Could not clear the lock flag for ${eventId}:`, errorLabel(err)));
    }
  } finally {
    if (held) {
      await client
        .query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [`promote_${eventId}`])
        .catch(() => undefined);
    }
    client.release();
  }
}
