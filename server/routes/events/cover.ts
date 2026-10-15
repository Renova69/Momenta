/**
 * The album's cover (N-139): set from an upload or from one of the album's
 * photos, and removed. The only way the cover is written.
 *
 * The server keeps its own copy of whichever picture the host chose, at
 * display size, under the album's folder: deleting or rejecting a photo later
 * cannot break the cover, the first image every guest's phone loads stays
 * small, and the file goes with the album when it is purged. A photo can only
 * become the cover once guests can see it, so the cover cannot show a photo
 * still waiting for moderation or for the disposable reveal.
 */

import { Router } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { pool } from '../../lib/db';
import { validateBody } from '../../middleware/validate';
import { requireUuidParams } from '../../middleware/uuid';
import { requireAuth } from '../../middleware/auth';
import { uploadLimiter } from '../../middleware/rateLimit';
import { acquireEventUploadLock } from '../../middleware/tierGate';
import { errorLabel } from '../../lib/errors';
import { buildCover } from '../../lib/images';
import {
  decodeDataUrl,
  isStoredCoverUrl,
  saveBuffer,
  storageAdapter,
  storagePathBelongsToEvent,
  toAbsoluteUrl,
  toStoragePath,
} from '../../lib/storage';
import { wsManager } from '../../ws/wsServer';

export const coverRouter = Router();

/** Largest stored photo the cover is copied from; a display copy is far less. */
const MAX_SOURCE_BYTES = 25 * 1024 * 1024;

const SetCoverSchema = z
  .object({
    image: z.string().startsWith('data:image/', 'image must be a data:image/ URL').optional(),
    photoId: z.string().uuid().optional(),
  })
  .refine((body) => !!body.image !== !!body.photoId, {
    message: 'Send either image or photoId',
    path: ['image'],
  });

type Refusal = { status: number; error: string; code?: string };

/** 404 when the album is missing, 403 when it is someone else's. */
async function ownerRefusal(eventId: string, userId: string): Promise<Refusal | null> {
  const { rows } = await pool.query<{ host_user_id: string }>('SELECT host_user_id FROM events WHERE id = $1', [eventId]);
  if (rows.length === 0) return { status: 404, error: 'Event not found' };
  if (rows[0].host_user_id !== userId) return { status: 403, error: 'Forbidden: You do not own this event' };
  return null;
}

async function readStream(storagePath: string): Promise<Buffer | null> {
  const stream = await storageAdapter.getStream(storagePath);
  if (!stream) return null;
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > MAX_SOURCE_BYTES) {
      stream.destroy();
      return null;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * The display file of a photo of this album that guests can see right now,
 * by the feed's own rules: approved or featured, out of quarantine, and not
 * locked behind a disposable reveal still ahead.
 */
async function publicPhotoSource(eventId: string, photoId: string): Promise<Buffer | Refusal> {
  const { rows } = await pool.query<{ storage_path: string; visible: boolean }>(
    `SELECT p.storage_path,
            (p.status IN ('approved', 'featured')
             AND NOT p.is_quarantined
             AND NOT (p.is_locked AND e.is_disposable_mode AND e.reveal_at IS NOT NULL AND e.reveal_at > NOW())
            ) AS visible
       FROM photos p JOIN events e ON e.id = p.event_id
      WHERE p.id = $1 AND p.event_id = $2`,
    [photoId, eventId]
  );
  const photo = rows[0];
  if (!photo) return { status: 404, error: 'Photo not found in this album' };
  if (!photo.visible) {
    return { status: 409, error: 'Only a photo guests can already see can be the cover.', code: 'PHOTO_NOT_PUBLIC' };
  }
  // SEC-04 — never stream a path that is not this album's.
  if (!storagePathBelongsToEvent(photo.storage_path, eventId)) return { status: 404, error: 'Photo not found in this album' };
  const source = await readStream(photo.storage_path);
  return source ?? { status: 404, error: 'Photo file not found' };
}

/**
 * Point the album at `coverUrl` (or at no cover) under its upload lock,
 * refused while the album is being deleted, as a photo is (N-47). Returns the
 * cover it replaced, or `undefined` when nothing was written.
 */
async function writeCover(eventId: string, userId: string, coverUrl: string | null): Promise<{ previous: string | null } | undefined> {
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    await acquireEventUploadLock(client, eventId);
    const { rows } = await client.query<{ previous: string | null }>(
      `UPDATE events e SET cover_image_url = $1, updated_at = NOW()
         FROM events old
        WHERE e.id = $2 AND old.id = e.id AND e.host_user_id = $3
          AND (e.deleting_at IS NULL OR e.deleting_at < NOW() - INTERVAL '1 hour')
      RETURNING old.cover_image_url AS previous`,
      [coverUrl, eventId, userId]
    );
    await client.query('COMMIT');
    return rows[0] ? { previous: rows[0].previous } : undefined;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Best-effort: the row already names the new cover; a leftover goes with the album. */
async function removeStoredCover(previous: string | null, current: string | null, eventId: string): Promise<void> {
  if (!previous || previous === current || !isStoredCoverUrl(previous, eventId)) return;
  await storageAdapter
    .delete(toStoragePath(previous) ?? previous)
    .catch((err) => console.warn('[Events] could not remove a replaced cover:', errorLabel(err)));
}

function announce(eventId: string, coverUrl: string | null): void {
  wsManager.broadcastToEvent(eventId, 'EVENT_UPDATED', { id: eventId, cover_image_url: coverUrl });
}

// POST /api/events/:id/cover — { image: data URL } or { photoId }
coverRouter.post(
  '/:id/cover',
  requireAuth,
  uploadLimiter,
  requireUuidParams('id'),
  validateBody(SetCoverSchema),
  async (req, res) => {
    const eventId = String(req.params.id);
    const userId = req.user!.userId;
    const { image, photoId } = req.body as z.infer<typeof SetCoverSchema>;

    try {
      const refused = await ownerRefusal(eventId, userId);
      if (refused) return res.status(refused.status).json({ error: refused.error });

      let source: Buffer;
      if (photoId) {
        const found = await publicPhotoSource(eventId, photoId);
        if (!Buffer.isBuffer(found)) return res.status(found.status).json({ error: found.error, code: found.code });
        source = found;
      } else {
        const decoded = decodeDataUrl(image);
        if (!decoded) return res.status(400).json({ error: 'Not a supported image file', code: 'NOT_AN_IMAGE' });
        source = decoded.buffer;
      }

      let cover: Buffer;
      try {
        cover = await buildCover(source);
      } catch {
        return res.status(400).json({ error: 'Not a supported image file', code: 'NOT_AN_IMAGE' });
      }

      const saved = await saveBuffer(cover, 'cover', '.jpg', 'image/jpeg', eventId);
      const coverImageUrl = toAbsoluteUrl(saved.storagePath);
      const written = await writeCover(eventId, userId, coverImageUrl).catch(async (err) => {
        await storageAdapter.delete(saved.storagePath).catch(() => undefined);
        throw err;
      });
      if (!written) {
        await storageAdapter.delete(saved.storagePath).catch(() => undefined);
        return res.status(409).json({ error: 'This album is being deleted.', code: 'DELETION_IN_PROGRESS' });
      }

      await removeStoredCover(written.previous, coverImageUrl, eventId);
      announce(eventId, coverImageUrl);
      res.json({ coverImageUrl });
    } catch (err) {
      console.error('[Events] cover error:', errorLabel(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// DELETE /api/events/:id/cover
coverRouter.delete('/:id/cover', requireAuth, requireUuidParams('id'), async (req, res) => {
  const eventId = String(req.params.id);
  const userId = req.user!.userId;

  try {
    const refused = await ownerRefusal(eventId, userId);
    if (refused) return res.status(refused.status).json({ error: refused.error });

    const written = await writeCover(eventId, userId, null);
    if (!written) return res.status(409).json({ error: 'This album is being deleted.', code: 'DELETION_IN_PROGRESS' });

    await removeStoredCover(written.previous, null, eventId);
    announce(eventId, null);
    res.json({ coverImageUrl: null });
  } catch (err) {
    console.error('[Events] cover removal error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});
