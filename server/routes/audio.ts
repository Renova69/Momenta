import { Router } from 'express';
import multer from 'multer';
import type { PoolClient } from 'pg';
import { pool } from '../lib/db';
import { CONFIG } from '../lib/config';
import { saveBuffer, toAbsoluteUrl, storageAdapter } from '../lib/storage';
import { checkPhotoUploadTierLimit, checkUploadAllowance, lockAndLoadUploadContext } from '../middleware/tierGate';
import { isValidUuid, detectAudioFormat } from '../lib/validation';
import { uploadLimiter, uploadIpLimiter } from '../middleware/rateLimit';
import { requireEventTier } from '../middleware/tierGate';
import { issueGuestToken } from '../lib/guestAuth';
import { resolveGuestIdentity, findGuestIdentity } from '../lib/guestIdentity';
import { wsManager } from '../ws/wsServer';
import { errorLabel, isUniqueViolation } from '../lib/errors';
import { optionalAuth } from '../middleware/auth';
import { LOCAL_ID_MAX_LENGTH } from './photos/shared';

export const audioRouter = Router();

/**
 * Disposable mode with a reveal still to come: the same rule photos/feed.ts
 * applies. Guests hear nothing of the guestbook until then, neither from the
 * listing nor from the live broadcast of a new message (SEC-07, N-37).
 */
function isDisposableLocked(event: { is_disposable_mode: boolean; reveal_at: Date | string | null }): boolean {
  return !!event.is_disposable_mode && !!event.reveal_at && new Date(event.reveal_at).getTime() > Date.now();
}

// Binary multipart, not base64-in-JSON (P7) — a 60-120s WebM recording
// inflates by ~33% as base64 for no benefit; every other upload path in this
// app (photos, ingest) already streams raw bytes the same way.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.MAX_UPLOAD_SIZE_MB * 1024 * 1024 },
});

// 1. POST /api/audio (Save Audio Recording & Broadcast — Gated to deluxe_keepsake and pro_planner)
// multer runs first so requireEventTier (which reads req.body.eventId) sees
// the parsed multipart fields, exactly like the JSON body it used to read.
/**
 * The recording this guest already stored under this upload id, as the first
 * answer carried it, or null (N-78). A phone replays a message whose answer it
 * never got; when the first attempt had been stored, the replay used to be
 * stored again.
 */
async function findReplayedAudio(eventId: string, guestId: string, localId: string) {
  const { rows } = await pool.query(
    `SELECT a.id, a.event_id as "eventId", a.guest_id as "guestId", a.audio_url as "audioUrl",
            a.duration_seconds as "durationSeconds", a.note, a.created_at as "createdAt",
            g.name as "guestName", g.avatar_url as "guestAvatar"
       FROM audio_guestbook a JOIN guests g ON g.id = a.guest_id
      WHERE a.event_id = $1 AND a.guest_id = $2 AND a.client_upload_id = $3`,
    [eventId, guestId, localId]
  );
  return rows[0] ?? null;
}

/** The answer to a replay: the stored recording, as the first answer would have carried it. */
function audioReplayAnswer(
  stored: Record<string, unknown>,
  localId: string,
  guest: { guestId: string; identityProven: boolean; tokenVersion: number },
  eventId: string
) {
  return {
    ...stored,
    localId,
    ...(guest.identityProven ? { guestToken: issueGuestToken(guest.guestId, eventId, guest.tokenVersion) } : {}),
  };
}

audioRouter.post('/', uploadIpLimiter, uploadLimiter, upload.single('audio'), requireEventTier('deluxe_keepsake'), async (req, res) => {
  const { eventId, guestId, guestName, note, localId, guestToken } = req.body as Record<string, string | undefined>;
  const durationSeconds = Number.parseInt(req.body?.durationSeconds, 10) || 0;

  try {
    if (!eventId || !isValidUuid(eventId)) {
      return res.status(400).json({ error: 'A valid eventId is required' });
    }
    if (!req.file || !req.file.buffer || req.file.buffer.length === 0) {
      return res.status(400).json({ error: 'No audio file uploaded' });
    }
    // N-102 — as the photo schema has it. Unbounded, a long id failed the
    // insert on its unique index with a 500.
    if (localId !== undefined && (typeof localId !== 'string' || localId.length > LOCAL_ID_MAX_LENGTH)) {
      return res.status(400).json({ error: 'Invalid localId' });
    }
    // The actual bytes are checked, not the client-claimed MIME type or an
    // already-hosted URL string handed straight through (SEC-M3). The check is
    // audio-only: it used to share a validator with the image paths and so
    // admitted a JPEG or an iPhone HEIC posted here, which then counted
    // against the event's quota and was broadcast to every guest as an audio
    // message nothing could play (M-3).
    const format = detectAudioFormat(req.file.buffer);
    if (!format) {
      return res.status(400).json({ error: 'Invalid audio data.' });
    }

    const eventCheck = await pool.query('SELECT id, is_disposable_mode, reveal_at FROM events WHERE id = $1', [
      eventId,
    ]);
    if (eventCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    // N-78 — a replay is answered before any check: the recording it carries
    // is already stored and already counted.
    if (localId) {
      const uploader = await findGuestIdentity({
        eventId,
        guestId,
        guestToken,
        deviceFingerprint: req.get('x-device-fingerprint') || undefined,
      });
      const stored = uploader ? await findReplayedAudio(eventId, uploader.guestId, localId) : null;
      if (uploader && stored) return res.status(200).json(audioReplayAnswer(stored, localId, uploader, eventId));
    }

    // Recordings count against the same storage allowance as photos.
    const audioBytes = req.file.buffer.length;
    const storageCheck = await checkPhotoUploadTierLimit(eventId, audioBytes);
    if (!storageCheck.allowed) {
      return res
        .status(403)
        .json({ error: storageCheck.reason, code: storageCheck.code || 'STORAGE_LIMIT_REACHED' });
    }

    // N-57 — the H8 ladder, as comments use it (lib/guestIdentity.ts): a
    // verified token, else this device's existing row, else one row for this
    // device. This route used to create a new guest on every unproven request,
    // and a caller offering neither is now asked to join instead. The device is
    // read from the header only: that is what the rate limiter keys on (multer
    // has not parsed the body when it runs), and identity must not come from a
    // different value than the one being limited. Resolved after the plan's
    // pre-check, so a message the plan refuses leaves no guest behind.
    const deviceFingerprint = req.get('x-device-fingerprint') || undefined;
    const identity = await resolveGuestIdentity({
      eventId,
      guestId,
      guestToken,
      deviceFingerprint,
      fallbackName: guestName,
    });
    if (!identity) {
      return res.status(401).json({
        error: 'Join the wedding before leaving a message.',
        code: 'GUEST_IDENTITY_REQUIRED',
      });
    }
    const validGuestId = identity.guestId;
    const resolvedName = identity.name;
    const avatarRow = await pool.query<{ avatar_url: string | null }>('SELECT avatar_url FROM guests WHERE id = $1', [
      validGuestId,
    ]);
    const resolvedAvatar = avatarRow.rows[0]?.avatar_url ?? null;

    // Save audio file to storage partitioned by eventId
    // Both derived from the bytes that were just validated, never from the
    // client. `req.file.mimetype` was previously written verbatim as the
    // stored object's Content-Type, and the object is served from a public
    // URL — genuine audio bytes declared as `text/html` were served back as a
    // document.
    const saved = await saveBuffer(
      req.file.buffer,
      'audio-message',
      format.extension,
      format.mimeType,
      eventId
    );
    const absoluteAudioUrl = toAbsoluteUrl(saved.storagePath);
    // A refusal below comes after the file is saved; without this it stayed
    // in storage with no row naming it.
    const discardSavedRecording = () =>
      storageAdapter.delete(saved.storagePath).catch((err: unknown) => {
        console.warn(`[Audio] could not discard refused recording ${saved.storagePath}:`, errorLabel(err));
      });

    // Re-check the quota and insert atomically (DB-02, mirrors SEC-D1's fix
    // for photos) — the check above ran against a plain SELECT with no lock,
    // and saving the file took real time, so concurrent audio uploads for
    // the same event could both have read the same stale total and both
    // passed. This is the check that actually has to hold.
    let lockClient: PoolClient;
    try {
      lockClient = await pool.connect();
    } catch (err) {
      await discardSavedRecording();
      throw err;
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let insertedRow: any;
    try {
      await lockClient.query('BEGIN');
      const freshContext = await lockAndLoadUploadContext(lockClient, eventId);
      if (!freshContext) {
        // Gone, or being deleted (N-47): the recording saved above belongs
        // to nothing now.
        await lockClient.query('ROLLBACK');
        await discardSavedRecording();
        return res.status(404).json({ error: 'Event not found' });
      }
      const finalCheck = checkUploadAllowance(freshContext, audioBytes);
      if (!finalCheck.allowed) {
        await lockClient.query('ROLLBACK');
        await discardSavedRecording();
        // N-99 — a second copy of a recording, refused at the limit the first
        // copy has just reached, is answered with the stored one.
        const stored = localId ? await findReplayedAudio(eventId, validGuestId, localId) : null;
        if (localId && stored) return res.status(200).json(audioReplayAnswer(stored, localId, identity, eventId));
        return res
          .status(403)
          .json({ error: finalCheck.reason, code: finalCheck.code || 'STORAGE_LIMIT_REACHED' });
      }

      const result = await lockClient.query(
        `INSERT INTO audio_guestbook (event_id, guest_id, audio_url, duration_seconds, note, storage_bytes, client_upload_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         RETURNING id, event_id as "eventId", guest_id as "guestId", audio_url as "audioUrl", duration_seconds as "durationSeconds", note, created_at as "createdAt"`,
        [eventId, validGuestId, absoluteAudioUrl, durationSeconds, note?.trim() || null, audioBytes, localId || null]
      );
      insertedRow = result.rows[0];

      await lockClient.query('COMMIT');
    } catch (err) {
      await lockClient.query('ROLLBACK').catch(() => undefined);
      // N-86 — whatever stopped the row, the recording saved above names
      // nothing now. Only the two refusals above used to remove it.
      await discardSavedRecording();
      // Two copies of one recording arrived together and the other was stored
      // first (N-78): the answer is the stored one.
      if (!(localId && isUniqueViolation(err, 'idx_audio_client_upload'))) throw err;
      insertedRow = null;
    } finally {
      lockClient.release();
    }
    if (insertedRow === null && localId) {
      const stored = await findReplayedAudio(eventId, validGuestId, localId);
      if (!stored) throw new Error('A recording refused as a duplicate could not be found');
      return res.status(200).json(audioReplayAnswer(stored, localId, identity, eventId));
    }

    const newEntry = {
      ...insertedRow,
      guestName: resolvedName,
      guestAvatar: resolvedAvatar,
      localId,
    };

    // No token in the broadcast — every other guest in the room receives it,
    // and a token there would let any of them impersonate this guest (SEC-A2).
    // While the album is locked only the hosts hear it (N-37); the recording
    // guest has it already, from the response below.
    if (isDisposableLocked(eventCheck.rows[0])) {
      wsManager.broadcastToEventHosts(eventId, 'AUDIO_ADDED', newEntry);
    } else {
      wsManager.broadcastToEvent(eventId, 'AUDIO_ADDED', newEntry);
    }
    // Only when identity was proven this request (SEC-03): a device match
    // onto an existing row is attributed correctly but earns no credential.
    res.status(201).json({
      ...newEntry,
      ...(identity.identityProven ? { guestToken: issueGuestToken(validGuestId, eventId, identity.tokenVersion) } : {}),
    });
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
    if (!isHost && isDisposableLocked(eventRow)) {
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
