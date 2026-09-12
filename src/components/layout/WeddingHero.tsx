import React from 'react';
import { WeddingEvent, Guest, Photo, ScavengerQuest, AudioGuestbookEntry } from '../../types';
import { THEMES } from '../../config/themes';
import { i18n } from '../../i18n';
import { isFeatureUnlocked } from '../../config/tierGating';
import { LockedFeatureBadge } from '../common/LockedFeatureBadge';
import { formatEuDateLong } from '../../utils/date';
import {
  MapPin,
  Calendar,
  Camera,
  Users,
  Trophy,
  Mic,
  Heart
} from 'lucide-react';

interface WeddingHeroProps {
  event: WeddingEvent;
  guests: Guest[];
  photos: Photo[];
  quests: ScavengerQuest[];
  audioEntries: AudioGuestbookEntry[];
  onOpenCapture: () => void;
  onOpenAudio: () => void;
  onOpenQuests: () => void;
}

export const WeddingHero: React.FC<WeddingHeroProps> = ({
  event,
  guests,
  photos,
  quests,
  audioEntries,
  onOpenCapture,
  onOpenAudio,
  onOpenQuests,
}) => {
  const theme = THEMES[event.themePalette];

  // Calculate stats
  const approvedPhotos = photos.filter((p) => p.status === 'approved' || p.status === 'featured');
  const completedQuestsCount = quests.reduce(
    (acc, q) => acc + (q.completedByGuestIds.length > 0 ? 1 : 0),
    0
  );

  // Format event date according to EU locale
  const formattedDate = formatEuDateLong(event.eventDate);

  return (
    <div className="relative overflow-hidden rounded-2xl sm:rounded-3xl mb-4 sm:mb-8 border border-gold-400/20 bg-gradient-to-b from-noir-800/90 to-noir-900 shadow-2xl">
      {/* Background Hero Image with Dark Vignette */}
      <div className="absolute inset-0 z-0">
        <img
          src={event.coverImageUrl}
          alt={event.title}
          className="w-full h-full object-cover object-center opacity-35 filter blur-[1px] scale-105"
        />
        <div className="absolute inset-0 bg-gradient-to-t from-noir-900 via-noir-900/80 to-noir-900/40" />
      </div>

      {/* Decorative Content */}
      <div className="relative z-10 px-4 py-6 sm:px-12 sm:py-14 text-center max-w-4xl mx-auto">
        
        {/* Top Floating Badge */}
        <div className="inline-flex items-center gap-1.5 px-3 py-0.5 rounded-full bg-gold-400/15 border border-gold-400/30 text-gold-300 text-[10px] sm:text-xs tracking-widest uppercase font-semibold mb-2 sm:mb-4 shadow-sm">
          <Heart className="w-3 h-3 text-gold-400 fill-gold-400" />
          <span className="truncate max-w-[240px] sm:max-w-none">{event.title}</span>
          <Heart className="w-3 h-3 text-gold-400 fill-gold-400" />
        </div>

        {/* Main Couple Names in Serif */}
        <h1 className="font-serif text-3xl sm:text-6xl font-bold tracking-tight text-cream-100 mb-2 sm:mb-4 drop-shadow-md">
          {event.hostName}
        </h1>

        {/* Event Details: Date & Venue */}
        <div className="flex flex-wrap items-center justify-center gap-2.5 sm:gap-6 text-cream-300/85 text-[11px] sm:text-sm font-medium mb-3 sm:mb-6">
          <div className="flex items-center gap-1">
            <Calendar className="w-3.5 h-3.5 text-gold-400 shrink-0" />
            <span className="capitalize">{formattedDate}</span>
          </div>
          <span className="text-gold-400/60">•</span>
          <div className="flex items-center gap-1">
            <MapPin className="w-3.5 h-3.5 text-gold-400 shrink-0" />
            <span className="truncate max-w-[180px] sm:max-w-none">{event.venueName}</span>
          </div>
        </div>

        {/* Welcome Message */}
        <p className="text-cream-200/90 text-xs sm:text-base font-serif italic max-w-2xl mx-auto mb-5 sm:mb-8 leading-relaxed line-clamp-3 sm:line-clamp-none">
          "{event.welcomeMessage}"
        </p>

        {/* Primary Call-to-Actions for Guests */}
        <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-center gap-2.5 sm:gap-4 mb-6 sm:mb-10">
          <button
            onClick={onOpenCapture}
            className={`flex items-center justify-center gap-2 px-6 py-3 rounded-2xl ${theme.buttonPrimary} text-xs sm:text-sm font-bold shadow-glow hover:scale-105 active:scale-95 transition-all`}
          >
            <Camera className="w-4 h-4 sm:w-5 sm:h-5" />
            <span>{i18n.t('hero.take_photo')}</span>
          </button>

          <div className="grid grid-cols-2 sm:flex items-center gap-2 sm:gap-4">
            <button
              onClick={onOpenQuests}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2.5 sm:px-5 sm:py-3.5 rounded-2xl bg-noir-800/90 hover:bg-noir-700 text-cream-100 border border-gold-400/30 text-xs sm:text-sm font-medium hover:border-gold-400/60 transition-all shadow-md"
            >
              <Trophy className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-gold-400" />
              <span>{i18n.t('feed.quests')} ({completedQuestsCount}/{quests.length})</span>
              {!isFeatureUnlocked(event.planTier, 'scavenger_quests') && (
                <LockedFeatureBadge feature="scavenger_quests" compact />
              )}
            </button>

            <button
              onClick={onOpenAudio}
              className="flex items-center justify-center gap-1.5 px-3.5 py-2.5 sm:px-5 sm:py-3.5 rounded-2xl bg-noir-800/90 hover:bg-noir-700 text-cream-100 border border-gold-400/30 text-xs sm:text-sm font-medium hover:border-gold-400/60 transition-all shadow-md"
            >
              <Mic className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-gold-400" />
              <span>{i18n.t('hero.audio_toast')} ({audioEntries.length})</span>
              {!isFeatureUnlocked(event.planTier, 'audio_guestbook') && (
                <LockedFeatureBadge feature="audio_guestbook" compact />
              )}
            </button>
          </div>
        </div>

        {/* Live Counters Banner */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 sm:gap-3 max-w-3xl mx-auto pt-4 sm:pt-6 border-t border-cream-400/10">
          <div className="p-2 sm:p-3 rounded-xl sm:rounded-2xl bg-noir-900/60 border border-cream-400/10 backdrop-blur-xs">
            <div className="flex items-center justify-center gap-1 text-gold-400 mb-0.5">
              <Camera className="w-3.5 h-3.5" />
              <span className="font-serif text-lg sm:text-2xl font-bold">{approvedPhotos.length}</span>
            </div>
            <span className="text-[9px] sm:text-[11px] text-cream-300 uppercase tracking-wider block truncate">{i18n.t('hero.moments_captured')}</span>
          </div>

          <div className="p-2 sm:p-3 rounded-xl sm:rounded-2xl bg-noir-900/60 border border-cream-400/10 backdrop-blur-xs">
            <div className="flex items-center justify-center gap-1 text-gold-400 mb-0.5">
              <Users className="w-3.5 h-3.5" />
              <span className="font-serif text-lg sm:text-2xl font-bold">{guests.length}</span>
            </div>
            <span className="text-[9px] sm:text-[11px] text-cream-300 uppercase tracking-wider block truncate">{i18n.t('hero.guests_joined')}</span>
          </div>

          <div className="p-2 sm:p-3 rounded-xl sm:rounded-2xl bg-noir-900/60 border border-cream-400/10 backdrop-blur-xs">
            <div className="flex items-center justify-center gap-1 text-gold-400 mb-0.5">
              <Trophy className="w-3.5 h-3.5" />
              <span className="font-serif text-lg sm:text-2xl font-bold">{completedQuestsCount}</span>
            </div>
            <span className="text-[9px] sm:text-[11px] text-cream-300 uppercase tracking-wider block truncate">{i18n.t('hero.quests_completed')}</span>
          </div>

          <div className="p-2 sm:p-3 rounded-xl sm:rounded-2xl bg-noir-900/60 border border-cream-400/10 backdrop-blur-xs">
            <div className="flex items-center justify-center gap-1 text-gold-400 mb-0.5">
              <Mic className="w-3.5 h-3.5" />
              <span className="font-serif text-lg sm:text-2xl font-bold">{audioEntries.length}</span>
            </div>
            <span className="text-[9px] sm:text-[11px] text-cream-300 uppercase tracking-wider block truncate">{i18n.t('hero.audio_messages')}</span>
          </div>
        </div>

      </div>
    </div>
  );
};
