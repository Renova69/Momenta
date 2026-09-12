/**
 * Dashboard header, plan badge and the six tab buttons.
 *
 * Split out of `HostDashboard.tsx` (986 lines, past the project's 800-line
 * ceiling). The markup is unchanged; it reads its state from the dashboard
 * context instead of closing over the parent's scope.
 */

import React from 'react';
import { LayoutDashboard, Shield, QrCode, Trophy, Download, Eye, KeyRound } from 'lucide-react';
import { i18n } from '../../../i18n';
import { isFeatureUnlocked } from '../../../config/tierGating';
import { LockedFeatureBadge } from '../../common/LockedFeatureBadge';
import { useHostDashboard } from './context';

export const TabNav: React.FC = () => {
  const {
    activeTab, setActiveTab, currentTier, event, onOpenPricing, pendingPhotos,
  } = useHostDashboard();

  return (
    <>

      {/* Header & Sub-Navigation */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-4 bg-noir-800/80 p-3 sm:p-4 rounded-3xl border border-cream-400/10 backdrop-blur-md">
  
        {/* Navigation Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
          <button
            onClick={() => setActiveTab('overview')}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              activeTab === 'overview'
                ? 'bg-gold-400 text-noir-900 shadow-glow font-bold'
                : 'text-cream-300 hover:text-white hover:bg-noir-700'
            }`}
          >
            <LayoutDashboard className="w-4 h-4" />
            <span>{i18n.t('host.overview')}</span>
          </button>

          <button
            onClick={() => setActiveTab('moderation')}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all relative ${
              activeTab === 'moderation'
                ? 'bg-gold-400 text-noir-900 shadow-glow font-bold'
                : 'text-cream-300 hover:text-white hover:bg-noir-700'
            }`}
          >
            <Shield className="w-4 h-4" />
            <span>{i18n.t('host.moderation')}</span>
            {!isFeatureUnlocked(currentTier, 'photo_moderation') ? (
              <LockedFeatureBadge feature="photo_moderation" compact onUpgrade={onOpenPricing} />
            ) : pendingPhotos.length > 0 ? (
              <span className="px-1.5 py-0.2 rounded-full bg-rosewood-500 text-white text-[10px] font-bold">
                {pendingPhotos.length}
              </span>
            ) : null}
          </button>

          <button
            onClick={() => setActiveTab('canvas')}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              activeTab === 'canvas'
                ? 'bg-gold-400 text-noir-900 shadow-glow font-bold'
                : 'text-cream-300 hover:text-white hover:bg-noir-700'
            }`}
          >
            <QrCode className="w-4 h-4" />
            <span>{i18n.t('host.canvas_studio')}</span>
            {!isFeatureUnlocked(currentTier, 'qr_print_studio') && (
              <LockedFeatureBadge feature="qr_print_studio" compact onUpgrade={onOpenPricing} />
            )}
          </button>

          <button
            onClick={() => setActiveTab('quests')}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              activeTab === 'quests'
                ? 'bg-gold-400 text-noir-900 shadow-glow font-bold'
                : 'text-cream-300 hover:text-white hover:bg-noir-700'
            }`}
          >
            <Trophy className="w-4 h-4" />
            <span>{i18n.t('host.quests_mgr')}</span>
            {!isFeatureUnlocked(currentTier, 'scavenger_quests') && (
              <LockedFeatureBadge feature="scavenger_quests" compact onUpgrade={onOpenPricing} />
            )}
          </button>

          <button
            onClick={() => setActiveTab('export')}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              activeTab === 'export'
                ? 'bg-gold-400 text-noir-900 shadow-glow font-bold'
                : 'text-cream-300 hover:text-white hover:bg-noir-700'
            }`}
          >
            <Download className="w-4 h-4" />
            <span>{i18n.t('host.export_zip')}</span>
            {!isFeatureUnlocked(currentTier, 'zip_export') && (
              <LockedFeatureBadge feature="zip_export" compact onUpgrade={onOpenPricing} />
            )}
          </button>

          <button
            onClick={() => setActiveTab('ingest')}
            className={`flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold whitespace-nowrap transition-all ${
              activeTab === 'ingest'
                ? 'bg-gold-400 text-noir-900 shadow-glow font-bold'
                : 'text-cream-300 hover:text-white hover:bg-noir-700'
            }`}
          >
            <KeyRound className="w-4 h-4" />
            <span>Photographer Ingest</span>
          </button>
        </div>

        {/* Live Guest Preview + Photographer Ingest Quick Links */}
        <div className="flex items-center gap-2">
          <button
            onClick={() => setActiveTab('ingest')}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-gold-400/10 border border-gold-400/40 text-gold-300 text-xs font-semibold hover:bg-gold-400/20 transition-colors"
          >
            <KeyRound className="w-3.5 h-3.5" />
            <span>Photographer Ingest</span>
          </button>

          <a
            href={`/e/${event.slug}`}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-noir-900 border border-cream-400/20 text-cream-200 text-xs font-medium hover:border-gold-400/50 transition-colors"
          >
            <Eye className="w-3.5 h-3.5 text-gold-400" />
            <span>{i18n.t('ui.host_dashboard.1')}</span>
          </a>
        </div>
      </div>
    </>
  );
};
