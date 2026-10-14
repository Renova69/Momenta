import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../lib/db';
import { validateBody, validateQuery } from '../middleware/validate';
import { uploadLimiter } from '../middleware/rateLimit';
import { requireUuidParams } from '../middleware/uuid';
import { acquireEventUploadLock } from '../middleware/tierGate';
import { errorLabel } from '../lib/errors';
import { RESERVED_DEVICE_FINGERPRINTS, issueGuestToken } from '../lib/guestAuth';
import { verifyGuestOwnership } from '../lib/guestIdentity';
import { buildAvatar } from '../lib/images';
import { decodeDataUrl, isStoredAvatarUrl, saveBuffer, storageAdapter, toAbsoluteUrl, toStoragePath } from '../lib/storage';

export const guestsRouter = Router();

// [FIX M-1] Added max-length to all fields
const RegisterGuestSchema = z.object({
  eventId: z.string().uuid('A valid eventId is required'),
  name: z.string().min(1, 'name is required').max(100),
  tableNumber: z.string().max(50).optional(),
  // N-107 — accepted and ignored. The onboarding modal sent the selfie itself
  // here, as a data: URL, and a 1,000-character cap refused the whole
  // registration: the guest was never created and every later action failed.
  // A guest's picture is now set only by POST /:id/avatar, so an old client
  // still sending one joins without it rather than being refused.
  avatarUrl: z.string().optional(),
  deviceFingerprint: z.string().max(200).optional(),
}).refine((data) => !data.deviceFingerprint || !RESERVED_DEVICE_FINGERPRINTS.has(data.deviceFingerprint), {
  message: 'deviceFingerprint is reserved',
  path: ['deviceFingerprint'],
});

const LookupGuestQuerySchema = z.object({
  eventId: z.string().uuid('A valid eventId is required'),
  deviceFingerprint: z.string().min(1, 'deviceFingerprint is required').max(200),
});

// 1. POST /api/guests — [FIX H-3] Added rate limiting
guestsRouter.post('/', uploadLimiter, validateBody(RegisterGuestSchema), async (req, res) => {
  const { eventId, name, tableNumber, deviceFingerprint } = req.body;
  // Never the client's (N-107): only the avatar route writes a picture. NULL
  // here leaves a returning guest's stored one in place (the COALESCE below).
  const avatarUrl = null;

  try {
    let guest;

    // identityProven (SEC-03): a plain POST here is the "join the wedding"
    // flow and needs no prior proof — a brand-new row is inherently this
    // caller's own. But when deviceFingerprint matches an EXISTING row
    // (ON CONFLICT), the caller has only demonstrated they know a
    // client-generated, non-secret fingerprint value, not that they are
    // that guest — issuing a fresh guestToken there would hand anyone who
    // knows a leaked fingerprint a durable credential for someone else's
    // identity. `xmax = 0` is the standard Postgres tell for "this row was
    // just INSERTed, not reached via the ON CONFLICT UPDATE branch."
    let identityProven = true;
    // M10 - mint at the row's current version so a later reset invalidates it.
    let tokenVersion = 0;
    if (deviceFingerprint) {
      const upsert = await pool.query(
        `INSERT INTO guests (event_id, name, table_number, avatar_url, device_fingerprint)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (event_id, device_fingerprint) WHERE device_fingerprint IS NOT NULL
         DO UPDATE SET
           name = EXCLUDED.name,
           table_number = COALESCE(EXCLUDED.table_number, guests.table_number),
           avatar_url = COALESCE(EXCLUDED.avatar_url, guests.avatar_url)
         RETURNING id, event_id as "eventId", name, avatar_url as "avatarUrl", table_number as "tableNumber", is_vip as "isVip", created_at as "createdAt", token_version, (xmax = 0) AS inserted`,
        [
          eventId,
          name.trim(),
          tableNumber?.trim() || null,
          avatarUrl,
          deviceFingerprint,
        ]
      );
      const { inserted, token_version: version, ...guestFields } = upsert.rows[0];
      guest = guestFields;
      identityProven = inserted;
      tokenVersion = Number(version) || 0;
    } else {
      const inserted = await pool.query(
        `INSERT INTO guests (event_id, name, table_number, avatar_url, device_fingerprint)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, event_id as "eventId", name, avatar_url as "avatarUrl", table_number as "tableNumber", is_vip as "isVip", created_at as "createdAt"`,
        [
          eventId,
          name.trim(),
          tableNumber?.trim() || null,
          avatarUrl,
          null,
        ]
      );
      guest = inserted.rows[0];
    }

    res.status(201).json({
      ...guest,
      ...(identityProven ? { guestToken: issueGuestToken(guest.id, eventId, tokenVersion) } : {}),
    });
  } catch (err) {
    console.error('[Guests] POST error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

// 2. GET /api/guests (SEC-06) — the "[FIX M-10]" comment this replaced
// claimed rate limiting was already here; it wasn't — only the global
// apiLimiter (3000 req/min) covered this route, far looser than a sensitive
// identity-lookup endpoint warrants. Same uploadLimiter as POST /.
guestsRouter.get('/', uploadLimiter, validateQuery(LookupGuestQuerySchema), async (req, res) => {
  const { deviceFingerprint, eventId } = req.query as unknown as {
    deviceFingerprint: string;
    eventId: string;
  };

  try {
    const { rows } = await pool.query(
      `SELECT id, event_id as "eventId", name, avatar_url as "avatarUrl", table_number as "tableNumber", is_vip as "isVip", created_at as "createdAt"
       FROM guests
       WHERE event_id = $1 AND device_fingerprint = $2
       LIMIT 1`,
      [eventId, deviceFingerprint]
    );

    if (rows.length === 0) {
      return res.status(404).json({ error: 'Guest not found' });
    }

    // SEC-03: a pure fingerprint lookup with zero other proof must never
    // hand back a usable credential for the matched guest — anyone who
    // supplies a known (non-secret, client-generated) fingerprint would
    // otherwise walk away with a durable token for someone else's identity.
    res.json(rows[0]);
  } catch (err) {
    console.error('[Guests] GET error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

const AvatarSchema = z.object({
  eventId: z.string().uuid('A valid eventId is required'),
  guestToken: z.string().max(2000).optional(),
  image: z.string().min(1, 'image is required').startsWith('data:image/', 'image must be a data:image/ URL'),
});

/**
 * 3. POST /api/guests/:id/avatar — store a guest's selfie (N-107).
 *
 * The selfie used to travel inline as the guest's `avatarUrl`, which no column
 * cap could hold and which, once stored, would have rode along on every photo
 * row in every feed page. It is a file, so it is stored as one: a small square
 * JPEG under the album, its URL written to the guest row, the previous one
 * removed. Only the guest can set it, proven by their token.
 *
 * Written under the album's upload lock and refused while the album is being
 * deleted, the same as a photo (N-47): `purgeEventMedia` lists avatars from the
 * guest rows, so one written after that list would outlive the album.
 * Not counted against the storage allowance — a few kilobytes per guest.
 */
guestsRouter.post(
  '/:id/avatar',
  uploadLimiter,
  requireUuidParams('id'),
  validateBody(AvatarSchema),
  async (req, res) => {
    const guestId = String(req.params.id);
    const { eventId, guestToken, image } = req.body as z.infer<typeof AvatarSchema>;

    try {
      const owner = await verifyGuestOwnership(eventId, guestId, guestToken);
      if (!owner) {
        return res.status(401).json({ error: 'Guest session invalid or expired.', code: 'GUEST_TOKEN_REQUIRED' });
      }

      const decoded = decodeDataUrl(image);
      let picture: Buffer;
      try {
        if (!decoded) throw new Error('empty image');
        picture = await buildAvatar(decoded.buffer);
      } catch {
        return res.status(400).json({ error: 'Not a supported image file', code: 'NOT_AN_IMAGE' });
      }

      const saved = await saveBuffer(picture, 'avatar', '.jpg', 'image/jpeg', eventId);
      const avatarUrl = toAbsoluteUrl(saved.storagePath);

      let previous: string | null = null;
      let written = false;
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        await acquireEventUploadLock(client, eventId);
        const { rows } = await client.query<{ previous: string | null }>(
          `UPDATE guests g SET avatar_url = $1
             FROM guests old, events e
            WHERE g.id = $2 AND g.event_id = $3
              AND old.id = g.id
              AND e.id = g.event_id
              AND (e.deleting_at IS NULL OR e.deleting_at < NOW() - INTERVAL '1 hour')
          RETURNING old.avatar_url AS previous`,
          [avatarUrl, guestId, eventId]
        );
        await client.query('COMMIT');
        written = rows.length > 0;
        previous = rows[0]?.previous ?? null;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw err;
      } finally {
        client.release();
        if (!written) await storageAdapter.delete(saved.storagePath).catch(() => undefined);
      }

      if (!written) {
        return res.status(409).json({ error: 'This album is being deleted.', code: 'DELETION_IN_PROGRESS' });
      }

      // Best-effort: the row already names the new picture, so a file left
      // behind here costs a few kilobytes and is swept with the album.
      if (previous && previous !== avatarUrl && isStoredAvatarUrl(previous, eventId)) {
        await storageAdapter
          .delete(toStoragePath(previous) ?? previous)
          .catch((err) => console.warn('[Guests] could not remove a replaced avatar:', errorLabel(err)));
      }

      res.json({ avatarUrl });
    } catch (err) {
      console.error('[Guests] avatar error:', errorLabel(err));
      res.status(500).json({ error: 'Internal server error' });
    }
  }
);
