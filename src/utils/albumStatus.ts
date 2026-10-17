/**
 * Whether an album has closed to new content (N-159): its `expiresAt` has
 * passed. The server refuses anything new on a closed album on its own; this
 * lets the screen say so before a guest tries. No deadline means never.
 */
export function isAlbumClosed(expiresAt: string | null | undefined, now: number = Date.now()): boolean {
  if (!expiresAt) return false;
  const closesAt = new Date(expiresAt).getTime();
  return !Number.isNaN(closesAt) && closesAt <= now;
}
