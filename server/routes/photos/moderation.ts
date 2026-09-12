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
import { storageAdapter, toStoragePath } from '../../lib/storage';
import { requireAuth } from '../../middleware/auth';
import { validateBody } from '../../middleware/validate';
import { promotePhotoFromQuarantine } from '../../lib/photoQuarantine';
import {
  StatusPhotoSchema,
} from './shared';

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
      `SELECT e.host_user_id, p.is_locked, e.reveal_at
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

    if (result.rows.length > 0) {
      wsManager.broadcastToEvent(result.rows[0].event_id, 'PHOTO_STATUS_UPDATED', { photoId: id, status });
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
    const photoQuery = await pool.query(
      `SELECT p.event_id, p.storage_path, p.original_storage_path, p.thumbnail_url, e.host_user_id
         FROM photos p JOIN events e ON e.id = p.event_id
        WHERE p.id = $1`,
      [id]
    );
    // [FIX H-18] Explicit 404 instead of silent success
    if (photoQuery.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });
    if (photoQuery.rows[0].host_user_id !== req.user!.userId) return res.status(403).json({ error: 'Forbidden' });

    const { event_id, storage_path, original_storage_path, thumbnail_url } = photoQuery.rows[0];
    await pool.query('DELETE FROM photos WHERE id = $1', [id]);

    // All three derivatives, not just the display copy. Deleting only
    // storage_path left the original - by far the largest file - and the
    // thumbnail in storage forever, while the row's removal decremented the
    // event's storage_bytes by the full amount. The quota said the space was
    // freed; the bytes were still there, and nothing referenced them any more.
    for (const path of [
      storage_path,
      original_storage_path,
      toStoragePath(thumbnail_url),
    ]) {
      if (!path) continue;
      await storageAdapter
        .delete(path)
        .catch((e: unknown) => console.warn('[Photos] Storage delete failed:', errorLabel(e)));
    }

    wsManager.broadcastToEvent(event_id, 'PHOTO_REMOVED', { photoId: id });
    res.json({ success: true, photoId: id });
  } catch (err) {
    console.error('[Photos] DELETE error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});
