import jwt from 'jsonwebtoken';
import { CONFIG } from './config';

/**
 * Short-lived, single-purpose tokens for a host previewing a quarantined
 * photo (MED-03/SEC-M5).
 *
 * A photo pending moderation or still disposable-locked is not served from
 * the public `/uploads` static mount at all (`server/lib/storage.ts`'s
 * quarantine mode) — the only way to preview it is this token-gated stream
 * route, `GET /api/photos/:id/preview`. A browser `<img src>` cannot carry an
 * `Authorization` header, so the token travels in the URL instead; a 1-hour
 * TTL matches "a host reviewing a moderation queue," not the 5-minute ZIP
 * download token's "click and go" pattern — but it is still bound to one
 * photo and one user, and useless for anything else if it leaks.
 */

const PREVIEW_TOKEN_TTL_SECONDS = 3600; // 1 hour

export interface PreviewTokenPayload {
  purpose: 'photo-preview';
  photoId: string;
  userId: string;
}

export function issuePreviewToken(photoId: string, userId: string): string {
  const payload: PreviewTokenPayload = { purpose: 'photo-preview', photoId, userId };
  return jwt.sign(payload, CONFIG.JWT_SECRET, { expiresIn: PREVIEW_TOKEN_TTL_SECONDS });
}

/**
 * Verify a preview token against the photo it claims to cover.
 * Returns the owning user id, or null when the token is missing, expired,
 * for a different photo, or not a preview token at all.
 */
export function verifyPreviewToken(token: string | undefined, photoId: string): string | null {
  if (!token) return null;

  try {
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET, { algorithms: ['HS256'] }) as Partial<PreviewTokenPayload>;

    // A host's ordinary session JWT must not work here (it carries no
    // `purpose`), and a token for one photo must not unlock another.
    if (decoded.purpose !== 'photo-preview') return null;
    if (decoded.photoId !== photoId) return null;
    if (!decoded.userId) return null;

    return decoded.userId;
  } catch {
    return null;
  }
}
