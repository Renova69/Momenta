import React from 'react';
import { Crown } from 'lucide-react';
import { i18n } from '../../i18n';
import { QuestLeaderboardEntry } from '../../types';
import { avatarFor, rankBadgeClass } from './leaderboardStyle';

interface QuestLeaderboardProps {
  entries: QuestLeaderboardEntry[];
  /** The viewing guest: highlighted, and pinned below the list when outside it. */
  currentGuestId?: string;
  /** Rows to show; omitted shows everyone (the host's view). */
  limit?: number;
  /** A line under the title — the host is told what does and does not score. */
  hint?: string;
}

const Row: React.FC<{ entry: QuestLeaderboardEntry; isYou: boolean }> = ({ entry, isYou }) => (
  <li
    className={`flex items-center gap-3 px-3 py-2.5 rounded-2xl border transition-colors ${
      isYou ? 'bg-gold-400/15 border-gold-400/50' : 'bg-noir-900/60 border-cream-400/10'
    }`}
    aria-current={isYou ? 'true' : undefined}
  >
    <span
      className={`w-7 h-7 rounded-full flex items-center justify-center text-xs font-bold shrink-0 ${rankBadgeClass(
        entry.rank
      )}`}
    >
      {entry.rank}
    </span>
    <img
      src={avatarFor(entry)}
      alt=""
      className="w-8 h-8 rounded-full border border-gold-400/30 object-cover shrink-0"
    />
    <div className="flex-1 min-w-0">
      <p className="text-sm font-semibold text-cream-100 truncate">
        {entry.name}
        {isYou && <span className="ml-2 text-[10px] uppercase tracking-wider text-gold-300">{i18n.t('leaderboard.you')}</span>}
      </p>
      <p className="text-[11px] text-cream-400/80">{i18n.t('leaderboard.quests_done', { count: entry.questsCompleted })}</p>
    </div>
    <span className="font-serif text-base font-bold text-gold-300 tabular-nums shrink-0">
      {entry.points} <span className="text-[10px] font-sans font-semibold text-gold-400/80">{i18n.t('quests.pts')}</span>
    </span>
  </li>
);

export const QuestLeaderboard: React.FC<QuestLeaderboardProps> = ({ entries, currentGuestId, limit, hint }) => {
  const shown = limit === undefined ? entries : entries.slice(0, limit);
  const you = currentGuestId ? entries.find((e) => e.guestId === currentGuestId) : undefined;
  const youAreBelow = you !== undefined && !shown.includes(you);

  return (
    <section
      aria-labelledby="quest-leaderboard-title"
      className="bg-noir-800/90 rounded-3xl p-5 sm:p-6 border border-cream-400/10"
    >
      <div className="flex items-center gap-2.5 mb-1">
        <Crown className="w-5 h-5 text-gold-400" />
        <h4 id="quest-leaderboard-title" className="font-serif text-lg font-bold text-cream-100">
          {i18n.t('leaderboard.title')}
        </h4>
      </div>
      {hint && <p className="text-xs text-cream-400/80 mb-3">{hint}</p>}

      {entries.length === 0 ? (
        <p className="text-sm text-cream-300/80 mt-3">{i18n.t('leaderboard.empty')}</p>
      ) : (
        <ol className="space-y-2 mt-3">
          {shown.map((entry) => (
            <Row key={entry.guestId} entry={entry} isYou={entry.guestId === currentGuestId} />
          ))}
          {youAreBelow && (
            <>
              <li aria-hidden="true" className="text-center text-cream-400/60 text-xs leading-none">
                ⋯
              </li>
              <Row entry={you} isYou />
            </>
          )}
        </ol>
      )}
    </section>
  );
};
