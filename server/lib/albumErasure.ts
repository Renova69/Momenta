import { pool } from './db';
import { purgeEventMedia, markEventDeleting, clearDeletionMark } from './retention';
import { errorLabel } from './errors';
import { wsManager } from '../ws/wsServer';

/** Another deletion (the retention sweep, or a second request) holds the album. */
export class AlbumBeingDeletedError extends Error {
  constructor(eventId: string) {
    super(`Album ${eventId} is already being deleted`);
    this.name = 'AlbumBeingDeletedError';
  }
}

export interface AlbumErasure {
  photosDeleted: number;
  bytesFreed: number;
}

/**
 * Erase one album and everything in it (D2): what deleting an album does, and
 * what deleting an account does for each of its albums (N-122).
 *
 * **Media is purged before the row, and the order is load-bearing.** Deleting
 * the event cascades its photo and audio rows away, and those rows hold the
 * only record of which stored objects belong to this album. Purge afterwards
 * and every file is orphaned permanently, with nothing left that could ever
 * find them again — exactly the failure that put 164 MB of unreachable objects
 * in storage before the orphan sweep was fixed. purgeEventMedia() is the same
 * function the retention sweep uses.
 *
 * Throws AlbumBeingDeletedError when another deletion holds the album, and
 * leaves the album taking uploads again if the purge or the row delete fails.
 */
export async function eraseAlbum(eventId: string): Promise<AlbumErasure> {
  const { rows } = await pool.query<{ host_user_id: string | null; slug: string }>(
    'SELECT host_user_id, slug FROM events WHERE id = $1',
    [eventId]
  );
  if (rows.length === 0) return { photosDeleted: 0, bytesFreed: 0 };
  const { host_user_id: hostUserId, slug } = rows[0];

  const photoCountRes = await pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM photos WHERE event_id = $1', [
    eventId,
  ]);
  const photosDeleted = photoCountRes.rows[0]?.n ?? 0;

  // 0. N-47 — stop new media first. The purge works from a snapshot, and
  // a photo written after it would lose its row and keep its file.
  // Stamped under the album's upload lock, so an upload that holds the
  // lock now commits before the snapshot and one that takes it later
  // sees the stamp and refuses (getUploadContext).
  const mark = await markEventDeleting(eventId);
  // The retention sweep is purging it; its mark is not ours to take off.
  if (!mark) throw new AlbumBeingDeletedError(eventId);

  // 1. Storage first — see above about the cascade.
  // If the purge or the row delete fails, the album is still here and must
  // take uploads again. A crash leaves the mark behind; getUploadContext
  // stops honouring one that old (DELETION_STALE_AFTER).
  const unmark = () => clearDeletionMark(mark).catch(() => undefined);
  let purge: Awaited<ReturnType<typeof purgeEventMedia>>;
  try {
    purge = await purgeEventMedia(eventId, mark);
  } catch (err) {
    await unmark();
    throw err;
  }
  const bytesFreed = purge.freedBytes;
  if (purge.failedPaths.length > 0) {
    // The rows naming these are about to be deleted, so after this only
    // `storage:orphans` can find them. Logged loudly rather than returned:
    // the erasure request did succeed, and this is an operator problem.
    console.error(
      `[Events] purge for ${eventId} left ${purge.failedPaths.length} object(s) in storage:`,
      purge.failedPaths.join(', ')
    );
  }

  // 2. Then the row, which cascades guests, quests, comments and the rest.
  try {
    await pool.query('DELETE FROM events WHERE id = $1', [eventId]);
  } catch (err) {
    await unmark();
    throw err;
  }

  // 3. A record that this happened, holding none of what was deleted.
  await pool
    .query(
      `INSERT INTO event_deletions (event_id, slug, host_user_id, photos_deleted, bytes_freed)
       VALUES ($1, $2, $3, $4, $5)`,
      [eventId, slug, hostUserId, photosDeleted, bytesFreed]
    )
    .catch((err) => {
      // The deletion itself has already happened and is not reversible;
      // failing now would report it as not having worked.
      console.error('[Events] deletion succeeded but the audit row failed:', errorLabel(err));
    });

  console.warn(
    `[Events] Host ${hostUserId} deleted event ${slug} (${eventId}) — ${photosDeleted} photo(s), ${bytesFreed} bytes freed`
  );

  wsManager.broadcastToEvent(eventId, 'EVENT_DELETED', { eventId });
  return { photosDeleted, bytesFreed };
}
