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
 *
 * Every vertical size is in `vh`, like the photo slide's `max-h-[70vh]`. In
 * fixed units the slide was taller than the space between the wall's top and
 * bottom bars on a 720p screen, which clipped the title and the prize — the
 * two lines that say what the list is for. In `vh` it fits at 720p and simply
 * grows on a larger screen. The prize is clamped to two lines because the host
 * may write up to 500 characters.
 */
export const ProjectorLeaderboard: React.FC<ProjectorLeaderboardProps> = ({ entries, prize }) => (
  <div className="w-full max-w-3xl rounded-3xl bg-noir-900/85 backdrop-blur-md border border-gold-400/30 shadow-2xl px-8 py-[3vh] animate-fade-in">
    <div className="flex items-center justify-center gap-3 mb-[2vh]">
      <Crown className="w-[4.5vh] h-[4.5vh] text-gold-400" />
      <h2 className="font-serif text-[4.5vh] leading-none font-bold text-cream-100">{i18n.t('leaderboard.title')}</h2>
    </div>

    <ol className="space-y-[1.2vh]">
      {entries.map((entry) => (
        <li
          key={entry.guestId}
          className="flex items-center gap-5 px-5 py-[0.8vh] rounded-2xl bg-black/40 border border-white/10"
        >
          <span
            className={`w-[5.5vh] h-[5.5vh] rounded-full flex items-center justify-center text-[2.4vh] font-bold shrink-0 ${rankBadgeClass(
              entry.rank
            )}`}
          >
            {entry.rank}
          </span>
          <img
            src={avatarFor(entry)}
            alt=""
            className="w-[5.5vh] h-[5.5vh] rounded-full border-2 border-gold-400/40 object-cover shrink-0"
          />
          <span className="flex-1 min-w-0 font-serif text-[3.4vh] font-bold text-cream-100 truncate">{entry.name}</span>
          <span className="font-serif text-[4vh] font-bold text-gold-300 tabular-nums shrink-0">
            {entry.points}
            <span className="ml-1.5 text-[1.8vh] font-sans font-semibold text-gold-400/80">{i18n.t('quests.pts')}</span>
          </span>
        </li>
      ))}
    </ol>

    <div className="mt-[2vh] flex items-start justify-center gap-3 text-center">
      <Trophy className="w-[2.6vh] h-[2.6vh] text-gold-400 shrink-0 mt-0.5" />
      <p className="text-[2.2vh] text-cream-200/90 font-serif italic max-w-xl line-clamp-2">
        {prize || i18n.t('quests.default_prize')}
      </p>
    </div>
  </div>
);
