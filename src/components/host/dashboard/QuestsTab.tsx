/**
 * The photo-quest builder: the add form and the list of existing quests.
 *
 * Split out of `HostDashboard.tsx` (986 lines, past the project's 800-line
 * ceiling). The markup is unchanged; it reads its state from the dashboard
 * context instead of closing over the parent's scope. The tier gate that
 * decides whether this renders at all stays in `HostDashboard`.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Plus, Trophy, Sparkles, RotateCcw, Check } from 'lucide-react';
import { i18n } from '../../../i18n';
import { QUEST_ICONS } from './questIcons';
import { useHostDashboard } from './context';
import { useQuestLeaderboard } from '../../../hooks/useQuestLeaderboard';
import { QuestLeaderboard } from '../../quests/QuestLeaderboard';

export const QuestsTab: React.FC = () => {
  const {
    event,
    onUpdateEvent,
    handleCreateQuest,
    newQuestDesc,
    newQuestIcon,
    newQuestPoints,
    newQuestTitle,
    quests,
    photos,
    setNewQuestDesc,
    setNewQuestIcon,
    setNewQuestPoints,
    setNewQuestTitle,
  } = useHostDashboard();

  // This tab only mounts once the plan unlocks quests, so it can always fetch.
  const leaderboard = useQuestLeaderboard(event.id, true, quests, photos);

  const [prizeDraft, setPrizeDraft] = useState(event.questPrize || '');
  const [justSaved, setJustSaved] = useState(false);

  /**
   * The "saved" tick clears itself after a moment, and that timer has to be
   * cancellable.
   *
   * Left to run, it fires on an unmounted component when the host saves and
   * immediately switches tab or closes the dashboard. In the browser that is a
   * harmless no-op; under jsdom the callback lands after teardown and throws
   * `ReferenceError: window is not defined`, which fails CI as an unhandled
   * error while every test still reports passing. That is exactly how the same
   * leak in ReactionBar was found, and it cost a red build to notice.
   */
  const savedTimer = useRef<number | undefined>(undefined);

  const clearSavedTimer = (): void => {
    if (savedTimer.current !== undefined) {
      window.clearTimeout(savedTimer.current);
      savedTimer.current = undefined;
    }
  };

  const flashSaved = (): void => {
    // Re-armed rather than stacked: saving twice quickly would otherwise leave
    // the first timer to clear the tick while the second save is still fresh.
    clearSavedTimer();
    setJustSaved(true);
    savedTimer.current = window.setTimeout(() => {
      savedTimer.current = undefined;
      setJustSaved(false);
    }, 2500);
  };

  useEffect(() => clearSavedTimer, []);

  useEffect(() => {
    setPrizeDraft(event.questPrize || '');
  }, [event.questPrize]);

  const handleSavePrize = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = prizeDraft.trim();
    onUpdateEvent({ questPrize: trimmed || null });
    flashSaved();
  };

  const handleResetPrize = () => {
    setPrizeDraft('');
    onUpdateEvent({ questPrize: null });
    flashSaved();
  };

  return (
    <div className="space-y-6">
      {/* Grand Prize Announcement Card */}
      <div className="bg-gradient-to-r from-noir-800 via-[#1c1810] to-noir-800 rounded-3xl p-6 border border-gold-400/30 shadow-xl relative overflow-hidden">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gold-400/20 border border-gold-400/40 flex items-center justify-center text-gold-400 shadow-glow">
              <Trophy className="w-5 h-5" />
            </div>
            <div>
              <h4 className="font-serif text-lg font-bold text-cream-100">{i18n.t('quests.grand_prize')}</h4>
              <p className="text-xs text-cream-400/80">{i18n.t('quests.prize_hint')}</p>
            </div>
          </div>

          {justSaved && (
            <div className="flex items-center gap-1.5 text-xs text-sage-400 font-medium self-end sm:self-center animate-fade-in">
              <Check className="w-4 h-4" />
              <span>{i18n.t('quests.prize_saved')}</span>
            </div>
          )}
        </div>

        <form onSubmit={handleSavePrize} className="mt-4 space-y-3">
          <div>
            <label htmlFor="quest-prize" className="block text-[11px] text-cream-300 mb-1 font-medium">
              {i18n.t('quests.prize_label')}
            </label>
            <textarea
              id="quest-prize"
              rows={2}
              // UpdateEventSchema refuses anything longer, and a refused save
              // is rolled back after the tick has already said "saved".
              maxLength={500}
              value={prizeDraft}
              onChange={(e) => setPrizeDraft(e.target.value)}
              placeholder={i18n.t('quests.default_prize')}
              className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 placeholder:text-cream-400/50 focus:outline-none focus:border-gold-400 leading-relaxed"
            />
          </div>

          <div className="flex items-center justify-between gap-3 pt-1">
            <button
              type="button"
              onClick={handleResetPrize}
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl border border-cream-400/20 hover:border-cream-400/40 text-cream-300 hover:text-cream-100 text-xs transition-colors"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              <span>{i18n.t('quests.reset_prize')}</span>
            </button>

            <button
              type="submit"
              className="flex items-center gap-1.5 px-5 py-2 rounded-xl bg-gold-400 text-noir-900 font-bold text-xs shadow-glow hover:brightness-110 transition-all"
            >
              <Sparkles className="w-3.5 h-3.5 text-noir-900" />
              <span>{i18n.t('quests.save_prize')}</span>
            </button>
          </div>
        </form>
      </div>

      {/* The TV wall is a photo album first: the board joins it only when
          the host says so, and the change reaches a running wall live. */}
      <div className="flex items-center justify-between p-3.5 rounded-2xl bg-noir-900/60 border border-cream-400/10">
        <div className="pr-3">
          <span className="text-xs font-semibold text-cream-100 block">{i18n.t('host.tv_leaderboard_label')}</span>
          <span className="text-[11px] text-cream-400/70">{i18n.t('host.tv_leaderboard_hint')}</span>
        </div>
        <button
          aria-label={i18n.t('host.tv_leaderboard_label')}
          aria-pressed={!!event.showTvLeaderboard}
          onClick={() => onUpdateEvent({ showTvLeaderboard: !event.showTvLeaderboard })}
          className={`shrink-0 w-12 h-6 rounded-full transition-colors relative p-0.5 ${
            event.showTvLeaderboard ? 'bg-gold-400' : 'bg-noir-700'
          }`}
        >
          <div
            className={`w-5 h-5 rounded-full bg-noir-900 transition-transform ${
              event.showTvLeaderboard ? 'translate-x-6' : 'translate-x-0'
            }`}
          />
        </button>
      </div>

      <QuestLeaderboard entries={leaderboard} hint={i18n.t('leaderboard.host_hint')} />

      {/* Add New Quest Form */}
      <div className="bg-noir-800/90 rounded-3xl p-6 border border-cream-400/10">
        <h4 className="font-serif text-lg font-bold text-cream-100 mb-4 flex items-center gap-2">
          <Plus className="w-5 h-5 text-gold-400" />
          <span>{i18n.t('ui.host_dashboard.15')}</span>
        </h4>

        <form onSubmit={handleCreateQuest} className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          <div className="sm:col-span-5">
            <label className="block text-[11px] text-cream-300 mb-1">{i18n.t('ui.host_dashboard.16')}</label>
            <input
              type="text"
              required
              value={newQuestTitle}
              onChange={(e) => setNewQuestTitle(e.target.value)}
              placeholder={i18n.t('host.quest_title_example')}
              className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
            />
          </div>

          <div className="sm:col-span-7">
            <label className="block text-[11px] text-cream-300 mb-1">{i18n.t('ui.host_dashboard.17')}</label>
            <input
              type="text"
              value={newQuestDesc}
              onChange={(e) => setNewQuestDesc(e.target.value)}
              placeholder={i18n.t('host.quest_desc_example')}
              className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
            />
          </div>

          <div className="sm:col-span-4">
            <label className="block text-[11px] text-cream-300 mb-1">{i18n.t('quest.icon_label')}</label>
            <select
              value={newQuestIcon}
              onChange={(e) => setNewQuestIcon(e.target.value)}
              className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
            >
              {QUEST_ICONS.map((icon) => (
                <option key={icon.value} value={icon.value}>
                  {i18n.t(icon.labelKey)}
                </option>
              ))}
            </select>
          </div>

          <div className="sm:col-span-4">
            <label className="block text-[11px] text-cream-300 mb-1">{i18n.t('quest.points_label')}</label>
            <input
              type="number"
              min={5}
              max={100}
              step={5}
              value={newQuestPoints}
              onChange={(e) => {
                // Clamp here rather than trusting the spinner: a pasted value
                // bypasses min/max entirely.
                const parsed = Number.parseInt(e.target.value, 10);
                setNewQuestPoints(Number.isNaN(parsed) ? 5 : Math.min(100, Math.max(5, parsed)));
              }}
              className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
            />
          </div>

          <div className="sm:col-span-4 flex items-end">
            <button
              type="submit"
              className="w-full py-2.5 rounded-xl bg-gold-400 text-noir-900 font-bold text-xs shadow-glow hover:brightness-110"
            >
              {i18n.t('ui.host_dashboard.18')}
            </button>
          </div>
        </form>
      </div>

      {/* Existing Quests List */}
      <div className="space-y-3">
        <h4 className="font-serif text-lg font-bold text-cream-100">
          {i18n.t('host.active_quests', { count: quests.length })}
        </h4>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {quests.map((q) => (
            <div
              key={q.id}
              className="p-4 rounded-2xl bg-noir-800 border border-cream-400/10 flex items-center justify-between"
            >
              <div>
                <h5 className="font-serif text-sm font-bold text-cream-100">{q.title}</h5>
                <p className="text-xs text-cream-300/80">{q.description}</p>
                <span className="text-[11px] text-gold-400 font-semibold mt-1 inline-block">
                  +{q.points} {i18n.t('quests.pts')} • {q.completedByGuestIds.length}{' '}
                  {i18n.t('quests.done').toLowerCase()}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
