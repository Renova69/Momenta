import React, { useState } from 'react';
import { Photo, Guest, PlanTier, PhotoReactionKind } from '../../types';
import { PhotoCard } from './PhotoCard';
import { ReactionBar } from './ReactionBar';
import { i18n } from '../../i18n';
import { FREE_TIER_MAX_PHOTOS } from '../../config/tierGating';
import {
  Sparkles,
  Trophy,
  User,
  Layers,
  Search,
  Camera,
  Crown,
  AlertCircle
} from 'lucide-react';

interface LiveFeedProps {
  photos: Photo[];
  currentGuest: Guest;
  eventPlanTier?: PlanTier;
  onOpenPricing?: () => void;
  onLike: (photoId: string) => void;
  onReact: (photoId: string, reaction: PhotoReactionKind) => void;
  onOpenComments: (photo: Photo) => void;
  onOpenLightbox: (photo: Photo) => void;
  onOpenCapture: () => void;
}

type FeedFilter = 'all' | 'featured' | 'quests' | 'mine';

const LiveFeedComponent: React.FC<LiveFeedProps> = ({
  photos,
  currentGuest,
  eventPlanTier = 'free',
  onOpenPricing,
  onLike,
  onReact,
  onOpenComments,
  onOpenLightbox,
  onOpenCapture,
}) => {
  const [activeFilter, setActiveFilter] = useState<FeedFilter>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [renderedLimit, setRenderedLimit] = useState(20);

  // [FIX H-15] Match only by guestId — name-based matching leaks rejected/pending photos
  // to any guest who shares the same display name (privacy violation)
  const isMyPhoto = (p: Photo) => {
    if (!currentGuest || currentGuest.id === 'anonymous') return false;
    return p.guestId === currentGuest.id;
  };

  const visiblePhotos = photos.filter((p) => p.status === 'approved' || p.status === 'featured' || isMyPhoto(p));

  // Filter by category
  const filteredPhotos = visiblePhotos.filter((p) => {
    if (activeFilter === 'featured') {
      if (p.status !== 'featured') return false;
    } else if (activeFilter === 'quests') {
      if (!p.questId) return false;
    } else if (activeFilter === 'mine') {
      if (!isMyPhoto(p)) return false;
    }

    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      const matchName = p.guestName.toLowerCase().includes(q);
      const matchCaption = p.caption?.toLowerCase().includes(q) || false;
      const matchQuest = p.questTitle?.toLowerCase().includes(q) || false;
      return matchName || matchCaption || matchQuest;
    }

    return true;
  });

  const displayedPhotos = filteredPhotos.slice(0, renderedLimit);
  const isFreeTier = eventPlanTier === 'free';
  const isApproachingLimit = isFreeTier && photos.length >= (FREE_TIER_MAX_PHOTOS - 5);
  const isAtLimit = isFreeTier && photos.length >= FREE_TIER_MAX_PHOTOS;

  return (
    <section className="space-y-6">

      {/* Free Tier Limit Notification Banner */}
      {isApproachingLimit && (
        <div className={`p-4 rounded-2xl border flex flex-col sm:flex-row items-center justify-between gap-3 ${
          isAtLimit
            ? 'bg-rosewood-950/80 border-rosewood-500/30 text-rosewood-200'
            : 'bg-gold-950/60 border-gold-400/30 text-gold-200'
        }`}>
          <div className="flex items-center gap-2.5">
            <AlertCircle className={`w-5 h-5 shrink-0 ${isAtLimit ? 'text-rosewood-400' : 'text-gold-400'}`} />
            <div className="text-xs">
              <span className="font-bold block sm:inline">
                {isAtLimit
                  ? i18n.t('feed.free_limit_reached')
                  : i18n.t('feed.approaching_limit', {
                      used: photos.length,
                      max: FREE_TIER_MAX_PHOTOS,
                    })}
              </span>
              {' '}
              <span className="opacity-80">{i18n.t('ui.live_feed.1')}</span>
            </div>
          </div>

          {onOpenPricing && (
            <button
              type="button"
              onClick={onOpenPricing}
              className="shrink-0 px-4 py-1.5 rounded-xl bg-gold-400 text-noir-900 font-bold text-xs shadow-glow hover:brightness-110 flex items-center gap-1.5"
            >
              <Crown className="w-3.5 h-3.5" />
              <span>{i18n.t('ui.live_feed.2')}</span>
            </button>
          )}
        </div>
      )}
      
      {/* Controls Bar: Filters & Search */}
      <div className="flex flex-col md:flex-row items-stretch md:items-center justify-between gap-3 bg-noir-800/80 p-3 rounded-2xl border border-cream-400/10 backdrop-blur-md">
        
        {/* Category Filter Tabs */}
        <div className="flex items-center gap-1.5 overflow-x-auto pb-1 md:pb-0 scrollbar-none">
          <button
            onClick={() => { setActiveFilter('all'); setRenderedLimit(20); }}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${
              activeFilter === 'all'
                ? 'bg-gold-400 text-noir-900 shadow-glow'
                : 'text-cream-300 hover:text-white hover:bg-noir-700'
            }`}
          >
            <Layers className="w-3.5 h-3.5" />
            <span>{i18n.t('feed.all_moments')} ({visiblePhotos.length})</span>
          </button>

          <button
            onClick={() => { setActiveFilter('featured'); setRenderedLimit(20); }}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${
              activeFilter === 'featured'
                ? 'bg-gold-400 text-noir-900 shadow-glow'
                : 'text-cream-300 hover:text-white hover:bg-noir-700'
            }`}
          >
            <Sparkles className="w-3.5 h-3.5" />
            <span>{i18n.t('feed.featured')} ({visiblePhotos.filter((p) => p.status === 'featured').length})</span>
          </button>

          <button
            onClick={() => setActiveFilter('quests')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${
              activeFilter === 'quests'
                ? 'bg-gold-400 text-noir-900 shadow-glow'
                : 'text-cream-300 hover:text-white hover:bg-noir-700'
            }`}
          >
            <Trophy className="w-3.5 h-3.5" />
            <span>{i18n.t('feed.quests')} ({visiblePhotos.filter((p) => Boolean(p.questId)).length})</span>
          </button>

          <button
            onClick={() => setActiveFilter('mine')}
            className={`flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-xs font-semibold whitespace-nowrap transition-all ${
              activeFilter === 'mine'
                ? 'bg-gold-400 text-noir-900 shadow-glow'
                : 'text-cream-300 hover:text-white hover:bg-noir-700'
            }`}
          >
            <User className="w-3.5 h-3.5" />
            <span>{i18n.t('feed.my_snaps')} ({visiblePhotos.filter(isMyPhoto).length})</span>
          </button>
        </div>

        {/* Live Search Input */}
        <div className="relative min-w-[220px]">
          <Search className="w-4 h-4 text-cream-400/60 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder={i18n.t('feed.search_placeholder')}
            className="w-full pl-9 pr-3 py-1.5 rounded-xl bg-noir-900 border border-cream-400/15 text-cream-100 text-xs placeholder:text-cream-400/40 focus:outline-none focus:border-gold-400"
          />
        </div>
      </div>

      {/* Live reactions: a tap here animates on the venue projector wall */}
      <div className="py-1">
        <ReactionBar guestName={currentGuest?.name} />
      </div>

      {/* Photo Grid / Masonry Layout */}
      {filteredPhotos.length > 0 ? (
        <div className="columns-1 sm:columns-2 lg:columns-3 gap-5 space-y-5">
          {displayedPhotos.map((photo) => (
            <div key={photo.id} className="break-inside-avoid">
              {/* M3 — handlers are passed through by reference, not wrapped in
                  fresh arrows per render, so React.memo on PhotoCard can
                  actually skip the cards whose photo did not change. */}
              <PhotoCard
                photo={photo}
                currentGuest={currentGuest}
                onLike={onLike}
                onReact={onReact}
                onOpenComments={onOpenComments}
                onOpenLightbox={onOpenLightbox}
              />
            </div>
          ))}
          
          {renderedLimit < filteredPhotos.length && (
            <div className="flex justify-center pt-8 pb-4 break-inside-avoid w-full col-span-full">
              <button
                type="button"
                onClick={() => setRenderedLimit(prev => prev + 20)}
                className="px-6 py-2.5 rounded-full bg-noir-800 border border-cream-400/20 text-cream-200 text-sm font-semibold hover:bg-noir-700 transition-colors"
              >
                {i18n.t('feed.load_more')}
              </button>
            </div>
          )}
        </div>
      ) : (
        /* Empty State */
        <div className="py-16 px-4 text-center rounded-3xl bg-noir-800/40 border border-cream-400/10 space-y-4">
          <div className="w-16 h-16 rounded-full bg-gold-400/10 border border-gold-400/20 flex items-center justify-center mx-auto text-gold-400">
            <Camera className="w-8 h-8" />
          </div>
          <div className="max-w-md mx-auto space-y-1">
            <h3 className="font-serif text-xl font-bold text-cream-100">
              {i18n.t('feed.empty_title')}
            </h3>
            <p className="text-xs text-cream-300/80">
              {i18n.t('feed.empty_subtitle')}
            </p>
          </div>
          <button
            onClick={onOpenCapture}
            className="px-6 py-2.5 rounded-full bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-xs shadow-glow hover:scale-105 active:scale-95 transition-transform"
          >
            {i18n.t('feed.snap_first')}
          </button>
        </div>
      )}

    </section>
  );
};

export const LiveFeed = React.memo(LiveFeedComponent);
LiveFeed.displayName = 'LiveFeed';
