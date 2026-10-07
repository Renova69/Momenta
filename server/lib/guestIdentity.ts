import { pool } from './db';
import { isValidUuid } from './validation';
import { verifyGuestToken, RESERVED_DEVICE_FINGERPRINTS } from './guestAuth';

/** The same cap the route schemas put on a fingerprint. */
const MAX_FINGERPRINT_LENGTH = 200;

function isUsableFingerprint(fingerprint: string): boolean {
  return fingerprint.length <= MAX_FINGERPRINT_LENGTH && !RESERVED_DEVICE_FINGERPRINTS.has(fingerprint);
}

/**
 * Who is this request acting as?
 *
 * H8 — the guest-facing write endpoints (photo comments, quest completions)
 * used to answer that question by INSERTing a brand-new `guests` row whenever
 * the caller could not prove an identity. Every unproven request therefore
 * created a row, `guests` has no quota, and the comment endpoint had no rate
 * limiter beyond the global API ceiling. Anyone holding a public event slug
 * could fill a host's guest list with ghosts and grow the table without bound.
 *
 * Anonymous participation is not the problem and stays supported. Minting a
 * fresh identity *per request* is. This resolves, in order:
 *
 *   1. A verified guest token — the caller proved who they are.
 *   2. A device fingerprint matching a row this event already has — enough to
 *      attribute the action to the right guest, which is the whole point of
 *      the fingerprint fallback.
 *   3. A device fingerprint with no match — one row, for that device.
 *
 * A caller offering neither gets `null`, and the route asks it to identify
 * itself rather than handing it a new identity. Row creation is therefore
 * bounded by devices per event, not by requests.
 *
 * `identityProven` carries the SEC-03 rule through unchanged: a fingerprint is
 * client-generated and not secret, so matching one is enough to attribute an
 * action but must never be enough to be issued a durable credential for that
 * identity. Only a verified token, or a row created fresh in this very
 * request, counts as proof.
 */
export interface ResolvedGuest {
  guestId: string;
  name: string;
  /** The row's current guests.token_version, for minting a token at (M10). */
  tokenVersion: number;
  identityProven: boolean;
}

export interface ResolveGuestOptions {
  eventId: string;
  guestId?: string;
  guestToken?: string;
  deviceFingerprint?: string;
  /** Name to give a row created here. Ignored when an existing guest is matched. */
  fallbackName?: string;
}

/** A guest row whose ownership this request has actually proven. */
export interface GuestOwnership {
  guestId: string;
  name: string;
  /** The row's current `token_version`, for minting a token at (M10). */
  tokenVersion: number;
}

/**
 * Does this caller own the guest id they are claiming?
 *
 * One SELECT, one token check, one version read — the whole of "prove you are
 * this guest", in one place.
 *
 * It lives here because it was previously written out twice: once in this file
 * and once in `routes/photos/upload.ts`, which has its own resolver with
 * deliberately different *write* semantics (it may rename a guest and create
 * one where none exists; this path must do neither — SEC-A2 and H8). Those
 * differences are real and stay separate. This part was identical, and being
 * identical in two places is exactly how it came to be wrong in two places:
 * mutation testing found the same two defects — an ownership check that could
 * be satisfied without a token, and a `token_version` silently read as 0 — in
 * both copies, in separate sweeps, weeks apart.
 *
 * Returning null covers both failure modes on purpose. "No such guest in this
 * event" and "wrong token" are the same answer to the caller — an id it has
 * not proven — and collapsing them here removes the possibility of a caller
 * checking one and forgetting the other.
 */
export async function verifyGuestOwnership(
  eventId: string,
  guestId: string,
  guestToken: unknown
): Promise<GuestOwnership | null> {
  const { rows } = await pool.query<{ id: string; name: string; token_version: number }>(
    'SELECT id, name, token_version FROM guests WHERE id = $1 AND event_id = $2',
    [guestId, eventId]
  );
  if (rows.length === 0) return null;
  if (!verifyGuestToken(guestToken, guestId, eventId, rows[0].token_version)) return null;

  return {
    guestId: rows[0].id,
    name: rows[0].name,
    tokenVersion: Number(rows[0].token_version) || 0,
  };
}

/**
 * The guest a request already belongs to, without creating one: the row its
 * token proves, else the row its device already has. For answering a replayed
 * upload before any check or write (N-78).
 */
export async function findGuestIdentity(options: ResolveGuestOptions): Promise<ResolvedGuest | null> {
  const { eventId, guestId, guestToken, deviceFingerprint } = options;
  if (guestId && isValidUuid(guestId)) {
    const owned = await verifyGuestOwnership(eventId, guestId, guestToken);
    if (owned) return { ...owned, identityProven: true };
  }
  if (deviceFingerprint && isUsableFingerprint(deviceFingerprint)) {
    const { rows } = await pool.query<{ id: string; name: string; token_version: number }>(
      'SELECT id, name, token_version FROM guests WHERE event_id = $1 AND device_fingerprint = $2 LIMIT 1',
      [eventId, deviceFingerprint]
    );
    if (rows[0]) {
      return {
        guestId: rows[0].id,
        name: rows[0].name,
        tokenVersion: Number(rows[0].token_version) || 0,
        identityProven: false,
      };
    }
  }
  return null;
}

export async function resolveGuestIdentity(options: ResolveGuestOptions): Promise<ResolvedGuest | null> {
  const { eventId, guestId, guestToken, deviceFingerprint, fallbackName } = options;

  // 1. A token proves identity outright — and is scoped to this event, so a
  //    token minted for another wedding proves nothing here (SEC-D3/SEC-A2).
  //
  //    The row is loaded BEFORE the token is checked, because verification now
  //    needs its token_version (M10). That is the same query as before, just
  //    reordered and one column wider — no extra round trip.
  if (guestId && isValidUuid(guestId)) {
    const owned = await verifyGuestOwnership(eventId, guestId, guestToken);
    if (owned) {
      return { ...owned, identityProven: true };
    }
  }

  // 2/3. Fingerprint: attribute to this device's existing row, or create the
  //      one row that device gets. A reserved value ('photographer', the FTP
  //      ingest row's key) or an oversized one identifies no guest: the route
  //      schemas refuse both, but this is the one place every route shares,
  //      and the audio route has no schema for its header.
  if (deviceFingerprint && isUsableFingerprint(deviceFingerprint)) {
    const upsert = await pool.query<{ id: string; name: string; token_version: number; inserted: boolean }>(
      `INSERT INTO guests (event_id, name, device_fingerprint)
       VALUES ($1, $2, $3)
       ON CONFLICT (event_id, device_fingerprint) WHERE device_fingerprint IS NOT NULL
       DO UPDATE SET name = guests.name
       RETURNING id, name, token_version, (xmax = 0) AS inserted`,
      [eventId, fallbackName?.trim() || 'Guest', deviceFingerprint]
    );
    const row = upsert.rows[0];
    // Deliberately `name = guests.name`, not EXCLUDED.name: this request has
    // not proven it owns the matched row, so it must not be able to rename
    // someone else's guest just by knowing their fingerprint (SEC-A2). The
    // upload path may rename because a name change there is the guest editing
    // their own profile; a comment is not.
    //
    // xmax = 0 is the standard Postgres tell for "this row was just INSERTed",
    // as opposed to reached through the ON CONFLICT branch — a genuinely fresh
    // row is inherently this caller's own.
    return {
      guestId: row.id,
      name: row.name,
      tokenVersion: Number(row.token_version) || 0,
      identityProven: row.inserted,
    };
  }

  // Neither: nothing here identifies anyone.
  return null;
}
