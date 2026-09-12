import { Router } from 'express';
import { z } from 'zod';
import { pool } from '../lib/db';
import { validateBody, validateQuery } from '../middleware/validate';
import { uploadLimiter } from '../middleware/rateLimit';
import { errorLabel } from '../lib/errors';
import { RESERVED_DEVICE_FINGERPRINTS, issueGuestToken } from '../lib/guestAuth';

export const guestsRouter = Router();

// [FIX M-1] Added max-length to all fields
const RegisterGuestSchema = z.object({
  eventId: z.string().uuid('A valid eventId is required'),
  name: z.string().min(1, 'name is required').max(100),
  tableNumber: z.string().max(50).optional(),
  avatarUrl: z.string().max(1000).optional(),
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
  const { eventId, name, tableNumber, avatarUrl, deviceFingerprint } = req.body;

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
          avatarUrl || `https://api.dicebear.com/7.x/micah/svg?seed=${encodeURIComponent(name.trim())}`,
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
          avatarUrl || `https://api.dicebear.com/7.x/micah/svg?seed=${encodeURIComponent(name.trim())}`,
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
