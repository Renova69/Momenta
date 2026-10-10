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
  photoDtoQuery,
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

    let query = `${photoDtoQuery(String(disposableLocked))}
      WHERE p.event_id = $1
    `;

    const params: (string | number)[] = [eventId];

    // Non-hosts can only view approved or featured photos
    if (!isHost) {
      query += ` AND p.status IN ('approved', 'featured')`;
      // N-72 — the promotion above can fail for one photo, or be running on
      // another request that holds the album's lock. Until all of a photo's
      // files are public, a guest would only get links into quarantine.
      query += ` AND NOT p.is_quarantined`;
      // While disposable mode is active and not yet revealed, hide locked photos.
      if (disposableLocked) {
        query += ` AND p.is_locked = false`;
      }
    }

    if (cursor) {
      const match = cursor.match(CURSOR_PATTERN)!;
      const cursorPriority = Number.parseInt(match[1], 10);
      const cursorCreatedAt = match[2];
      const cursorPhotoId = match[3];
      // Composite keyset cursor (DB-03) — matches the ORDER BY exactly, so a
      // page boundary that falls between two rows sharing a priority (the
      // common case, priority=0) can't skip or repeat rows the way a
      // created_at-only cursor did once any priority=10 photo existed.
      if (cursorPhotoId) {
        // N-88 — to the microsecond, with the id breaking ties: a millisecond
        // cursor skipped every photo stored later in the same millisecond.
        params.push(cursorPriority, cursorCreatedAt, cursorPhotoId);
        query += ` AND (p.priority, p.created_at, p.id) < ($${params.length - 2}, $${params.length - 1}::timestamptz, $${params.length}::uuid)`;
      } else {
        params.push(cursorPriority, cursorCreatedAt);
        query += ` AND (p.priority, p.created_at) < ($${params.length - 1}, $${params.length})`;
      }
    }

    params.push(limit);
    query += ` ORDER BY p.priority DESC, p.created_at DESC, p.id DESC LIMIT $${params.length};`;

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
    // N-79 — piped with no error handler, a storage error part way through
    // was an unhandled 'error' event, which ends the process; and a browser
    // that went away left the storage stream, an R2 socket or a file handle,
    // open. Not stream.pipeline: it destroys the response too, so a failure
    // before the first byte could not still be answered with a 500.
    stream.on('error', (err) => {
      console.error('[Photos] preview stream error:', errorLabel(err));
      // Once bytes have gone there is no status left to send: the response is
      // cut off, which the browser shows as a broken image.
      if (res.headersSent) res.destroy();
      else res.status(500).json({ error: 'Internal server error' });
    });
    res.on('close', () => stream.destroy());
    stream.pipe(res);
  } catch (err) {
    console.error('[Photos] preview error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});
