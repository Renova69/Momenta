import jwt from 'jsonwebtoken';
import { CONFIG } from './config';

/**
 * Fingerprints the server itself assigns to non-guest identities. A client
 * claiming one of these as its own `deviceFingerprint` would upsert straight
 * into that row's name/table via the `ON CONFLICT (event_id,
 * device_fingerprint) DO UPDATE` pattern used wherever a guest is resolved —
 * `ingestPipeline.ts:85` creates the photographer guest with exactly
 * 'photographer' (SEC-A2).
 */
export const RESERVED_DEVICE_FINGERPRINTS = new Set(['photographer', 'system']);

interface GuestTokenPayload {
  purpose: 'guest';
  guestId: string;
  eventId: string;
  /**
   * The guests.token_version this token was minted at (migration 023).
   * Optional because tokens issued before that migration carry none; those
   * read as 0, which is also the column default, so they keep working until
   * the host actually resets sessions.
   */
  v?: number;
}

// Long-lived — a wedding album stays live for months (up to a year on
// Deluxe Keepsake), and a guest re-opening the link weeks later should not
// be treated as a stranger claiming someone else's identity.
const GUEST_TOKEN_TTL = '400d';

/** Issue a token binding a browser to the specific guest row it just created or resolved. */
export function issueGuestToken(guestId: string, eventId: string, tokenVersion = 0): string {
  const payload: GuestTokenPayload = { purpose: 'guest', guestId, eventId, v: Number(tokenVersion) || 0 };
  return jwt.sign(payload, CONFIG.JWT_SECRET, { expiresIn: GUEST_TOKEN_TTL });
}

/**
 * True when `token` was issued for exactly this guestId + eventId pair.
 * A missing or mismatched token means the caller has not proven they are
 * the guest they claim to be — every route that attributes an action to a
 * guestId (likes, comments, quest completions, audio entries, uploads) must
 * check this before trusting a client-supplied guestId (SEC-A2).
 */
export function verifyGuestToken(
  token: unknown,
  guestId: string,
  eventId: string,
  currentTokenVersion = 0
): boolean {
  if (typeof token !== 'string' || !token) return false;
  try {
    const decoded = jwt.verify(token, CONFIG.JWT_SECRET, { algorithms: ['HS256'] }) as Partial<GuestTokenPayload>;
    if (decoded.purpose !== 'guest' || decoded.guestId !== guestId || decoded.eventId !== eventId) return false;
    // M10 — a host-initiated reset bumps guests.token_version, so every token
    // minted before it stops verifying here. Callers pass the version from the
    // guest row they already had to load anyway, so this costs no extra query.
    return (Number(decoded.v) || 0) === (Number(currentTokenVersion) || 0);
  } catch {
    return false;
  }
}
