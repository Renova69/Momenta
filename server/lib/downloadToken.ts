import jwt from 'jsonwebtoken';
import { CONFIG } from './config';

/**
 * Short-lived, single-purpose tokens for authenticated file downloads.
 *
 * A browser cannot attach an `Authorization` header to a plain `<a href>`, so the
 * only way to stream a protected file straight to disk is to put a credential in
 * the URL. Fetching into a Blob avoids that — but holds the whole archive in
 * memory, which for a wedding exported at original quality is gigabytes and
 * simply fails on a phone.
 *
 * This is deliberately narrower than the ingest keys, which are refused from
 * query strings entirely: an ingest key is long-lived and grants *write* access,
 * whereas this token expires in minutes, is bound to one event and one user, and
 * only permits reading something that user already owns.
 */

const DOWNLOAD_TOKEN_TTL_SECONDS = 300; // 5 minutes

export interface DownloadTokenPayload {
  purpose: 'export-zip';
  eventId: string;
  userId: string;
}

export function issueDownloadToken(eventId: string, userId: string): { token: string; expiresIn: number } {
  const payload: DownloadTokenPayload = { purpose: 'export-zip', eventId, userId };
  const token = jwt.sign(payload, CONFIG.JWT_SECRET, { expiresIn: DOWNLOAD_TOKEN_TTL_SECONDS });
  return { token, expiresIn: DOWNLOAD_TOKEN_TTL_SECONDS };
}

/**
 * Verify a download token against the event it claims to cover.
 * Returns the owning user id, or null when the token is missing, expired,
 * for a different event, or not a download token at all.
 */
export function verifyDownloadToken(token: string | undefined, eventId: string): string | null {
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET, { algorithms: ['HS256'] }) as Partial<DownloadTokenPayload>;

    // A host's ordinary session JWT must not work here, and a token for one
    // event must not unlock another.
    if (decoded.purpose !== 'export-zip') return null;
    if (decoded.eventId !== eventId) return null;
    if (!decoded.userId) return null;

    return decoded.userId;
  } catch {
    return null;
  }
}
