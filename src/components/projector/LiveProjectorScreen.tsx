import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { WeddingEvent, Photo, ScavengerQuest } from '../../types';
import { QRCodeSVG } from 'qrcode.react';
import { i18n } from '../../i18n';
import { centerIconDataUri } from '../../utils/qrCenterIcon';
import { storageService, LiveReaction, ReactionKind } from '../../services/storageService';
import { isFeatureUnlocked } from '../../config/tierGating';
import { useQuestLeaderboard } from '../../hooks/useQuestLeaderboard';
import { TvLeaderboardColumn } from './TvLeaderboardColumn';
import {
  Heart,
  Maximize2,
  Minimize2,
  Play,
  Pause,
  ChevronLeft,
  ChevronRight,
  Trophy,
  X,
  Sparkles,
} from 'lucide-react';
import { guestAvatarUrl } from '../../utils/avatar';

// Emoji are built from code points so the source stays plain ASCII.
const REACTION_GLYPHS: Record<ReactionKind, string> = {
  heart: String.fromCodePoint(0x2764, 0xfe0f),
  clap: String.fromCodePoint(0x1f44f),
  cheers: String.fromCodePoint(0x1f942),
  laugh: String.fromCodePoint(0x1f602),
  party: String.fromCodePoint(0x1f389),
};

/** Stable default, so a caller that passes no quests does not re-render the trigger. */
const NO_QUESTS: ScavengerQuest[] = [];

/** Cycle the four Ken Burns variants so neighbouring slides never pan alike. */
function kenBurnsVariant(index: number): 0 | 1 | 2 | 3 {
  return (Math.abs(index) % 4) as 0 | 1 | 2 | 3;
}

interface LiveProjectorScreenProps {
  event: WeddingEvent;
  photos: Photo[];
  /**
   * The quest list, so the leaderboard column refetches when a quest is
   * completed or deleted. Photos alone miss both: deleting a quest sends no
   * photo broadcast, and in a moderated event a pending photo reaches only the
   * host, though it scores and its QUEST_COMPLETED reaches the wall.
   */
  quests?: ScavengerQuest[];
  onClose: () => void;
}

export const LiveProjectorScreen: React.FC<LiveProjectorScreenProps> = ({
  event,
  photos,
  quests = NO_QUESTS,
  onClose,
}) => {
  // Official photographer photos (priority > 0) rotate first, then newest-first.
  //
  // M4 — this filter+sort used to run on every render, and this component
  // re-renders constantly: each live reaction arriving from the room sets
  // state twice (once to show it, once to drop it 3.4s later). On a wall
  // showing a thousand-photo album during a reaction burst that is a full
  // sort per frame, on the underpowered TV hardware least able to absorb it.
  const displayPhotos = useMemo(
    () =>
      photos
        .filter((p) => p.status === 'approved' || p.status === 'featured')
        .sort(
          (a, b) =>
            (b.priority || 0) - (a.priority || 0) ||
            (new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
        ),
    [photos]
  );

  // N-91 — the slide on screen is a photo, not a position. It was an index
  // into this newest-first list, so a new photo arriving at the front moved
  // every position: the slide changed under the guests watching it, and the
  // new photo, now first, waited for the whole album to go round.
  const [currentId, setCurrentId] = useState<string | null>(null);
  const currentIdRef = useRef<string | null>(null);
  currentIdRef.current = currentId;
  const photosRef = useRef(displayPhotos);
  photosRef.current = displayPhotos;
  // Photos that arrived while the wall was showing, shown next in arrival order.
  const knownIdsRef = useRef<Set<string> | null>(null);
  const arrivalsRef = useRef<string[]>([]);
  // The slide the arrivals interrupted, to carry on from once they are shown.
  const resumeFromRef = useRef<string | null>(null);
  // Where the slide was, for when the photo on screen is deleted.
  const lastIndexRef = useRef(0);

  useEffect(() => {
    const ids = displayPhotos.map((p) => p.id);
    if (knownIdsRef.current === null) {
      knownIdsRef.current = new Set(ids);
      return;
    }
    for (const id of ids) {
      if (knownIdsRef.current.has(id)) continue;
      knownIdsRef.current.add(id);
      arrivalsRef.current.push(id);
    }
  }, [displayPhotos]);

  // N-97 — a slide is pinned as soon as there is one. Left unpinned until the
  // first tick, the wall showed whatever was first in the list, so a photo
  // arriving before then (on a new wall, the usual case) still swapped it.
  useEffect(() => {
    if (currentIdRef.current !== null || displayPhotos.length === 0) return;
    const first = displayPhotos[0].id;
    arrivalsRef.current = arrivalsRef.current.filter((id) => id !== first);
    setCurrentId(first);
  }, [displayPhotos]);

  const foundIndex = currentId ? displayPhotos.findIndex((p) => p.id === currentId) : -1;
  const currentIndex =
    foundIndex >= 0 ? foundIndex : Math.min(lastIndexRef.current, Math.max(displayPhotos.length - 1, 0));
  lastIndexRef.current = currentIndex;

  /** Move one slide on: arrivals first, then onwards from where the wall was. */
  const step = useCallback((delta: 1 | -1) => {
    const list = photosRef.current;
    if (list.length === 0) return;
    const indexOf = (id: string | null) => (id ? list.findIndex((p) => p.id === id) : -1);

    if (delta === 1) {
      while (arrivalsRef.current.length > 0) {
        const next = arrivalsRef.current.shift()!;
        if (indexOf(next) < 0 || next === currentIdRef.current) continue;
        if (resumeFromRef.current === null) resumeFromRef.current = currentIdRef.current;
        setCurrentId(next);
        return;
      }
    }

    const resumeAt = indexOf(resumeFromRef.current);
    resumeFromRef.current = null;
    const at = resumeAt >= 0 && delta === 1 ? resumeAt : indexOf(currentIdRef.current);
    const from = at >= 0 ? at : Math.min(lastIndexRef.current, list.length - 1);
    setCurrentId(list[(from + delta + list.length) % list.length].id);
  }, []);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [slideSpeed, setSlideSpeed] = useState<number>(6000);
  const [reactions, setReactions] = useState<(LiveReaction & { left: number; drift: number })[]>([]);

  // The wall is a photo album first. The board joins it, beside the photos
  // rather than in place of them, only when the host has switched it on —
  // and it is not fetched at all otherwise.
  const showLeaderboard = !!event.showTvLeaderboard && isFeatureUnlocked(event.planTier, 'scavenger_quests');
  const leaderboard = useQuestLeaderboard(event.id, showLeaderboard, quests, photos);

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // A still photo on a big screen reads as dead air; a slow pan keeps it alive.
  // N-98 — each photo takes the next pan when it comes on screen and keeps it
  // while it is there. Taken from its position, a photo arriving at the front
  // changed the class on the image already showing and restarted its pan.
  const panRef = useRef<{ id: string | null; variant: 0 | 1 | 2 | 3 }>({ id: null, variant: 3 });
  const onScreenId = displayPhotos[currentIndex]?.id ?? null;
  if (onScreenId !== null && panRef.current.id !== onScreenId) {
    panRef.current = { id: onScreenId, variant: kenBurnsVariant(panRef.current.variant + 1) };
  }
  const kenBurnsClass = prefersReducedMotion
    ? 'animate-fade-in'
    : `animate-ken-burns-${panRef.current.variant}`;

  const currentPhoto = displayPhotos[currentIndex] || null;

  // Live reactions float up over the wall and vanish. Nothing is persisted, and
  // each entry is dropped as its animation finishes so a long reception cannot
  // grow the list without bound.
  useEffect(() => {
    const unsub = storageService.subscribeReactions((reaction) => {
      const decorated = {
        ...reaction,
        left: 8 + Math.random() * 84,
        drift: Math.round((Math.random() - 0.5) * 160),
      };
      setReactions((prev) => [...prev.slice(-24), decorated]);
      window.setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== decorated.id));
      }, 3400);
    });
    return unsub;
  }, []);

  useEffect(() => {
    // Screen Wake Lock is not in this project's DOM lib yet; describe the sliver
    // of it we use rather than reaching for `any`.
    interface WakeLockSentinelLike {
      release: () => Promise<void>;
    }
    interface WakeLockNavigator {
      wakeLock?: { request: (type: 'screen') => Promise<WakeLockSentinelLike> };
    }

    let wakeLock: WakeLockSentinelLike | null = null;
    const requestWakeLock = async () => {
      try {
        const nav = navigator as Navigator & WakeLockNavigator;
        if (nav.wakeLock && document.visibilityState === 'visible') {
          wakeLock = await nav.wakeLock.request('screen');
        }
      } catch (err) {
        console.warn('[Projector] WakeLock request failed:', err);
      }
    };

    requestWakeLock();

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        requestWakeLock();
      }
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      if (wakeLock) wakeLock.release().catch(() => {});
    };
  }, []);

  // Auto slideshow ticker. Restarted when play, speed or "more than one photo"
  // changes, not on every arrival (N-91): restarting on each new photo held
  // one slide on screen for as long as photos kept coming.
  const hasSeveral = displayPhotos.length > 1;
  useEffect(() => {
    if (!isPlaying || !hasSeveral) return;

    const timer = setInterval(() => step(1), slideSpeed);

    return () => clearInterval(timer);
  }, [isPlaying, hasSeveral, slideSpeed, step]);

  const handleNext = () => step(1);

  const handlePrev = () => step(-1);

  const toggleFullscreen = () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen().catch(() => {});
      setIsFullscreen(false);
    }
  };

  const currentUrl = typeof window !== 'undefined'
    ? `${window.location.origin}/e/${event.slug}`
    : `https://wedmoments.app/e/${event.slug}`;

  return (
    <div className="fixed inset-0 z-50 bg-black text-white flex flex-col justify-between overflow-hidden select-none animate-fade-in">
      
      {/* TOP BAR: Couple Title & Slideshow Controls */}
      <div className="relative z-20 px-6 sm:px-10 py-5 flex items-center justify-between bg-gradient-to-b from-black/85 via-black/40 to-transparent">
        <div className="flex items-center gap-3.5">
          <div className="w-11 h-11 rounded-full bg-gold-400/20 border border-gold-400/50 flex items-center justify-center shadow-glow">
            <Heart className="w-5 h-5 text-gold-400 fill-gold-400" />
          </div>
          <div>
            <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-wide text-cream-100">
              {event.title}
            </h1>
            <p className="text-xs text-gold-300 tracking-wider uppercase font-semibold flex items-center gap-2">
              <span>{i18n.t('projector.live_wall')}</span>
              <span>•</span>
              <span>{displayPhotos.length} {i18n.t('hero.moments_captured').toLowerCase()}</span>
            </p>
          </div>
        </div>

        {/* Right Controls */}
        <div className="flex items-center gap-2.5">
          {/* Speed Selector */}
          <div className="hidden sm:flex items-center bg-black/60 backdrop-blur-md rounded-full p-1 border border-white/10 text-xs">
            <button
              onClick={() => setSlideSpeed(4000)}
              className={`px-2.5 py-1 rounded-full ${slideSpeed === 4000 ? 'bg-gold-400 text-noir-900 font-bold' : 'text-cream-400'}`}
            >
              4s
            </button>
            <button
              onClick={() => setSlideSpeed(6000)}
              className={`px-2.5 py-1 rounded-full ${slideSpeed === 6000 ? 'bg-gold-400 text-noir-900 font-bold' : 'text-cream-400'}`}
            >
              6s
            </button>
            <button
              onClick={() => setSlideSpeed(10000)}
              className={`px-2.5 py-1 rounded-full ${slideSpeed === 10000 ? 'bg-gold-400 text-noir-900 font-bold' : 'text-cream-400'}`}
            >
              10s
            </button>
          </div>

          {/* Play/Pause */}
          <button
            onClick={() => setIsPlaying(!isPlaying)}
            className="p-2.5 rounded-full bg-black/60 backdrop-blur-md text-white hover:bg-gold-400 hover:text-noir-900 transition-colors border border-white/10"
            title={isPlaying ? i18n.t('audio.pause') : i18n.t('projector.play')}
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
          </button>

          {/* Fullscreen */}
          <button
            onClick={toggleFullscreen}
            className="p-2.5 rounded-full bg-black/60 backdrop-blur-md text-white hover:bg-gold-400 hover:text-noir-900 transition-colors border border-white/10"
            title={i18n.t('projector.fullscreen')}
          >
            {isFullscreen ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
          </button>

          {/* Close */}
          <button
            onClick={onClose}
            className="p-2.5 rounded-full bg-black/60 backdrop-blur-md text-white hover:bg-rosewood-600 transition-colors border border-white/10"
            title={i18n.t('projector.close')}
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* CENTRAL AREA: Massive Photo + Author Caption */}
      {/* Live reaction layer - guests tap, the wall celebrates */}
      <div className="pointer-events-none fixed inset-0 z-40 overflow-hidden" aria-hidden="true">
        {reactions.map((r) => (
          <span
            key={r.id}
            className="absolute bottom-8 text-5xl sm:text-6xl animate-float-up select-none"
            style={{ left: `${r.left}%`, ['--drift' as string]: `${r.drift}px` }}
          >
            {REACTION_GLYPHS[r.reaction] || REACTION_GLYPHS.heart}
          </span>
        ))}
      </div>

      <div className="relative flex-1 min-h-0 flex overflow-hidden">
        <div className="relative flex-1 min-w-0 flex items-center justify-center p-4 sm:p-8 overflow-hidden">
          {currentPhoto ? (
            <div className="relative max-w-6xl max-h-full flex flex-col items-center justify-center">
              <div className="relative rounded-3xl overflow-hidden shadow-2xl border border-white/15 max-h-[70vh] bg-noir-950 flex items-center justify-center">
                <img
                  key={currentPhoto.id}
                  src={currentPhoto.fullUrl}
                  alt={currentPhoto.caption || 'Wedding celebration'}
                  className={`max-h-[70vh] w-auto object-contain will-change-transform ${kenBurnsClass}`}
                />

                {currentPhoto.questTitle && (
                  <div className="absolute top-4 left-4 px-3 py-1.5 rounded-full bg-noir-900/80 backdrop-blur-md text-gold-300 text-xs font-semibold flex items-center gap-2 border border-gold-400/40">
                    <Trophy className="w-4 h-4 text-gold-400" />
                    <span>{currentPhoto.questTitle}</span>
                  </div>
                )}
              </div>

              {/* Subtitle / Guest Card Overlay */}
              <div className="mt-4 px-6 py-3 rounded-2xl bg-black/70 backdrop-blur-md border border-white/10 flex items-center gap-4 max-w-2xl text-center">
                <img
                  src={guestAvatarUrl(currentPhoto.guestAvatar, currentPhoto.guestName)}
                  alt={currentPhoto.guestName}
                  className="w-10 h-10 rounded-full border border-gold-400/40 object-cover"
                />
                <div className="text-left">
                  <div className="font-serif font-bold text-sm sm:text-base text-cream-100 flex items-center gap-2">
                    <span>{currentPhoto.guestName}</span>
                    {currentPhoto.guestTable && (
                      <span className="text-xs font-sans text-gold-400 font-normal">
                        • {currentPhoto.guestTable}
                      </span>
                    )}
                  </div>
                  {currentPhoto.caption && (
                    <p className="text-xs sm:text-sm text-cream-200/90 font-serif italic mt-0.5 line-clamp-2">
                      "{currentPhoto.caption}"
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : (
            <div className="text-center space-y-4 max-w-md p-8 rounded-3xl bg-noir-900/80 border border-gold-400/20">
              <h3 className="font-serif text-2xl font-bold text-cream-100">
                {i18n.t('feed.empty_title')}
              </h3>
              <p className="text-xs text-cream-300/80">
                {i18n.t('projector.point_cam')}
              </p>
            </div>
          )}

          {/* Navigation Chevrons */}
          {displayPhotos.length > 1 && (
            <>
              <button
                onClick={handlePrev}
                aria-label={i18n.t('projector.previous_photo')}
                className="absolute left-6 p-3 rounded-full bg-black/50 text-white/80 hover:text-white hover:bg-black/80 transition-colors border border-white/10"
              >
                <ChevronLeft className="w-6 h-6" />
              </button>
              <button
                onClick={handleNext}
                aria-label={i18n.t('projector.next_photo')}
                className="absolute right-6 p-3 rounded-full bg-black/50 text-white/80 hover:text-white hover:bg-black/80 transition-colors border border-white/10"
              >
                <ChevronRight className="w-6 h-6" />
              </button>
            </>
          )}
        </div>

        {showLeaderboard && <TvLeaderboardColumn entries={leaderboard} prize={event.questPrize} />}
      </div>

      {/* BOTTOM BAR: Big Live QR Code & Prompt for Guests */}
      <div className="relative z-20 px-6 sm:px-10 py-4 bg-gradient-to-t from-black/95 via-black/70 to-transparent flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-white/10">
        <div className="flex items-center gap-4">
          <div className="p-2.5 bg-white rounded-2xl shadow-glow">
            <QRCodeSVG
              value={currentUrl}
              title={i18n.t('qr.alt')}
              size={84}
              level="H"
              includeMargin={false}
              // Inline, not hotlinked. This screen runs all evening on the
              // venue's Wi-Fi; an external CDN in the middle of the QR code
              // is a request that can hang, fail, or simply tell flaticon
              // where the wedding is. The print studio stopped doing this
              // when it broke PNG export; the wall kept doing it.
              imageSettings={{
                src: centerIconDataUri('heart')!,
                x: undefined,
                y: undefined,
                height: 18,
                width: 18,
                excavate: true,
              }}
            />
          </div>
          <div>
            <h2 className="font-serif text-lg font-bold text-cream-100 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-gold-400" />
              <span>{i18n.t('projector.scan_share')}</span>
            </h2>
            <p className="text-xs text-cream-300/80 mt-0.5">
              {i18n.t('projector.point_cam')}
            </p>
            <span className="text-[10px] text-gold-400/90 uppercase tracking-widest font-semibold block mt-1">
              {i18n.t('projector.no_app')}
            </span>
          </div>
        </div>

        {/* Thumbnail ticker */}
        <div className="hidden lg:flex items-center gap-2 max-w-lg overflow-hidden py-1">
          {displayPhotos.slice(0, 8).map((p, idx) => (
            <button
              key={p.id}
              onClick={() => setCurrentId(p.id)}
              aria-label={i18n.t('projector.jump_to_photo', { n: idx + 1 })}
              className={`w-12 h-12 rounded-xl overflow-hidden border-2 transition-all shrink-0 ${
                p.id === currentPhoto?.id ? 'border-gold-400 scale-105 shadow-glow' : 'border-transparent opacity-60 hover:opacity-100'
              }`}
            >
              <img src={p.thumbnailUrl || p.fullUrl} alt="Thumbnail" className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      </div>

    </div>
  );
};
