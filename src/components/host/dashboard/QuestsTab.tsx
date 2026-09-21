/**
 * The photo-quest builder: the add form and the list of existing quests.
 *
 * Split out of `HostDashboard.tsx` (986 lines, past the project's 800-line
 * ceiling). The markup is unchanged; it reads its state from the dashboard
 * context instead of closing over the parent's scope. The tier gate that
 * decides whether this renders at all stays in `HostDashboard`.
 */

import React, { useId } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { i18n } from '../../../i18n';
import { QUEST_ICONS } from './questIcons';
import { useHostDashboard } from './context';
import { useQuestLeaderboard } from '../../../hooks/useQuestLeaderboard';
import { QuestLeaderboard } from '../../quests/QuestLeaderboard';
import { GrandPrizeEditor } from './GrandPrizeEditor';
import { TvLeaderboardToggle } from './TvLeaderboardToggle';

export const QuestsTab: React.FC = () => {
  // One id per field, so each visible label points at the control it names.
  const fieldIds = useId();
  const {
    event,
    handleCreateQuest,
    newQuestDesc,
    newQuestIcon,
    newQuestPoints,
    newQuestTitle,
    quests,
    photos,
    onDeleteQuest,
    setNewQuestDesc,
    setNewQuestIcon,
    setNewQuestPoints,
    setNewQuestTitle,
  } = useHostDashboard();

  // This tab only mounts once the plan unlocks quests, so it can always fetch.
  const leaderboard = useQuestLeaderboard(event.id, true, quests, photos);

  return (
    <div className="space-y-6">
      <GrandPrizeEditor />

      <TvLeaderboardToggle />

      <QuestLeaderboard entries={leaderboard} hint={i18n.t('leaderboard.host_hint')} />

      {/* Add New Quest Form */}
      <div className="bg-noir-800/90 rounded-3xl p-6 border border-cream-400/10">
        <h4 className="font-serif text-lg font-bold text-cream-100 mb-4 flex items-center gap-2">
          <Plus className="w-5 h-5 text-gold-400" />
          <span>{i18n.t('ui.host_dashboard.15')}</span>
        </h4>

        <form onSubmit={handleCreateQuest} className="grid grid-cols-1 sm:grid-cols-12 gap-3">
          <div className="sm:col-span-5">
            <label htmlFor={`${fieldIds}-1`} className="block text-[11px] text-cream-300 mb-1">{i18n.t('ui.host_dashboard.16')}</label>
            <input
              id={`${fieldIds}-1`}
              type="text"
              required
              value={newQuestTitle}
              onChange={(e) => setNewQuestTitle(e.target.value)}
              placeholder={i18n.t('host.quest_title_example')}
              className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
            />
          </div>

          <div className="sm:col-span-7">
            <label htmlFor={`${fieldIds}-2`} className="block text-[11px] text-cream-300 mb-1">{i18n.t('ui.host_dashboard.17')}</label>
            <input
              id={`${fieldIds}-2`}
              type="text"
              value={newQuestDesc}
              onChange={(e) => setNewQuestDesc(e.target.value)}
              placeholder={i18n.t('host.quest_desc_example')}
              className="w-full px-3 py-2 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
            />
          </div>

          <div className="sm:col-span-4">
            <label htmlFor={`${fieldIds}-3`} className="block text-[11px] text-cream-300 mb-1">{i18n.t('quest.icon_label')}</label>
            <select
              id={`${fieldIds}-3`}
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
            <label htmlFor={`${fieldIds}-4`} className="block text-[11px] text-cream-300 mb-1">{i18n.t('quest.points_label')}</label>
            <input
              id={`${fieldIds}-4`}
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
              className="p-4 rounded-2xl bg-noir-800 border border-cream-400/10 flex items-center justify-between gap-3"
            >
              <div className="min-w-0">
                <h5 className="font-serif text-sm font-bold text-cream-100">{q.title}</h5>
                <p className="text-xs text-cream-300/80">{q.description}</p>
                <span className="text-[11px] text-gold-400 font-semibold mt-1 inline-block">
                  +{q.points} {i18n.t('quests.pts')} • {q.completedByGuestIds.length}{' '}
                  {i18n.t('quests.done').toLowerCase()}
                </span>
              </div>
              <button
                type="button"
                aria-label={`${i18n.t('host.delete_quest')}: ${q.title}`}
                onClick={() => {
                  // Deleting a quest takes its completions with it, so the
                  // points guests earned on it go too. Worth one question.
                  if (window.confirm(i18n.t('host.delete_quest_confirm', { title: q.title }))) {
                    onDeleteQuest(q.id);
                  }
                }}
                className="shrink-0 p-2 rounded-xl border border-cream-400/10 text-cream-400 hover:text-rosewood-300 hover:border-rosewood-400/40 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
