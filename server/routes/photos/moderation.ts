/**
 * Host moderation: approving or featuring a photo, and deleting one.
 *
 * Split out of the former single-file `photos.ts` (1013 lines, past the
 * project's 800-line ceiling). Mounted by `photos.ts`, which composes the
 * sub-routers in their original registration order.
 */

import { Router } from 'express';
import { pool } from '../../lib/db';
import { requireUuidParams } from '../../middleware/uuid';
import { wsManager } from '../../ws/wsServer';
import { errorLabel } from '../../lib/errors';
import { forGuests } from '../../lib/photoWrite';
import { storageAdapter, toStoragePath, isQuarantined } from '../../lib/storage';
import { requireAuth } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { promotePhotoFromQuarantine, withholdPhotoToQuarantine, withPhotoMoveLock } from '../../lib/photoQuarantine';
import {
  StatusPhotoSchema,
  loadGuestPhotoDto,
} from './shared';

const PUBLIC_STATUSES = ['approved', 'featured'];

/**
 * Send guests a photo the host has just made public (N-67).
 *
 * A guest was never sent a photo while it was pending, so the status update
 * that approval broadcasts had nothing to apply to: the photo reached their
 * screen, and the projector wall, only on a reload. Hosts are left out, as
 * they have held the photo since it arrived.
 */
async function announceToGuests(eventId: string, photoId: string): Promise<void> {
  const photo = await loadGuestPhotoDto(photoId);
  if (!photo) return;
  if (photo.isLocked) {
    // Before the reveal guests learn that a photo exists, not what it shows,
    // the same as a locked upload's broadcast.
    wsManager.broadcastToEventGuests(eventId, 'PHOTO_ADDED', { ...forGuests(photo), fullUrl: '', thumbnailUrl: '' });
    return;
  }
  // Promotion failed and was logged: a guest cannot load these URLs.
  if (isQuarantined(String(photo.storagePath)) || isQuarantined(String(photo.thumbnailUrl))) return;
  wsManager.broadcastToEventGuests(eventId, 'PHOTO_ADDED', forGuests(photo));
}

/**
 * Declared under the name the handlers below were already written with, and
 * re-exported under a distinct one, so every handler body in this file is
 * byte-identical to what it was in the single-file router.
 */
const photosRouter = Router();
export { photosRouter as moderationRouter };

// 6. POST /api/photos/:id/status (Host moderation only)
photosRouter.post('/:id/status', requireAuth, requireUuidParams('id'), validateBody(StatusPhotoSchema), async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;

  try {
    const checkQuery = await pool.query(
      `SELECT e.host_user_id, p.is_locked, e.reveal_at, p.status AS previous_status
         FROM photos p JOIN events e ON e.id = p.event_id WHERE p.id = $1`,
      [id]
    );
    if (checkQuery.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });
    if (checkQuery.rows[0].host_user_id !== req.user!.userId) return res.status(403).json({ error: 'Forbidden' });

    const result = await pool.query(
      'UPDATE photos SET status = $1 WHERE id = $2 RETURNING event_id, id, status',
      [status, id]
    );

    // MED-03/SEC-M5 — approving/featuring is the one discrete action that
    // makes a photo safe to be public. Skip promotion if it's still
    // disposable-locked and the reveal hasn't happened yet; the read path
    // (GET /api/photos) promotes it lazily once that deadline passes.
    if (result.rows.length > 0 && ['approved', 'featured'].includes(status)) {
      const { is_locked, reveal_at } = checkQuery.rows[0];
      const stillLocked = !!is_locked && !!reveal_at && new Date(reveal_at).getTime() > Date.now();
      if (!stillLocked) {
        await promotePhotoFromQuarantine(String(id)).catch((err) => {
          console.error('[Photos] Could not promote photo from quarantine:', errorLabel(err));
        });
      }
    }

    // Taking an approval back has to take the file back too. Without this the
    // feed hid the photo while the file stayed publicly reachable — and for a
    // rejection, that is the one state where the host has said plainly that
    // nobody should see it.
    if (result.rows.length > 0 && ['pending', 'rejected'].includes(status)) {
      await withholdPhotoToQuarantine(String(id)).catch((err) => {
        console.error('[Photos] Could not withhold photo into quarantine:', errorLabel(err));
      });
    }

    if (result.rows.length > 0) {
      const eventId = result.rows[0].event_id;
      const becamePublic = PUBLIC_STATUSES.includes(status) && !PUBLIC_STATUSES.includes(checkQuery.rows[0].previous_status);
      if (becamePublic) {
        // The status has changed either way; a broadcast that fails costs a
        // guest a live update, not the host their approval.
        await announceToGuests(eventId, String(id)).catch((err) => {
          console.error('[Photos] Could not announce an approved photo:', errorLabel(err));
        });
      }
      wsManager.broadcastToEvent(eventId, 'PHOTO_STATUS_UPDATED', { photoId: id, status });
    }
    res.json({ success: true, photoId: id, status });
  } catch (err) {
    console.error('[Photos] status error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 7. DELETE /api/photos/:id — [FIX H-18] Return 404 when photo not found
photosRouter.delete('/:id', requireAuth, requireUuidParams('id'), async (req, res) => {
  const { id } = req.params;
  try {
    const ownerQuery = await pool.query(
      `SELECT e.host_user_id
         FROM photos p JOIN events e ON e.id = p.event_id
        WHERE p.id = $1`,
      [id]
    );
    // [FIX H-18] Explicit 404 instead of silent success
    if (ownerQuery.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });
    if (ownerQuery.rows[0].host_user_id !== req.user!.userId) return res.status(403).json({ error: 'Forbidden' });

    // N-85 — under the photo's own move lock (N-71), with its paths read once
    // the lock is held. Read before it, a promotion moving the files at the
    // same moment left this deleting the old paths while the row went, and
    // the copies the promotion had just made public stayed in storage with
    // nothing naming them.
    let outcome: { eventId: string; failedPaths: string[] } | null = null;
    await withPhotoMoveLock(pool, String(id), async (client) => {
      const photoQuery = await client.query(
        'SELECT event_id, storage_path, original_storage_path, thumbnail_url FROM photos WHERE id = $1',
        [id]
      );
      if (photoQuery.rows.length === 0) return;
      const { event_id, storage_path, original_storage_path, thumbnail_url } = photoQuery.rows[0];

    // Files first, then the row — the same order album deletion follows, and
    // for the same reason. The row is the only record of where the bytes are:
    // delete it first and anything that stops the file deletes (a deploy
    // restarting the process mid-request, a storage error) strands them with
    // nothing left to name them. Neither orphan sweep can recover those,
    // because both match whole abandoned albums and skip every key under a
    // live event. Meanwhile the row's removal has already told the trigger to
    // credit the bytes back, so the quota reports space that is still in use.
    //
    // All three derivatives, not just the display copy. Deleting only
    // storage_path left the original — by far the largest file — and the
    // thumbnail in storage forever.
      const failedPaths: string[] = [];
      for (const path of [
        storage_path,
        original_storage_path,
        toStoragePath(thumbnail_url),
      ]) {
        if (!path) continue;
        await storageAdapter.delete(path).catch((e: unknown) => {
          failedPaths.push(path);
          console.warn('[Photos] Storage delete failed:', errorLabel(e));
        });
      }

      if (failedPaths.length === 0) {
        await client.query('DELETE FROM photos WHERE id = $1', [id]);
      } else {
        // A file that would not delete keeps its row, so the bytes stay
        // accounted for and the next attempt can still find them. But the
        // files that did delete are gone, so the photo is taken out of the
        // guest feed rather than left there broken (N-85): the host asked
        // for it to go.
        await client.query("UPDATE photos SET status = 'rejected' WHERE id = $1", [id]);
      }
      outcome = { eventId: event_id, failedPaths };
    });

    // Deleted by someone else while this waited for the lock.
    if (!outcome) return res.status(404).json({ error: 'Photo not found' });
    const { eventId, failedPaths } = outcome as { eventId: string; failedPaths: string[] };

    if (failedPaths.length > 0) {
      console.error(`[Photos] delete for ${id} left ${failedPaths.length} object(s) in storage`);
      wsManager.broadcastToEvent(eventId, 'PHOTO_STATUS_UPDATED', { photoId: id, status: 'rejected' });
      return res.status(502).json({
        error: 'The photo could not be fully removed from storage. It is hidden from guests — please try again.',
        code: 'STORAGE_DELETE_FAILED',
      });
    }

    wsManager.broadcastToEvent(eventId, 'PHOTO_REMOVED', { photoId: id });
    res.json({ success: true, photoId: id });
  } catch (err) {
    console.error('[Photos] DELETE error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});
