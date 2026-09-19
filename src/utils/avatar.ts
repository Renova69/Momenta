/**
 * Guest avatars.
 *
 * A guest who never took a selfie still gets a face: a generated one, seeded
 * by their name so it stays the same everywhere they appear — the feed, the
 * audio guestbook, the TV wall, the leaderboard. That only holds while every
 * one of those places builds the URL the same way, which is why this is the
 * only place that does.
 */

/** The generated face for a name. */
export function generatedAvatarUrl(name: string): string {
  return `https://api.dicebear.com/7.x/micah/svg?seed=${encodeURIComponent(name)}`;
}

/** The guest's own picture, or the generated face for their name. */
export function guestAvatarUrl(avatarUrl: string | null | undefined, name: string): string {
  return avatarUrl || generatedAvatarUrl(name);
}
