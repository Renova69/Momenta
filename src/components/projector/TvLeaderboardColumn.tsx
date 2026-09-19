import React from 'react';
import { Crown, Trophy } from 'lucide-react';
import { i18n } from '../../i18n';
import { QuestLeaderboardEntry } from '../../types';
import { rankBadgeClass } from '../quests/leaderboardStyle';
import { guestAvatarUrl } from '../../utils/avatar';

interface TvLeaderboardColumnProps {
  /** Null while the first fetch is in flight. */
  entries: QuestLeaderboardEntry[] | null;
  /** The host's grand prize; null falls back to the localized default. */
  prize?: string | null;
}

/** As many rows as read comfortably from the back of the room. */
const TV_LEADERBOARD_ROWS = 5;

/**
 * The quest leaderboard as a narrow column beside the photos on the TV wall,
 * shown only when the host has switched it on.
 *
 * It sits beside the slideshow rather than interrupting it: the wall is a
 * photo album first, and on a 16:9 screen most photos, portrait ones
 * especially, leave the space at the sides empty anyway. Text is sized in
 * `vh`, like the photo's `max-h-[70vh]`, so it reads the same from the back of
 * the room on a 720p screen and on a 1080p one. Hidden below `lg`, where there
 * is no room beside a photo.
 *
 * The frame stays while the first fetch is in flight, so the photos do not
 * jump sideways when the rows arrive. If nobody has scored, the column shows
 * an invitation instead: the host asked for the board, so it is there to
 * start the game.
 */
export const TvLeaderboardColumn: React.FC<TvLeaderboardColumnProps> = ({ entries, prize }) => (
  <aside
    aria-labelledby="tv-leaderboard-title"
    className="hidden lg:flex flex-col shrink-0 w-[clamp(250px,22vw,340px)] my-[3vh] mr-6 rounded-3xl bg-noir-900/85 backdrop-blur-md border border-gold-400/30 shadow-2xl p-5 animate-fade-in"
  >
    <div className="flex items-center gap-2.5 mb-[2vh]">
      <Crown className="w-[3vh] h-[3vh] text-gold-400 shrink-0" />
      <h2 id="tv-leaderboard-title" className="font-serif text-[3vh] leading-none font-bold text-cream-100">
        {i18n.t('leaderboard.title')}
      </h2>
    </div>

    {entries !== null && entries.length === 0 && (
      <p className="text-[1.8vh] text-cream-300/80 font-serif italic">{i18n.t('leaderboard.empty')}</p>
    )}

    {entries !== null && entries.length > 0 && (
      <ol className="space-y-[1vh]">
        {entries.slice(0, TV_LEADERBOARD_ROWS).map((entry) => (
          <li
            key={entry.guestId}
            className="flex items-center gap-3 px-3 py-[0.8vh] rounded-2xl bg-black/40 border border-white/10"
          >
            <span
              className={`w-[3.6vh] h-[3.6vh] rounded-full flex items-center justify-center text-[1.7vh] font-bold shrink-0 ${rankBadgeClass(
                entry.rank
              )}`}
            >
              {entry.rank}
            </span>
            <img
              src={guestAvatarUrl(entry.avatarUrl, entry.name)}
              alt=""
              className="w-[3.6vh] h-[3.6vh] rounded-full border border-gold-400/40 object-cover shrink-0"
            />
            <span className="flex-1 min-w-0 font-serif text-[2.1vh] font-bold text-cream-100 truncate">{entry.name}</span>
            <span className="font-serif text-[2.4vh] font-bold text-gold-300 tabular-nums shrink-0">{entry.points}</span>
          </li>
        ))}
      </ol>
    )}

    <div className="mt-auto pt-[2vh] flex items-start gap-2">
      <Trophy className="w-[2vh] h-[2vh] text-gold-400 shrink-0 mt-0.5" />
      <p className="text-[1.6vh] text-cream-200/90 font-serif italic line-clamp-3">
        {prize || i18n.t('quests.default_prize')}
      </p>
    </div>
  </aside>
);
