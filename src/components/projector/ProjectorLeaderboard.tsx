import React from 'react';
import { Crown, Trophy } from 'lucide-react';
import { i18n } from '../../i18n';
import { QuestLeaderboardEntry } from '../../types';
import { avatarFor, rankBadgeClass } from '../quests/leaderboardStyle';

interface ProjectorLeaderboardProps {
  entries: QuestLeaderboardEntry[];
  /** The host's grand prize; null falls back to the localized default. */
  prize?: string | null;
}

/**
 * The leaderboard as a slide on the TV wall: a handful of rows, large enough
 * to read across a room, with the prize underneath as the reason to play.
 */
export const ProjectorLeaderboard: React.FC<ProjectorLeaderboardProps> = ({ entries, prize }) => (
  <div className="w-full max-w-3xl rounded-3xl bg-noir-900/85 backdrop-blur-md border border-gold-400/30 shadow-2xl p-8 sm:p-10 animate-fade-in">
    <div className="flex items-center justify-center gap-3 mb-8">
      <Crown className="w-9 h-9 text-gold-400" />
      <h2 className="font-serif text-4xl sm:text-5xl font-bold text-cream-100">{i18n.t('leaderboard.title')}</h2>
    </div>

    <ol className="space-y-3">
      {entries.map((entry) => (
        <li
          key={entry.guestId}
          className="flex items-center gap-5 px-5 py-3 rounded-2xl bg-black/40 border border-white/10"
        >
          <span
            className={`w-12 h-12 rounded-full flex items-center justify-center text-xl font-bold shrink-0 ${rankBadgeClass(
              entry.rank
            )}`}
          >
            {entry.rank}
          </span>
          <img
            src={avatarFor(entry)}
            alt=""
            className="w-14 h-14 rounded-full border-2 border-gold-400/40 object-cover shrink-0"
          />
          <span className="flex-1 min-w-0 font-serif text-2xl sm:text-3xl font-bold text-cream-100 truncate">
            {entry.name}
          </span>
          <span className="font-serif text-3xl sm:text-4xl font-bold text-gold-300 tabular-nums shrink-0">
            {entry.points}
            <span className="ml-1.5 text-base font-sans font-semibold text-gold-400/80">{i18n.t('quests.pts')}</span>
          </span>
        </li>
      ))}
    </ol>

    <div className="mt-8 flex items-start justify-center gap-3 text-center">
      <Trophy className="w-6 h-6 text-gold-400 shrink-0 mt-0.5" />
      <p className="text-lg text-cream-200/90 font-serif italic max-w-xl">
        {prize || i18n.t('quests.default_prize')}
      </p>
    </div>
  </div>
);
