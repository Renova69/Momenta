/**
 * Guest engagement on a photo: likes, emoji reactions and comments.
 *
 * Split out of the former single-file `photos.ts` (1013 lines, past the
 * project's 800-line ceiling). Mounted by `photos.ts`, which composes the
 * sub-routers in their original registration order.
 */

import { Router } from 'express';
import { pool } from '../../lib/db';
import { requireUuidParams } from '../../middleware/uuid';
import { resolveGuestIdentity } from '../../lib/guestIdentity';
import { wsManager } from '../../ws/wsServer';
import { errorLabel } from '../../lib/errors';
import { validateBody } from '../../middleware/validate';
import { reactionLimiter, commentLimiter, commentIpLimiter } from '../../middleware/rateLimit';
import { issueGuestToken, verifyGuestToken } from '../../lib/guestAuth';
import { isValidUuid } from '../../lib/validation';
import {
  LikePhotoSchema,
  ReactPhotoSchema,
  CommentPhotoSchema,
} from './shared';

/**
 * Declared under the name the handlers below were already written with, and
 * re-exported under a distinct one, so every handler body in this file is
 * byte-identical to what it was in the single-file router.
 */
const photosRouter = Router();
export { photosRouter as engagementRouter };

// 4. POST /api/photos/:id/like
photosRouter.post('/:id/like', requireUuidParams('id'), validateBody(LikePhotoSchema), async (req, res) => {
  const id = String(req.params.id);
  const { guestId, guestToken } = req.body;

  if (!isValidUuid(id) || !isValidUuid(guestId)) {
    return res.status(400).json({ error: 'Invalid photoId or guestId format' });
  }

  try {
    const photoQuery = await pool.query(
      `SELECT p.event_id AS event_id, p.status AS status, p.is_locked AS is_locked, e.reveal_at AS reveal_at
         FROM photos p JOIN events e ON e.id = p.event_id WHERE p.id = $1`,
      [id]
    );
    if (photoQuery.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });
    const photoRow = photoQuery.rows[0];
    const eventId = photoRow.event_id;

    // A guest-facing action must not be possible on a photo a guest cannot
    // even see yet — moderation pending/rejected, or disposable-locked
    // before its reveal. Liking or commenting doesn't check the photo's own
    // gallery visibility rule, and the resulting broadcast reaches every
    // guest in the room regardless (SEC-W4).
    const isRevealed = !photoRow.is_locked || !photoRow.reveal_at || new Date(photoRow.reveal_at).getTime() <= Date.now();
    if (!['approved', 'featured'].includes(photoRow.status) || !isRevealed) {
      return res.status(403).json({ error: 'This photo is not available yet.' });
    }

    // A guestId is only proof of identity within its own event — without this,
    // a guest from event B can like/unlike photos in event A (SEC-D3). And a
    // guestId alone is not proof of identity at all — every photo response
    // includes its guestId, so anyone viewing the feed can read one and like
    // as that guest unless the caller also proves it with a token (SEC-A2).
    const guestScope = await pool.query('SELECT id, token_version FROM guests WHERE id = $1 AND event_id = $2', [guestId, eventId]);
    if (guestScope.rows.length === 0 || !verifyGuestToken(guestToken, guestId, eventId, guestScope.rows[0].token_version)) {
      return res.status(401).json({ error: 'Guest session invalid or expired.', code: 'GUEST_TOKEN_REQUIRED' });
    }

    const likeCheck = await pool.query(
      'SELECT id FROM photo_likes WHERE photo_id = $1 AND guest_id = $2',
      [id, guestId]
    );

    let isLiked: boolean;
    if (likeCheck.rows.length > 0) {
      await pool.query('DELETE FROM photo_likes WHERE photo_id = $1 AND guest_id = $2', [id, guestId]);
      isLiked = false;
      wsManager.broadcastToEvent(eventId, 'PHOTO_UNLIKED', { photoId: id, guestId });
    } else {
      await pool.query('INSERT INTO photo_likes (photo_id, guest_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, guestId]);
      isLiked = true;
      wsManager.broadcastToEvent(eventId, 'PHOTO_LIKED', { photoId: id, guestId });
    }

    res.json({ success: true, photoId: id, isLiked });
  } catch (err) {
    console.error('[Photos] like error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Per-photo emoji reactions, alongside the single-purpose like above. A
// guest can toggle several different emoji kinds independently on the same
// photo (Slack-style), unlike /like which is one boolean per guest.
photosRouter.post(
  '/:id/reactions',
  requireUuidParams('id'),
  reactionLimiter,
  validateBody(ReactPhotoSchema),
  async (req, res) => {
    const id = String(req.params.id);
    const { reaction, guestId, guestToken } = req.body;

    if (!isValidUuid(id) || !isValidUuid(guestId)) {
      return res.status(400).json({ error: 'Invalid photoId or guestId format' });
    }

    try {
      const photoQuery = await pool.query(
        `SELECT p.event_id AS event_id, p.status AS status, p.is_locked AS is_locked, e.reveal_at AS reveal_at
           FROM photos p JOIN events e ON e.id = p.event_id WHERE p.id = $1`,
        [id]
      );
      if (photoQuery.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });
      const photoRow = photoQuery.rows[0];
      const eventId = photoRow.event_id;

      // Same visibility gate as /like (SEC-W4): reacting must not be
      // possible on a photo the guest cannot actually see yet.
      const isRevealed = !photoRow.is_locked || !photoRow.reveal_at || new Date(photoRow.reveal_at).getTime() <= Date.now();
      if (!['approved', 'featured'].includes(photoRow.status) || !isRevealed) {
        return res.status(403).json({ error: 'This photo is not available yet.' });
      }

      // Same identity proof as /like (SEC-D3 / SEC-A2): a guestId alone is
      // never enough, and it must belong to this event.
      const guestScope = await pool.query('SELECT id, token_version FROM guests WHERE id = $1 AND event_id = $2', [guestId, eventId]);
      if (guestScope.rows.length === 0 || !verifyGuestToken(guestToken, guestId, eventId, guestScope.rows[0].token_version)) {
        return res.status(401).json({ error: 'Guest session invalid or expired.', code: 'GUEST_TOKEN_REQUIRED' });
      }

      const existing = await pool.query(
        'SELECT id FROM photo_reactions WHERE photo_id = $1 AND guest_id = $2 AND reaction = $3',
        [id, guestId, reaction]
      );

      let isActive: boolean;
      if (existing.rows.length > 0) {
        await pool.query(
          'DELETE FROM photo_reactions WHERE photo_id = $1 AND guest_id = $2 AND reaction = $3',
          [id, guestId, reaction]
        );
        isActive = false;
        wsManager.broadcastToEvent(eventId, 'PHOTO_REACTION_REMOVED', { photoId: id, guestId, reaction });
      } else {
        await pool.query(
          'INSERT INTO photo_reactions (photo_id, guest_id, reaction) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING',
          [id, guestId, reaction]
        );
        isActive = true;
        wsManager.broadcastToEvent(eventId, 'PHOTO_REACTION_ADDED', { photoId: id, guestId, reaction });
      }

      res.json({ success: true, photoId: id, reaction, isActive });
    } catch (err) {
      console.error('[Photos] reaction error:', errorLabel(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// 5. POST /api/photos/:id/comments
photosRouter.post(
  '/:id/comments',
  requireUuidParams('id'),
  commentIpLimiter,
  commentLimiter,
  validateBody(CommentPhotoSchema),
  async (req, res) => {
  const { id } = req.params;
  const { guestId, guestName, commentText, guestToken, deviceFingerprint } = req.body;

  try {
    const photoQuery = await pool.query(
      `SELECT p.event_id AS event_id, p.status AS status, p.is_locked AS is_locked, e.reveal_at AS reveal_at
         FROM photos p JOIN events e ON e.id = p.event_id WHERE p.id = $1`,
      [id]
    );
    if (photoQuery.rows.length === 0) return res.status(404).json({ error: 'Photo not found' });
    const photoRow = photoQuery.rows[0];
    const eventId = photoRow.event_id;

    // Same visibility rule as the like endpoint — a photo a guest cannot see
    // yet must not be commentable, since the broadcast reaches the whole
    // room regardless of the REST list's own filtering (SEC-W4).
    const isRevealed = !photoRow.is_locked || !photoRow.reveal_at || new Date(photoRow.reveal_at).getTime() <= Date.now();
    if (!['approved', 'featured'].includes(photoRow.status) || !isRevealed) {
      return res.status(403).json({ error: 'This photo is not available yet.' });
    }

    // H8 — a token, else this device's existing row, else one row for this
    // device. A caller with neither is asked to identify itself instead of
    // being handed a brand-new guest (see lib/guestIdentity.ts).
    const identity = await resolveGuestIdentity({
      eventId,
      guestId,
      guestToken,
      deviceFingerprint,
      fallbackName: guestName,
    });
    if (!identity) {
      return res.status(401).json({
        error: 'Join the wedding before commenting.',
        code: 'GUEST_IDENTITY_REQUIRED',
      });
    }
    const validGuestId = identity.guestId;
    const resolvedGuestName = identity.name;

    const commentInsert = await pool.query(
      `INSERT INTO photo_comments (photo_id, guest_id, comment_text)
       VALUES ($1, $2, $3)
       RETURNING id, photo_id as "photoId", guest_id as "guestId", comment_text as "commentText", created_at as "createdAt"`,
      [id, validGuestId, commentText.trim()]
    );

    const comment = { ...commentInsert.rows[0], guestName: resolvedGuestName, localId: req.body.localId };
    // Broadcast carries no token — every other guest in the room receives
    // this message, and a token in it would let any of them impersonate the
    // commenter (SEC-A2).
    wsManager.broadcastToEvent(eventId, 'COMMENT_ADDED', comment);
    // Only when identity was actually proven this request (SEC-03) — a
    // fingerprint-only match onto a pre-existing row is attributed correctly
    // but must not walk away with a durable credential for that guest.
    res.status(201).json({
      ...comment,
      ...(identity.identityProven ? { guestToken: issueGuestToken(validGuestId, eventId, identity.tokenVersion) } : {}),
    });
  } catch (err) {
    console.error('[Photos] comment error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});
