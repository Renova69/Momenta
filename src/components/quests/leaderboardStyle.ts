import { QuestLeaderboardEntry } from '../../types';

/** Gold, silver and bronze for the podium; everyone else shares one style. */
const PODIUM: Record<number, string> = {
  1: 'bg-gold-400 text-noir-900 shadow-glow',
  2: 'bg-cream-200 text-noir-900',
  3: 'bg-[#b87b4b] text-noir-900',
};

export function rankBadgeClass(rank: number): string {
  return PODIUM[rank] || 'bg-noir-800 text-cream-300 border border-cream-400/20';
}

/** The guest's own picture, or the same generated face the photo wall uses. */
export function avatarFor(entry: Pick<QuestLeaderboardEntry, 'avatarUrl' | 'name'>): string {
  return entry.avatarUrl || `https://api.dicebear.com/7.x/micah/svg?seed=${encodeURIComponent(entry.name)}`;
}
