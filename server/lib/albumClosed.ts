/**
 * Whether an album has closed for new content (N-159).
 *
 * Every plan sells a period of active access, recorded as `events.expires_at`
 * (seven days after the wedding on the free plan, none at all on Pro Planner).
 * Nothing read it: an album stayed fully open until the retention sweep
 * deleted it, and that sweep is switched off (U-4). From `expires_at` an album
 * is read-only for guests — looking and downloading stay; new photos, voice
 * messages, comments and reactions stop. A plan bought later moves
 * `expires_at` forward, which opens it again. Deletion is a separate matter,
 * still governed by the retention sweep.
 */

export const ALBUM_CLOSED_CODE = 'ALBUM_CLOSED';

export function isAlbumClosed(expiresAt: Date | string | null | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const closesAt = new Date(expiresAt).getTime();
  return !Number.isNaN(closesAt) && closesAt <= now;
}

/** The refusal sent for anything new on a closed album. */
export function albumClosedRefusal(expiresAt: Date | string | null | undefined) {
  return {
    error: 'This album has closed and takes no new photos, voice messages, comments or reactions.',
    code: ALBUM_CLOSED_CODE,
    closedAt: expiresAt ?? null,
  };
}
