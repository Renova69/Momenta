/**
 * The host's grand prize announcement, shown to guests above the quest list.
 *
 * Split out of `QuestsTab`, which it had pushed well past the project's
 * 50-line function limit.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Trophy, Sparkles, RotateCcw, Check } from 'lucide-react';
import { i18n } from '../../../i18n';
import { QUEST_PRIZE_MAX_LENGTH } from '../../../../shared/eventLimits';
import { useHostDashboard } from './context';

/** How long the "saved" tick stays up. */
const SAVED_TICK_MS = 2500;

export const GrandPrizeEditor: React.FC = () => {
  const { event, onUpdateEvent } = useHostDashboard();
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
    }, SAVED_TICK_MS);
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
    <div className="bg-linear-to-r from-noir-800 via-[#1c1810] to-noir-800 rounded-3xl p-6 border border-gold-400/30 shadow-xl relative overflow-hidden">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-2">
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-xl bg-gold-400/20 border border-gold-400/40 flex items-center justify-center text-gold-400 shadow-glow">
            <Trophy className="w-5 h-5" />
          </div>
          <div>
            <h2 className="font-serif text-lg font-bold text-cream-100">{i18n.t('quests.grand_prize')}</h2>
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
            // The server refuses anything longer, and a refused save is rolled
            // back after the tick has already said "saved".
            maxLength={QUEST_PRIZE_MAX_LENGTH}
            value={prizeDraft}
            onChange={(e) => setPrizeDraft(e.target.value)}
            placeholder={i18n.t('quests.default_prize')}
            className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 placeholder:text-cream-400/50 focus:outline-hidden focus:border-gold-400 leading-relaxed"
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
  );
};
