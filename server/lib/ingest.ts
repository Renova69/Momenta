import crypto from 'crypto';
import { pool } from './db';

export const INGEST_KEY_PREFIX = 'wmi_';

/**
 * Read a photographer ingest key from a request.
 *
 * Header-only by design: a key passed as `?key=` ends up in access logs, proxy
 * history and browser referrers, which is a credential leak that outlives the
 * request.
 */
export function extractIngestKeyFromRequest(req: {
  headers?: Record<string, unknown>;
}): string | null {
  const auth = req.headers?.authorization;
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const token = auth.substring(7).trim();
    // A host JWT also arrives as a Bearer token; only treat prefixed keys as ingest keys.
    if (token.startsWith(INGEST_KEY_PREFIX)) return token;
  }
  const header = req.headers?.['x-ingest-key'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  return null;
}

/** Generate a new photographer ingest key (returned in plaintext only at creation). */
export function generateIngestKey(): string {
  return INGEST_KEY_PREFIX + crypto.randomBytes(32).toString('base64url');
}

/** Hash an ingest key for storage/lookup (only the hash is persisted). */
export function hashIngestKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

/**
 * Validate a raw ingest key against an event. Returns the key row id when valid
 * (not revoked, not expired), otherwise null. Touches `last_used_at` on success.
 */
export async function validateIngestKey(eventId: string, rawKey: string): Promise<string | null> {
  if (!rawKey) return null;
  const keyHash = hashIngestKey(rawKey.trim());

  const res = await pool.query(
    `SELECT id FROM photographer_ingest_keys
     WHERE event_id = $1 AND key_hash = $2 AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
     LIMIT 1`,
    [eventId, keyHash]
  );

  if (res.rows.length === 0) return null;

  await pool
    .query('UPDATE photographer_ingest_keys SET last_used_at = NOW() WHERE id = $1', [res.rows[0].id])
    .catch(() => {});

  return res.rows[0].id;
}
