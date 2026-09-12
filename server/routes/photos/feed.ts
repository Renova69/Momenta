/**
 * Reading the album: the paginated feed and quarantined-photo previews.
 *
 * Split out of the former single-file `photos.ts` (1013 lines, past the
 * project's 800-line ceiling). Mounted by `photos.ts`, which composes the
 * sub-routers in their original registration order.
 */

import { Router } from 'express';
import { pool } from '../../lib/db';
import { requireUuidParams } from '../../middleware/uuid';
import { verifyPreviewToken } from '../../lib/previewToken';
import { errorLabel } from '../../lib/errors';
import { storageAdapter, toStoragePath, isQuarantined } from '../../lib/storage';
import { optionalAuth } from '../../middleware/auth';
import { validateQuery } from '../../middleware/validate';
import { buildPreviewUrl, promoteEligiblePhotos } from '../../lib/photoQuarantine';
import {
  CURSOR_PATTERN,
  ListPhotosQuerySchema,
  attachPhotoAggregates,
} from './shared';

/**
 * Declared under the name the handlers below were already written with, and
 * re-exported under a distinct one, so every handler body in this file is
 * byte-identical to what it was in the single-file router.
 */
const photosRouter = Router();
export { photosRouter as feedRouter };

// 2. GET /api/photos (Strictly scoped by eventId to guarantee wedding album separation)
photosRouter.get('/', optionalAuth, validateQuery(ListPhotosQuerySchema), async (req, res) => {
  try {
    const { eventId, limit, cursor } = req.query as unknown as {
      eventId: string;
      limit: number;
      cursor?: string;
    };

    // One lookup covers both host verification and the disposable-camera window.
    const eventRes = await pool.query(
      'SELECT host_user_id, is_disposable_mode, reveal_at FROM events WHERE id = $1',
      [eventId]
    );
    if (eventRes.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const eventRow = eventRes.rows[0];

    const isHost = !!req.user?.userId && eventRow.host_user_id === req.user.userId;

    // Enforce disposable-camera "locked until reveal" server-side for non-hosts.
    const disposableLocked =
      !!eventRow.is_disposable_mode &&
      !!eventRow.reveal_at &&
      new Date(eventRow.reveal_at).getTime() > Date.now();

    // MED-03/SEC-M5 — a disposable reveal is a passive deadline (reveal_at
    // just passes), not a discrete action anything else hooks into. Promote
    // whatever just became eligible before running the query below, so a
    // guest loading the feed right after reveal gets working image URLs
    // instead of ones still pointing at quarantine.
    await promoteEligiblePhotos(eventId, disposableLocked);

    let query = `
      SELECT 
        p.id,
        p.event_id as "eventId",
        p.guest_id as "guestId",
        g.name as "guestName",
        g.avatar_url as "guestAvatar",
        g.table_number as "guestTable",
        p.quest_id as "questId",
        sq.title as "questTitle",
        p.storage_path as "storagePath",
        p.thumbnail_url as "thumbnailUrl",
        p.full_url as "fullUrl",
        p.original_url as "originalUrl",
        p.caption,
        p.status,
        p.is_locked as "isLocked",
        p.filter_applied as "filterApplied",
        p.likes_count as "likesCount",
        p.comments_count as "commentsCount",
        p.created_at as "createdAt",
        p.source,
        p.priority,
        p.photographer_name as "photographerName"
      FROM photos p
      JOIN guests g ON g.id = p.guest_id
      LEFT JOIN scavenger_quests sq ON sq.id = p.quest_id
      WHERE p.event_id = $1
    `;

    const params: (string | number)[] = [eventId];

    // Non-hosts can only view approved or featured photos
    if (!isHost) {
      query += ` AND p.status IN ('approved', 'featured')`;
      // While disposable mode is active and not yet revealed, hide locked photos.
      if (disposableLocked) {
        query += ` AND p.is_locked = false`;
      }
    }

    if (cursor) {
      const match = cursor.match(CURSOR_PATTERN)!;
      const cursorPriority = Number.parseInt(match[1], 10);
      const cursorCreatedAt = match[2];
      params.push(cursorPriority, cursorCreatedAt);
      // Composite keyset cursor (DB-03) — matches the ORDER BY exactly, so a
      // page boundary that falls between two rows sharing a priority (the
      // common case, priority=0) can't skip or repeat rows the way a
      // created_at-only cursor did once any priority=10 photo existed.
      query += ` AND (p.priority, p.created_at) < ($${params.length - 1}, $${params.length})`;
    }

    params.push(limit);
    query += ` ORDER BY p.priority DESC, p.created_at DESC LIMIT $${params.length};`;

    const result = await pool.query(query, params);

    // M6 — the comments/likes/reactions aggregates used to be three correlated
    // subqueries evaluated once per row: at the maximum limit of 200 that is
    // 600 subquery executions to render a single feed page, and it scaled with
    // the page rather than staying flat. Three batched lookups keyed on the
    // page's photo ids answer the same question against
    // idx_photo_comments_photo / idx_photo_likes_photo / idx_photo_reactions_photo
    // in a fixed number of round trips, whatever the page size.
    await attachPhotoAggregates(result.rows);

    // MED-02: originalUrl points at the untouched camera capture, EXIF/GPS
    // and all — sharp's derivatives strip nothing, only re-encode. Fine for
    // the host who owns the album; a guest link is handed out to anyone
    // attending, so exposing raw location data there is a real privacy leak,
    // not just a resolution upgrade.
    //
    // MED-03/SEC-M5: a row that reaches this point still pointing at
    // quarantine can only be here because it's the host's own view — the
    // WHERE clause above already excludes pending/rejected and (while
    // disposableLocked) locked rows for anyone else. Swap in signed,
    // time-limited preview URLs so the host's moderation queue can still
    // render an `<img>` for it, instead of a real-but-unreachable
    // `/quarantine/...` path.
    const rows = isHost
      ? result.rows.map((row) => {
          if (!isQuarantined(row.storagePath) && !isQuarantined(row.originalUrl) && !isQuarantined(row.thumbnailUrl)) {
            return row;
          }
          return {
            ...row,
            fullUrl: buildPreviewUrl(row.id, req.user!.userId, 'display'),
            thumbnailUrl: buildPreviewUrl(row.id, req.user!.userId, 'thumbnail'),
            originalUrl: row.originalUrl ? buildPreviewUrl(row.id, req.user!.userId, 'original') : null,
          };
        })
      : result.rows.map((row) => ({ ...row, originalUrl: null }));

    res.json(rows);
  } catch (err) {
    console.error('[Photos] get error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2b. GET /api/photos/:id/preview (MED-03/SEC-M5) — stream a quarantined
// photo's bytes to the host that owns its event. Gated by a signed,
// single-purpose preview token (`server/lib/previewToken.ts`) rather than
// the host's own session JWT, since a browser `<img src>` cannot carry an
// Authorization header and this token can't be replayed for anything else.
photosRouter.get('/:id/preview', requireUuidParams('id'), async (req, res) => {
  const id = String(req.params.id);
  const { token, variant } = req.query as { token?: string; variant?: string };

  const userId = verifyPreviewToken(typeof token === 'string' ? token : undefined, id);
  if (!userId) return res.status(401).json({ error: 'Invalid or expired preview token' });

  try {
    const result = await pool.query(
      `SELECT p.storage_path, p.original_storage_path, p.thumbnail_url, e.host_user_id
         FROM photos p JOIN events e ON e.id = p.event_id WHERE p.id = $1`,
      [id]
    );
    if (result.rows.length === 0) return res.status(404).end();
    const row = result.rows[0];
    if (row.host_user_id !== userId) return res.status(403).end();

    const storagePath =
      variant === 'original' ? row.original_storage_path
      : variant === 'thumbnail' ? toStoragePath(row.thumbnail_url)
      : row.storage_path;
    if (!storagePath) return res.status(404).end();

    const stream = await storageAdapter.getStream(storagePath);
    if (!stream) return res.status(404).end();

    res.setHeader('Cache-Control', 'private, max-age=60');
    stream.pipe(res);
  } catch (err) {
    console.error('[Photos] preview error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});
