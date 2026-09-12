import { Router } from 'express';
import multer from 'multer';
import path from 'path';
import { pool } from '../lib/db';
import { CONFIG } from '../lib/config';
import { saveBuffer, toAbsoluteUrl } from '../lib/storage';
import { checkPhotoUploadTierLimit, getUploadContext, checkUploadAllowance, acquireEventUploadLock } from '../middleware/tierGate';
import { isValidUuid, validateMagicBytes } from '../lib/validation';
import { uploadLimiter } from '../middleware/rateLimit';
import { requireEventTier } from '../middleware/tierGate';
import { issueGuestToken, verifyGuestToken } from '../lib/guestAuth';
import { wsManager } from '../ws/wsServer';
import { errorLabel } from '../lib/errors';
import { optionalAuth } from '../middleware/auth';

export const audioRouter = Router();

// Binary multipart, not base64-in-JSON (P7) — a 60-120s WebM recording
// inflates by ~33% as base64 for no benefit; every other upload path in this
// app (photos, ingest) already streams raw bytes the same way.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
});

function extFromMimetype(mimetype: string | undefined): string {
  if (!mimetype) return '.webm';
  if (mimetype.includes('mp4')) return '.mp4';
  if (mimetype.includes('aac') || mimetype.includes('m4a')) return '.m4a';
  if (mimetype.includes('ogg')) return '.ogg';
  return '.webm';
}

// 1. POST /api/audio (Save Audio Recording & Broadcast — Gated to deluxe_keepsake and pro_planner)
// multer runs first so requireEventTier (which reads req.body.eventId) sees
// the parsed multipart fields, exactly like the JSON body it used to read.
audioRouter.post('/', uploadLimiter, upload.single('audio'), requireEventTier('deluxe_keepsake'), async (req, res) => {
  const { eventId, guestId, guestName, guestAvatar, note, localId, guestToken } = req.body as Record<string, string | undefined>;
  const durationSeconds = Number.parseInt(req.body?.durationSeconds, 10) || 0;

  try {
    if (!eventId || !isValidUuid(eventId)) {
      return res.status(400).json({ error: 'A valid eventId is required' });
    }
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }
    // The actual bytes are checked, not the client-claimed MIME type or an
    // already-hosted URL string handed straight through (SEC-M3).
    if (!validateMagicBytes(req.file.buffer)) {
      return res.status(400).json({ error: 'Invalid audio data.' });
    }

    const eventCheck = await pool.query('SELECT id FROM events WHERE id = $1', [eventId]);
    if (eventCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // Ensure guest exists
    let validGuestId = guestId;
    let resolvedName = guestName || 'Guest';
    let resolvedAvatar = guestAvatar || null;
    let guestTokenVersion = 0;

    if (!guestId || !isValidUuid(guestId)) {
      const gInsert = await pool.query(
        'INSERT INTO guests (event_id, name, avatar_url) VALUES ($1, $2, $3) RETURNING id, name, avatar_url',
        [eventId, guestName || 'Guest', guestAvatar || null]
      );
      validGuestId = gInsert.rows[0].id;
      resolvedName = gInsert.rows[0].name;
      resolvedAvatar = gInsert.rows[0].avatar_url;
    } else {
      // Scoped by event_id (SEC-D3) and proven with a token (SEC-A2) — a
      // guestId alone is public, so a mismatch is treated as unknown: mint a
      // fresh guest rather than post to the guestbook as someone else.
      // M10 - load the row first; verification needs its token_version, and
      // this is the same query that was already here.
      const scoped = await pool.query<{ id: string; name: string; avatar_url: string | null; token_version: number }>(
        'SELECT id, name, avatar_url, token_version FROM guests WHERE id = $1 AND event_id = $2',
        [guestId, eventId]
      );
      const guestCheck =
        scoped.rows.length > 0 && verifyGuestToken(guestToken, guestId, eventId, scoped.rows[0].token_version)
          ? scoped
          : { rows: [] as { id: string; name: string; avatar_url: string | null; token_version: number }[] };
      if (guestCheck.rows.length === 0) {
        const gInsert = await pool.query(
          'INSERT INTO guests (event_id, name, avatar_url) VALUES ($1, $2, $3) RETURNING id, name, avatar_url',
          [eventId, guestName || 'Guest', guestAvatar || null]
        );
        validGuestId = gInsert.rows[0].id;
        resolvedName = gInsert.rows[0].name;
        resolvedAvatar = gInsert.rows[0].avatar_url;
      } else {
        resolvedName = guestCheck.rows[0].name;
        resolvedAvatar = guestCheck.rows[0].avatar_url;
        guestTokenVersion = Number(guestCheck.rows[0].token_version) || 0;
      }
    }

    // Recordings count against the same storage allowance as photos.
    const audioBytes = req.file.buffer.length;
    const storageCheck = await checkPhotoUploadTierLimit(eventId, audioBytes);
    if (!storageCheck.allowed) {
      return res
        .status(403)
        .json({ error: storageCheck.reason, code: storageCheck.code || 'STORAGE_LIMIT_REACHED' });
    }

    // Save audio file to storage partitioned by eventId
    const ext = extFromMimetype(req.file.mimetype) || path.extname(req.file.originalname || '') || '.webm';
    const saved = await saveBuffer(req.file.buffer, 'audio-message', ext, req.file.mimetype || 'audio/webm', eventId);
    const absoluteAudioUrl = toAbsoluteUrl(saved.storagePath);

    // Re-check the quota and insert atomically (DB-02, mirrors SEC-D1's fix
    // for photos) — the check above ran against a plain SELECT with no lock,
    // and saving the file took real time, so concurrent audio uploads for
    // the same event could both have read the same stale total and both
    // passed. This is the check that actually has to hold.
    const lockClient = await pool.connect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let insertedRow: any;
    try {
      await lockClient.query('BEGIN');
      await acquireEventUploadLock(lockClient, eventId);

      const freshContext = await getUploadContext(eventId, undefined, lockClient);
      if (!freshContext) {
        await lockClient.query('ROLLBACK');
        return res.status(404).json({ error: 'Event not found' });
      }
      const finalCheck = checkUploadAllowance(freshContext, audioBytes);
      if (!finalCheck.allowed) {
        await lockClient.query('ROLLBACK');
        return res
          .status(403)
          .json({ error: finalCheck.reason, code: finalCheck.code || 'STORAGE_LIMIT_REACHED' });
      }

      const result = await lockClient.query(
        `INSERT INTO audio_guestbook (event_id, guest_id, audio_url, duration_seconds, note, storage_bytes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, event_id as "eventId", guest_id as "guestId", audio_url as "audioUrl", duration_seconds as "durationSeconds", note, created_at as "createdAt"`,
        [eventId, validGuestId, absoluteAudioUrl, durationSeconds, note?.trim() || null, audioBytes]
      );
      insertedRow = result.rows[0];

      await lockClient.query('COMMIT');
    } catch (err) {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      lockClient.release();
    }

    const newEntry = {
      ...insertedRow,
      guestName: resolvedName,
      guestAvatar: resolvedAvatar,
      localId,
    };

    // No token in the broadcast — every other guest in the room receives it,
    // and a token there would let any of them impersonate this guest (SEC-A2).
    wsManager.broadcastToEvent(eventId, 'AUDIO_ADDED', newEntry);
    res.status(201).json({ ...newEntry, guestToken: issueGuestToken(validGuestId!, eventId, guestTokenVersion) });
  } catch (err) {
    console.error('[Error in POST /api/audio]:', errorLabel(err));
    res.status(500).json({ error: 'Failed to save audio recording' });
  }
});

// 2. GET /api/audio (Strictly scoped by eventId)
audioRouter.get('/', optionalAuth, async (req, res) => {
  const eventId = req.query.eventId as string;

  try {
    if (!eventId || !isValidUuid(eventId)) {
      return res.status(400).json({ error: 'A valid eventId query parameter is required' });
    }

    // SEC-07: audio_guestbook has no per-row lock/status of its own (no
    // moderation queue exists for it), but the event-level disposable-mode
    // reveal gate photos already respect (SEC-W4) applies here too — without
    // it, a guest with the event link could read every voice message before
    // the reveal moment the host set up disposable mode for in the first
    // place.
    const eventRes = await pool.query(
      'SELECT host_user_id, is_disposable_mode, reveal_at FROM events WHERE id = $1',
      [eventId]
    );
    if (eventRes.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    const eventRow = eventRes.rows[0];
    const isHost = !!req.user?.userId && eventRow.host_user_id === req.user.userId;
    const disposableLocked =
      !isHost &&
      !!eventRow.is_disposable_mode &&
      !!eventRow.reveal_at &&
      new Date(eventRow.reveal_at).getTime() > Date.now();
    if (disposableLocked) {
      return res.json([]);
    }

    const query = `
      SELECT
        a.id,
        a.event_id as "eventId",
        a.guest_id as "guestId",
        g.name as "guestName",
        g.avatar_url as "guestAvatar",
        a.audio_url as "audioUrl",
        a.duration_seconds as "durationSeconds",
        a.note,
        a.created_at as "createdAt"
      FROM audio_guestbook a
      JOIN guests g ON g.id = a.guest_id
      WHERE a.event_id = $1
      ORDER BY a.created_at DESC;
    `;

    const { rows } = await pool.query(query, [eventId]);
    res.json(rows);
  } catch (err) {
    console.error('[Error in GET /api/audio]:', errorLabel(err));
    res.status(500).json({ error: 'Failed to fetch audio recordings' });
  }
});
