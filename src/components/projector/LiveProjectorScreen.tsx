import React, { useState, useEffect, useMemo } from 'react';
import { WeddingEvent, Photo } from '../../types';
import { QRCodeSVG } from 'qrcode.react';
import { i18n } from '../../i18n';
import { storageService, LiveReaction, ReactionKind } from '../../services/storageService';
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

// Emoji are built from code points so the source stays plain ASCII.
const REACTION_GLYPHS: Record<ReactionKind, string> = {
  heart: String.fromCodePoint(0x2764, 0xfe0f),
  clap: String.fromCodePoint(0x1f44f),
  cheers: String.fromCodePoint(0x1f942),
  laugh: String.fromCodePoint(0x1f602),
  party: String.fromCodePoint(0x1f389),
};

/** Cycle the four Ken Burns variants so neighbouring slides never pan alike. */
function kenBurnsVariant(index: number): 0 | 1 | 2 | 3 {
  return (Math.abs(index) % 4) as 0 | 1 | 2 | 3;
}

interface LiveProjectorScreenProps {
  event: WeddingEvent;
  photos: Photo[];
  onClose: () => void;
}

export const LiveProjectorScreen: React.FC<LiveProjectorScreenProps> = ({
  event,
  photos,
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

  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(true);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [slideSpeed, setSlideSpeed] = useState<number>(6000);
  const [reactions, setReactions] = useState<(LiveReaction & { left: number; drift: number })[]>([]);

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // A still photo on a big screen reads as dead air; a slow pan keeps it alive.
  const kenBurnsClass = prefersReducedMotion
    ? 'animate-fade-in'
    : `animate-ken-burns-${kenBurnsVariant(currentIndex)}`;

  const safeIndex = displayPhotos.length > 0 ? Math.min(currentIndex, displayPhotos.length - 1) : 0;
  const currentPhoto = displayPhotos[safeIndex] || null;

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

  // Auto slideshow ticker
  useEffect(() => {
    if (!isPlaying || displayPhotos.length <= 1) return;

    const timer = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % displayPhotos.length);
    }, slideSpeed);

    return () => clearInterval(timer);
  }, [isPlaying, displayPhotos.length, slideSpeed]);

  const handleNext = () => {
    if (displayPhotos.length > 0) {
      setCurrentIndex((prev) => (prev + 1) % displayPhotos.length);
    }
  };

  const handlePrev = () => {
    if (displayPhotos.length > 0) {
      setCurrentIndex((prev) => (prev - 1 + displayPhotos.length) % displayPhotos.length);
    }
  };

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

      <div className="relative flex-1 flex items-center justify-center p-4 sm:p-8 overflow-hidden">
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
                src={currentPhoto.guestAvatar || `https://api.dicebear.com/7.x/micah/svg?seed=${encodeURIComponent(currentPhoto.guestName)}`}
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
              className="absolute left-6 p-3 rounded-full bg-black/50 text-white/80 hover:text-white hover:bg-black/80 transition-colors border border-white/10"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
            <button
              onClick={handleNext}
              className="absolute right-6 p-3 rounded-full bg-black/50 text-white/80 hover:text-white hover:bg-black/80 transition-colors border border-white/10"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
          </>
        )}
      </div>

      {/* BOTTOM BAR: Big Live QR Code & Prompt for Guests */}
      <div className="relative z-20 px-6 sm:px-10 py-4 bg-gradient-to-t from-black/95 via-black/70 to-transparent flex flex-col sm:flex-row items-center justify-between gap-4 border-t border-white/10">
        <div className="flex items-center gap-4">
          <div className="p-2.5 bg-white rounded-2xl shadow-glow">
            <QRCodeSVG
              value={currentUrl}
              size={84}
              level="H"
              includeMargin={false}
              imageSettings={{
                src: 'https://cdn-icons-png.flaticon.com/512/833/833472.png',
                x: undefined,
                y: undefined,
                height: 18,
                width: 18,
                excavate: true,
              }}
            />
          </div>
          <div>
            <h4 className="font-serif text-lg font-bold text-cream-100 flex items-center gap-2">
              <Sparkles className="w-4 h-4 text-gold-400" />
              <span>{i18n.t('projector.scan_share')}</span>
            </h4>
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
              onClick={() => setCurrentIndex(idx)}
              className={`w-12 h-12 rounded-xl overflow-hidden border-2 transition-all shrink-0 ${
                idx === currentIndex ? 'border-gold-400 scale-105 shadow-glow' : 'border-transparent opacity-60 hover:opacity-100'
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
