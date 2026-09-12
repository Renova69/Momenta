/**
 * Storage usage, retention deadline, and the ZIP export of an album.
 *
 * Split out of the former single-file `events.ts` (1073 lines, past the
 * project's 800-line ceiling). Mounted by `events.ts`, which composes the
 * sub-routers in their original registration order.
 */

import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { pool } from '../../lib/db';
import { CONFIG } from '../../lib/config';
import { formatBytes } from '../../lib/planLimits';
import { requireUuidParams } from '../../middleware/uuid';
import { ZipArchive } from 'archiver';
import { storageAdapter, storagePathBelongsToEvent } from '../../lib/storage';
import { requireAuth, optionalAuth } from '../../middleware/auth';
import { requireEventTier, getStorageUsage } from '../../middleware/tierGate';
import { issueDownloadToken, verifyDownloadToken } from '../../lib/downloadToken';
import { errorLabel } from '../../lib/errors';

/**
 * Declared under the name the handlers below were already written with, and
 * re-exported under a distinct one, so every handler body in this file is
 * byte-identical to what it was in the single-file router.
 */
const eventsRouter = Router();
export { eventsRouter as exportRouter };

// GET /api/events/:id/usage — storage position and retention deadline (host only)
eventsRouter.get('/:id/usage', requireAuth, requireUuidParams('id'), async (req, res) => {
  const id = String(req.params.id);

  try {
    const eventRes = await pool.query(
      'SELECT host_user_id, expires_at FROM events WHERE id = $1',
      [id]
    );
    if (eventRes.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (eventRes.rows[0].host_user_id !== req.user!.userId) {
      return res.status(403).json({ error: 'Forbidden: You do not own this event' });
    }

    const usage = await getStorageUsage(id);
    if (!usage) return res.status(404).json({ error: 'Event not found' });

    res.json({
      tier: usage.tier,
      usedBytes: usage.usedBytes,
      limitBytes: usage.limitBytes,
      usedLabel: formatBytes(usage.usedBytes),
      limitLabel: formatBytes(usage.limitBytes),
      percentUsed: Math.min(100, Math.round((usage.usedBytes / usage.limitBytes) * 100)),
      pooled: usage.pooled,
      photoCount: usage.photoCount,
      maxPhotos: usage.maxPhotos,
      expiresAt: eventRes.rows[0].expires_at,
    });
  } catch (err) {
    console.error('[Events] usage error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});


// POST /api/events/:id/export-token — mint a short-lived link for the ZIP download
//
// The browser cannot put an Authorization header on a plain <a href>, and
// fetching the archive into a Blob first holds gigabytes in memory. This hands
// back a five-minute token so the download can stream straight to disk.
eventsRouter.post(
  '/:id/export-token',
  requireAuth,
  requireUuidParams('id'),
  requireEventTier('celebration_pass'),
  async (req, res) => {
    const id = String(req.params.id);

    try {
      const eventRes = await pool.query('SELECT host_user_id, slug FROM events WHERE id = $1', [id]);
      if (eventRes.rows.length === 0) {
        return res.status(404).json({ error: 'Event not found' });
      }
      if (eventRes.rows[0].host_user_id !== req.user!.userId) {
        return res.status(403).json({ error: 'Forbidden: You do not own this event' });
      }

      const { token, expiresIn } = issueDownloadToken(id, req.user!.userId);
      res.json({ token, expiresIn, filename: `${eventRes.rows[0].slug}-memories.zip` });
    } catch (err) {
      console.error('[Events] export-token error:', errorLabel(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);

// GET /api/events/:id/export-zip — Requires auth + ownership + celebration_pass or higher
eventsRouter.get(
  '/:id/export-zip',
  optionalAuth,
  requireUuidParams('id'),
  requireEventTier('celebration_pass'),
  async (req, res) => {
  const id = String(req.params.id);
  try {
    // Either an ordinary host session, or a short-lived download token in the
    // query string so the browser can stream the file without a header.
    const tokenUserId = verifyDownloadToken(
      typeof req.query.token === 'string' ? req.query.token : undefined,
      id
    );
    const requesterId = req.user?.userId || tokenUserId;
    if (!requesterId) {
      return res.status(401).json({ error: 'Unauthorized: host token or download link required' });
    }

    const eventQuery = await pool.query(
      'SELECT title, slug, host_user_id FROM events WHERE id = $1 LIMIT 1',
      [id]
    );
    if (eventQuery.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // [FIX C-4] Verify ownership
    if (eventQuery.rows[0].host_user_id !== requesterId) {
      return res.status(403).json({ error: 'Forbidden: You do not own this event' });
    }

    const event = eventQuery.rows[0];

    // Prefer the untouched original; fall back to the display copy for photos
    // captured before originals were retained (migration 007).
    const photosQuery = await pool.query(
      `SELECT COALESCE(original_storage_path, storage_path) AS storage_path,
              original_storage_path IS NOT NULL AS has_original
         FROM photos WHERE event_id = $1 ORDER BY created_at ASC`,
      [id]
    );
    const audioQuery = await pool.query(
      'SELECT audio_url FROM audio_guestbook WHERE event_id = $1 ORDER BY created_at ASC',
      [id]
    );

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${event.slug}-memories.zip"`);

    // @types/archiver does not describe ZipArchive's constructor options.
    // Photos and audio are already-compressed formats (JPEG/WebP, WebM/MP4);
    // re-running zlib level 9 over them burns CPU for near-zero size gain, so
    // every entry below is appended with `store: true` instead (MED-01).
    // forceZip64 keeps large exports (many files or >4GB total) from
    // producing a corrupt archive once the classic zip32 limits are crossed.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const archive = new (ZipArchive as any)({ zlib: { level: 0 }, forceZip64: true });

    // Once piping starts the status line is already on the wire, so a later
    // failure cannot be reported as JSON — log it and abort the stream instead.
    archive.on('error', (archiveErr: Error) => {
      console.error('[Events] export-zip archive error:', archiveErr.message);
      res.destroy(archiveErr);
    });

    // MED-01: without this, a guest closing the browser mid-download left the
    // handler still reading every remaining photo from storage and pumping it
    // into an archive nobody could receive anymore.
    let aborted = false;
    req.on('close', () => {
      if (!res.writableEnded) {
        aborted = true;
        archive.abort();
      }
    });

    archive.pipe(res);

    // Resolves once archiver has actually consumed this entry (its internal
    // queue runs at concurrency 1), not just once we handed it a stream.
    // Without this the loop below could open every photo's storage stream
    // (R2 connections or fs handles) back-to-back while archiver was still
    // working through the first one — MED-01's backpressure gap.
    const appendAndWait = (source: NodeJS.ReadableStream | string, name: string): Promise<void> =>
      new Promise((resolve, reject) => {
        const onEntry = (entryData: { name: string }) => {
          if (entryData.name === name) {
            cleanup();
            resolve();
          }
        };
        const onError = (err: Error) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          archive.off('entry', onEntry);
          archive.off('error', onError);
        };
        archive.on('entry', onEntry);
        archive.on('error', onError);
        if (typeof source === 'string') {
          archive.file(source, { name, store: true });
        } else {
          archive.append(source, { name, store: true });
        }
      });

    // Append a single file to the archive, first trying the storage adapter stream
    // (local or R2) and falling back to a verified on-disk path.
    const appendFromStorage = async (storagePath: string, archiveName: string) => {
      if (!storagePath || aborted) return;

      // SEC-04 — validated before the adapter ever gets a chance to stream
      // it, not just in the fallback branch below (see storagePathBelongsToEvent).
      if (!storagePathBelongsToEvent(storagePath, id)) {
        console.warn(`[Events] export-zip skipped a path outside its own event: ${storagePath}`);
        return;
      }

      const stream = await storageAdapter.getStream(storagePath);
      if (aborted) return;
      if (stream) {
        await appendAndWait(stream, archiveName);
        return;
      }

      const diskPath = storageAdapter.getAbsolutePath(storagePath);
      if (diskPath) {
        const resolved = path.resolve(diskPath);
        // Scope to this event's own subfolder, not just "somewhere under
        // uploads" — a row's storage_path is untrusted user input at rest, so
        // this is the last line of defense against exporting another event's
        // files (SEC-A1).
        const eventDir = path.resolve(CONFIG.UPLOADS_DIR, 'events', id) + path.sep;
        if (resolved.startsWith(eventDir) && fs.existsSync(resolved)) {
          await appendAndWait(resolved, archiveName);
        }
      }
    };

    for (let i = 0; i < photosQuery.rows.length && !aborted; i++) {
      const p = photosQuery.rows[i];
      const filename = p.storage_path.split('/').pop() || `photo-${i + 1}.jpg`;
      await appendFromStorage(p.storage_path, `photos/photo-${i + 1}-${filename}`);
    }

    for (let i = 0; i < audioQuery.rows.length && !aborted; i++) {
      const url = audioQuery.rows[i].audio_url as string;
      // Local audio is stored as an absolute URL (http://host/uploads/...); extract the
      // internal storage path so the adapter can resolve it. R2 URLs pass through as-is.
      const storagePath = url && url.includes('/uploads/') ? url.substring(url.indexOf('/uploads/')) : url;
      const filename = (storagePath || '').split('/').pop() || `audio-${i + 1}.webm`;
      await appendFromStorage(storagePath, `audio/audio-${i + 1}-${filename}`);
    }

    if (!aborted) {
      await archive.finalize();
    }
  } catch (err) {
    console.error('[Events] export-zip error:', errorLabel(err));
    if (res.headersSent) {
      // The archive was already streaming; ending the response is all we can do.
      res.destroy();
      return;
    }
    res.status(500).json({ error: 'Internal server error' });
  }
});
