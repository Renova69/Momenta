/**
 * The host's switch for the quest leaderboard on the TV wall.
 *
 * The wall is a photo album first: the board joins it, in a column beside the
 * photos, only when the host says so. The setting lives on the server
 * (`events.show_tv_leaderboard`, migration 028), so a wall already running at
 * the venue follows the change live.
 */

import React from 'react';
import { i18n } from '../../../i18n';
import { useHostDashboard } from './context';

export const TvLeaderboardToggle: React.FC = () => {
  const { event, onUpdateEvent } = useHostDashboard();
  const isOn = !!event.showTvLeaderboard;

  return (
    <div className="flex items-center justify-between p-3.5 rounded-2xl bg-noir-900/60 border border-cream-400/10">
      <div className="pr-3">
        <span className="text-xs font-semibold text-cream-100 block">{i18n.t('host.tv_leaderboard_label')}</span>
        <span className="text-[11px] text-cream-400/70">{i18n.t('host.tv_leaderboard_hint')}</span>
      </div>
      <button
        aria-label={i18n.t('host.tv_leaderboard_label')}
        aria-pressed={isOn}
        onClick={() => onUpdateEvent({ showTvLeaderboard: !isOn })}
        className={`shrink-0 w-12 h-6 rounded-full transition-colors relative p-0.5 ${isOn ? 'bg-gold-400' : 'bg-noir-700'}`}
      >
        <div
          className={`w-5 h-5 rounded-full bg-noir-900 transition-transform ${isOn ? 'translate-x-6' : 'translate-x-0'}`}
        />
      </button>
    </div>
  );
};
