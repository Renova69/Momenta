import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import { pool } from '../lib/db';
import { CONFIG } from '../lib/config';
import { requireAuth } from '../middleware/auth';
import { validateBody, validateQuery } from '../middleware/validate';
import { uploadLimiter } from '../middleware/rateLimit';
import { requireUuidParams } from '../middleware/uuid';
import { generateIngestKey, hashIngestKey, validateIngestKey, extractIngestKeyFromRequest } from '../lib/ingest';
import { ingestPhoto, IngestedPhoto } from '../lib/ingestPipeline';
import { errorLabel } from '../lib/errors';

export const ingestRouter = Router();

interface IngestFile {
  buffer: Buffer;
  originalname: string;
  mimetype?: string;
  size: number;
}

// Files land in memory before being written out one at a time (ingestPipeline).
// At MAX_UPLOAD_SIZE_MB=50 a 200-file cap let one request hold 10GB of buffers
// at once — an easy heap-exhaustion DoS for anyone holding a valid ingest key
// (SEC-M1). Processing itself is already sequential (one sharp pipeline at a
// time, see the loop below), so the real ceiling is what multer buffers
// before the handler even runs — 20 files still meant up to 1GB in memory
// per request (MED-04). 10 halves that worst case; a real DSLR tethering
// batch chunks across multiple ingest calls anyway.
const MAX_INGEST_FILES = 10;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: CONFIG.MAX_UPLOAD_SIZE_MB * 1024 * 1024, files: MAX_INGEST_FILES },
});

const CreateKeySchema = z.object({
  // M9 — as a bare string this reached Postgres as `22P02 invalid input syntax
  // for type uuid` and surfaced as a 500. Every other route with an id uses
  // requireUuidParams for the same reason; this one takes it in the body.
  eventId: z.string().uuid('A valid eventId is required'),
  label: z.string().max(100).optional(),
});

const ListKeysQuerySchema = z.object({
  eventId: z.string().uuid('A valid eventId query parameter is required'),
});

// POST /api/ingest/keys — create/rotate an ingest key for an event (host only)
ingestRouter.post('/keys', requireAuth, validateBody(CreateKeySchema), async (req, res) => {
  const { eventId, label } = req.body;

  try {
    const eventCheck = await pool.query('SELECT host_user_id FROM events WHERE id = $1', [eventId]);
    if (eventCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (eventCheck.rows[0].host_user_id !== req.user!.userId) {
      return res.status(403).json({ error: 'Forbidden: You do not own this event' });
    }

    const rawKey = generateIngestKey();
    const keyHash = hashIngestKey(rawKey);
    const insert = await pool.query(
      `INSERT INTO photographer_ingest_keys (event_id, label, key_hash)
       VALUES ($1, $2, $3)
       RETURNING id, event_id as "eventId", label, created_at as "createdAt",
                 last_used_at as "lastUsedAt", expires_at as "expiresAt", revoked_at as "revokedAt"`,
      [eventId, label?.trim() || 'Photographer', keyHash]
    );

    // The plaintext key is returned exactly once.
    res.status(201).json({ ...insert.rows[0], key: rawKey });
  } catch (err) {
    console.error('[Ingest] key create error:', errorLabel(err));
    res.status(500).json({ error: 'Failed to create ingest key' });
  }
});

// GET /api/ingest/keys?eventId= — list keys (host only), masked
ingestRouter.get('/keys', requireAuth, validateQuery(ListKeysQuerySchema), async (req, res) => {
  const { eventId } = req.query as unknown as { eventId: string };

  try {
    const eventCheck = await pool.query('SELECT host_user_id FROM events WHERE id = $1', [eventId]);
    if (eventCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }
    if (eventCheck.rows[0].host_user_id !== req.user!.userId) {
      return res.status(403).json({ error: 'Forbidden: You do not own this event' });
    }

    const { rows } = await pool.query(
      `SELECT id, event_id as "eventId", label, created_at as "createdAt",
              last_used_at as "lastUsedAt", expires_at as "expiresAt", revoked_at as "revokedAt",
              substring(key_hash from 1 for 10) AS masked
       FROM photographer_ingest_keys
       WHERE event_id = $1
       ORDER BY created_at DESC`,
      [eventId]
    );
    res.json(rows);
  } catch (err) {
    console.error('[Ingest] key list error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// DELETE /api/ingest/keys/:id — revoke an ingest key (host only)
ingestRouter.delete('/keys/:id', requireAuth, requireUuidParams('id'), async (req, res) => {
  const keyId = String(req.params.id);

  try {
    const keyCheck = await pool.query(
      `SELECT k.event_id, e.host_user_id
       FROM photographer_ingest_keys k
       JOIN events e ON e.id = k.event_id
       WHERE k.id = $1`,
      [keyId]
    );
    if (keyCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Key not found' });
    }
    if (keyCheck.rows[0].host_user_id !== req.user!.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }

    await pool.query('UPDATE photographer_ingest_keys SET revoked_at = NOW() WHERE id = $1', [keyId]);
    res.json({ success: true, keyId });
  } catch (err) {
    console.error('[Ingest] key revoke error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/ingest/:eventId/photos — secured multipart upload (ingest key auth)
ingestRouter.post('/:eventId/photos', uploadLimiter, requireUuidParams('eventId'), upload.array('file', MAX_INGEST_FILES), async (req, res) => {
  const eventId = String(req.params.eventId);
  const files = (req.files || []) as unknown as IngestFile[];

  try {
    const eventCheck = await pool.query('SELECT id FROM events WHERE id = $1', [eventId]);
    if (eventCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Event not found' });
    }

    const rawKey = extractIngestKeyFromRequest(req);
    const keyId = await validateIngestKey(eventId, rawKey || '');
    if (!keyId) {
      return res.status(401).json({ error: 'Invalid or missing ingest key' });
    }

    if (!Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files uploaded' });
    }

    const photographerName = (req.body?.photographerName as string)?.trim() || 'Official Photographer';
    const caption = (req.body?.caption as string)?.trim() || null;

    // Configured public base, never the request Host header — the resulting URL
    // is persisted on the photo row.
    const baseUrl = CONFIG.PUBLIC_BASE_URL;

    const created: IngestedPhoto[] = [];
    const rejected: { file: string; reason: string }[] = [];

    for (const file of files) {
      if (!file || !file.buffer || !file.mimetype) continue;
      const outcome = await ingestPhoto(eventId, file.buffer, file.originalname, file.mimetype, {
        baseUrl,
        photographerName,
        caption: caption ?? undefined,
      });

      if (outcome.ok) {
        created.push(outcome.photo);
        continue;
      }

      if (outcome.reason === 'tier_limit') {
        // The event's allowance is exhausted; the rest of the batch will fail too.
        rejected.push({ file: file.originalname, reason: outcome.message });
        break;
      }
      rejected.push({ file: file.originalname, reason: 'Not a supported image file' });
    }

    if (created.length === 0 && rejected.length > 0) {
      return res.status(400).json({ error: rejected[0].reason, uploaded: 0, rejected });
    }

    res.status(201).json({ success: true, uploaded: created.length, photos: created, rejected });
  } catch (err) {
    console.error('[Ingest] photo upload error:', errorLabel(err));
    res.status(500).json({ error: 'Failed to ingest photos' });
  }
});
