/**
 * The photo-quest builder: the add form and the list of existing quests.
 *
 * Split out of `HostDashboard.tsx` (986 lines, past the project's 800-line
 * ceiling). The markup is unchanged; it reads its state from the dashboard
 * context instead of closing over the parent's scope. The tier gate that
 * decides whether this renders at all stays in `HostDashboard`.
 */

import React from 'react';
import { Plus } from 'lucide-react';
import { i18n } from '../../../i18n';
import { QUEST_ICONS } from './questIcons';
import { useHostDashboard } from './context';

export const QuestsTab: React.FC = () => {
  const {
    handleCreateQuest, newQuestDesc, newQuestIcon, newQuestPoints, newQuestTitle,
    quests, setNewQuestDesc, setNewQuestIcon, setNewQuestPoints, setNewQuestTitle,
  } = useHostDashboard();

  return (
    <div className="space-y-6">
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
                  +{q.points} {i18n.t('quests.pts')} • {q.completedByGuestIds.length} {i18n.t('quests.done').toLowerCase()}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
