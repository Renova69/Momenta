import { Photo, QuestLeaderboardEntry, ScavengerQuest } from '../../types';

/**
 * Where one quest stands for the guest looking at it.
 *
 * - `completed` — it scores.
 * - `awaiting` — it scores, but the photo is still waiting for the host's
 *   approval, and the host can still reject it.
 * - `uploading` — the photo is on this phone but the server has not
 *   confirmed it yet.
 * - `rejected` — the host rejected this guest's photo for it. The guest can
 *   take another.
 * - `not_counted` — ticked on this phone, but no photo backs it: deleted,
 *   never uploaded, or rejected somewhere this phone cannot see. The guest can
 *   take another.
 * - `open` — not attempted.
 */
export type QuestCardState = 'completed' | 'awaiting' | 'uploading' | 'rejected' | 'not_counted' | 'open';

/** An optimistic capture carries this id until the server confirms it (see photoService.addPhoto). */
export const isUnconfirmedPhoto = (photo: Photo): boolean => photo.id.startsWith('photo-');

/**
 * The quests that scored for this guest, per the server, or null while the
 * leaderboard has not loaded. A loaded board with no row for the guest means
 * nothing scored.
 */
export function scoredQuestIds(
  leaderboard: QuestLeaderboardEntry[] | null | undefined,
  guestId: string
): Set<string> | null {
  if (!leaderboard) return null;
  return new Set(leaderboard.find((entry) => entry.guestId === guestId)?.questIds ?? []);
}

/**
 * Decide one card's state from the server's scored list and this phone's own
 * photos.
 *
 * Both are needed. The server is the authority, but its answer lags a fresh
 * upload by a refetch, so a confirmed photo on this phone counts at once — it
 * meets the server's rule by construction: this guest's, for this quest,
 * still present, not rejected. The phone's list, though, is paginated, so an
 * older quest photo may simply not be loaded; the server's list covers that.
 *
 * While the board is still loading, a tick keeps its old meaning rather than
 * flashing "not counted" at a guest who is fine.
 */
export function questCardState(
  quest: ScavengerQuest,
  guestId: string,
  photos: Photo[],
  scored: Set<string> | null
): QuestCardState {
  const mine = photos.filter((p) => p.guestId === guestId && p.questId === quest.id);
  const own = mine.filter((p) => p.status !== 'rejected');
  const confirmed = own.filter((p) => !isUnconfirmedPhoto(p));

  if (confirmed.some((p) => p.status === 'approved' || p.status === 'featured')) return 'completed';
  if (confirmed.some((p) => p.status === 'pending')) return 'awaiting';
  if (scored?.has(quest.id)) return 'completed';
  if (own.length > 0) return 'uploading';
  // Named for what happened when this phone can see it, so the guest is not
  // left to guess why a quest they did stopped counting.
  if (mine.some((p) => p.status === 'rejected')) return 'rejected';

  const claimed = quest.completedByGuestIds.includes(guestId);
  if (!claimed) return 'open';
  return scored === null ? 'completed' : 'not_counted';
}

/** States that earn the quest's points, for the progress count. */
export const isScoringState = (state: QuestCardState): boolean => state === 'completed' || state === 'awaiting';
