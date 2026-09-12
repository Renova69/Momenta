import React from 'react';
import { ActiveView, GuestTab, HostUser } from '../../types';
import { i18n } from '../../i18n';
import {
  Layers,
  Trophy,
  Camera,
  Mic,
  LayoutDashboard
} from 'lucide-react';

interface BottomNavProps {
  activeView: ActiveView;
  activeGuestTab: GuestTab;
  onSelectTab: (tab: GuestTab) => void;
  onSelectView: (view: ActiveView) => void;
  onOpenCapture: () => void;
  photosCount?: number;
  questsCount?: number;
  audioCount?: number;
  pendingCount?: number;
  currentHostUser?: HostUser | null;
}

export const BottomNav: React.FC<BottomNavProps> = ({
  activeView,
  activeGuestTab,
  onSelectTab,
  onSelectView,
  onOpenCapture,
  questsCount = 0,
  audioCount = 0,
  pendingCount = 0,
}) => {
  return (
    <div className="sm:hidden fixed bottom-0 left-0 right-0 z-40 bg-noir-900/95 backdrop-blur-xl border-t border-gold-400/20 px-2 py-1.5 pb-[max(0.5rem,env(safe-area-inset-bottom))] shadow-2xl">
      <div className="flex items-center justify-around relative">
        
        {/* 1. Feed / Moments */}
        <button
          onClick={() => {
            if (activeView !== 'guest') onSelectView('guest');
            onSelectTab('feed');
          }}
          className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition-all flex-1 ${
            activeView === 'guest' && activeGuestTab === 'feed'
              ? 'text-gold-400 font-bold'
              : 'text-cream-400/70 hover:text-cream-200'
          }`}
        >
          <div className="relative">
            <Layers className="w-5 h-5" />
          </div>
          <span className="text-[10px] mt-0.5 tracking-tight">{i18n.t('feed.all_moments')}</span>
        </button>

        {/* 2. Quests / Challenges */}
        <button
          onClick={() => {
            if (activeView !== 'guest') onSelectView('guest');
            onSelectTab('quests');
          }}
          className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition-all flex-1 ${
            activeView === 'guest' && activeGuestTab === 'quests'
              ? 'text-gold-400 font-bold'
              : 'text-cream-400/70 hover:text-cream-200'
          }`}
        >
          <div className="relative">
            <Trophy className="w-5 h-5" />
            {questsCount > 0 && (
              <span className="absolute -top-1 -right-2 px-1 py-0.2 bg-gold-400 text-noir-900 text-[8px] font-bold rounded-full">
                {questsCount}
              </span>
            )}
          </div>
          <span className="text-[10px] mt-0.5 tracking-tight">{i18n.t('feed.quests')}</span>
        </button>

        {/* 3. CENTER FLOATING SHUTTER BUTTON (FAB) */}
        <div className="flex flex-col items-center justify-center -mt-6 px-1 flex-1">
          <button
            onClick={onOpenCapture}
            className="w-13 h-13 rounded-full bg-gradient-to-tr from-gold-500 to-gold-400 text-noir-900 flex items-center justify-center shadow-glow border-2 border-noir-900 active:scale-90 transition-transform"
            title={i18n.t('camera.title')}
          >
            <Camera className="w-6 h-6" />
          </button>
          <span className="text-[9px] font-bold text-gold-300 mt-1 uppercase tracking-wider">
            {i18n.t('nav.snap_photo')}
          </span>
        </div>

        {/* 4. Audio Guestbook */}
        <button
          onClick={() => {
            if (activeView !== 'guest') onSelectView('guest');
            onSelectTab('audio');
          }}
          className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition-all flex-1 ${
            activeView === 'guest' && activeGuestTab === 'audio'
              ? 'text-gold-400 font-bold'
              : 'text-cream-400/70 hover:text-cream-200'
          }`}
        >
          <div className="relative">
            <Mic className="w-5 h-5" />
            {audioCount > 0 && (
              <span className="absolute -top-1 -right-2 px-1 py-0.2 bg-gold-400 text-noir-900 text-[8px] font-bold rounded-full">
                {audioCount}
              </span>
            )}
          </div>
          <span className="text-[10px] mt-0.5 tracking-tight">{i18n.t('hero.audio_toast')}</span>
        </button>

        {/* 5. Host Studio / More */}
        <button
          onClick={() => {
            if (activeView === 'host') {
              onSelectView('guest');
            } else {
              onSelectView('host');
            }
          }}
          className={`flex flex-col items-center justify-center py-1 px-2 rounded-xl transition-all flex-1 ${
            activeView === 'host'
              ? 'text-gold-400 font-bold'
              : 'text-cream-400/70 hover:text-cream-200'
          }`}
        >
          <div className="relative">
            <LayoutDashboard className="w-5 h-5" />
            {pendingCount > 0 && (
              <span className="absolute -top-1 -right-2 px-1 py-0.2 bg-rosewood-500 text-white text-[8px] font-bold rounded-full animate-pulse">
                {pendingCount}
              </span>
            )}
          </div>
          <span className="text-[10px] mt-0.5 tracking-tight">
            {activeView === 'host' ? i18n.t('nav.guest_app') : i18n.t('nav.host_studio')}
          </span>
        </button>

      </div>
    </div>
  );
};
