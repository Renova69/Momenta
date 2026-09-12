import React, { useState } from 'react';
import { Photo, Guest, PhotoReactionKind } from '../../types';
import { i18n } from '../../i18n';
import { formatTimeAgo } from '../../utils/date';
import confetti from 'canvas-confetti';
import {
  Heart,
  MessageCircle,
  Sparkles,
  Trophy,
  Lock,
  Camera,
  Maximize2
} from 'lucide-react';

interface PhotoCardProps {
  photo: Photo;
  currentGuest: Guest;
  onLike: (photoId: string) => void;
  onReact: (photoId: string, reaction: PhotoReactionKind) => void;
  onOpenComments: (photo: Photo) => void;
  onOpenLightbox: (photo: Photo) => void;
}

// Same glyphs/vocabulary as the ambient live-reaction bar (ReactionBar.tsx)
// — one per-photo reaction, not a second unrelated emoji set to learn.
const PHOTO_REACTIONS: { kind: PhotoReactionKind; glyph: string; labelKey: string }[] = [
  { kind: 'heart', glyph: String.fromCodePoint(0x2764, 0xfe0f), labelKey: 'reaction.heart' },
  { kind: 'clap', glyph: String.fromCodePoint(0x1f44f), labelKey: 'reaction.clap' },
  { kind: 'cheers', glyph: String.fromCodePoint(0x1f942), labelKey: 'reaction.cheers' },
  { kind: 'laugh', glyph: String.fromCodePoint(0x1f602), labelKey: 'reaction.laugh' },
  { kind: 'party', glyph: String.fromCodePoint(0x1f389), labelKey: 'reaction.party' },
];

const FILTER_LABELS: Record<string, string> = {
  original: i18n.t('filter.original'),
  golden_glow: i18n.t('filter.golden_glow'),
  vintage_warmth: i18n.t('filter.vintage_warmth'),
  black_white: i18n.t('filter.black_white'),
  film_grain: i18n.t('filter.film_grain'),
};

/**
 * M3 — memoized, and it matters more than it looks.
 *
 * A feed page renders up to 20 of these. Every realtime message re-renders the
 * whole tree, but `applyRealtimeMessage` only replaces the object for the
 * photo that actually changed — the other 19 keep their identity. Memoizing
 * turns "a like arrives, 20 cards re-render" into "a like arrives, 1 card
 * re-renders".
 *
 * That only holds while the callbacks are stable too, which is why this takes
 * `photoId` instead of pre-bound closures: LiveFeed used to pass
 * `onLike={() => onLike(photo.id)}`, a fresh function identity on every
 * render, which would have defeated the comparison on every single card.
 */
const PhotoCardComponent: React.FC<PhotoCardProps> = ({
  photo,
  currentGuest,
  onLike,
  onReact,
  onOpenComments,
  onOpenLightbox,
}) => {
  const isLiked = photo.likedByGuestIds?.includes(currentGuest.id);
  const [isLikeAnimating, setIsLikeAnimating] = useState(false);

  const handleReactClick = (e: React.MouseEvent, kind: PhotoReactionKind) => {
    e.stopPropagation();
    onReact(photo.id, kind);
  };

  const handleLikeClick = (e: React.MouseEvent) => {
    e.stopPropagation();

    if (!currentGuest || currentGuest.id === 'anonymous') {
      onLike(photo.id);
      return;
    }

    setIsLikeAnimating(true);
    setTimeout(() => setIsLikeAnimating(false), 500);

    if (!isLiked) {
      confetti({
        particleCount: 15,
        spread: 45,
        origin: {
          x: e.clientX / window.innerWidth,
          y: e.clientY / window.innerHeight,
        },
        colors: ['#D4AF37', '#D98991', '#FFFFFF'],
      });
    }

    onLike(photo.id);
  };

  const timeAgo = formatTimeAgo(photo.createdAt);
  const previewUrl = photo.thumbnailUrl || photo.fullUrl;

  return (
    <div
      onClick={() => onOpenLightbox(photo)}
      className="group relative bg-noir-800/90 rounded-2xl sm:rounded-3xl border border-cream-400/10 hover:border-gold-400/40 shadow-polaroid hover:shadow-glow transition-all duration-300 overflow-hidden flex flex-col cursor-pointer"
    >
      {/* Photo Image Container (Polaroid framing) */}
      <div className="relative aspect-[4/5] w-full bg-noir-950 overflow-hidden">
        {previewUrl ? (
          <img
            src={previewUrl}
            alt={photo.caption || 'Wedding moment'}
            loading="lazy"
            className="w-full h-full object-cover object-center group-hover:scale-105 transition-transform duration-500"
          />
        ) : (
          // H1 — a capture whose inline preview had to be shed to fit the
          // localStorage quota, on a device that has since reloaded. The row
          // survives (that is the point), but there is no image to draw until
          // the upload lands and the server URL replaces it. An <img src="">
          // renders as a browser-default broken icon, which reads as "your
          // photo is lost" — exactly the wrong thing to tell a guest whose
          // photo is in fact still on its way up.
          <div
            data-testid="photo-preview-pending"
            className="w-full h-full flex flex-col items-center justify-center gap-2 bg-noir-900 text-cream-400/60"
          >
            <Camera className="w-7 h-7 text-gold-400/50" />
            <span className="text-[10px] font-semibold tracking-wide">{i18n.t('feed.preview_uploading')}</span>
          </div>
        )}

        {/* Disposable Camera Locked Overlay */}
        {photo.isLocked && (
          <div className="absolute inset-0 bg-noir-900/80 backdrop-blur-md flex flex-col items-center justify-center p-4 text-center">
            <Lock className="w-8 h-8 text-gold-400 mb-2 animate-pulse" />
            <span className="font-serif text-sm font-bold text-cream-100">
              {i18n.t('feed.disposable_title')}
            </span>
            <span className="text-[10px] text-cream-400/80 mt-1 max-w-[200px]">
              {i18n.t('feed.disposable_locked')}
            </span>
          </div>
        )}

        {/* Top Badges (Featured / Quest / Pending) */}
        <div className="absolute top-3 left-3 right-3 flex items-center justify-between pointer-events-none">
          {photo.status === 'featured' ? (
            <span className="px-2.5 py-1 rounded-full bg-gold-400/90 backdrop-blur-sm text-noir-900 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 shadow-md">
              <Sparkles className="w-3 h-3 fill-noir-900" />
              <span>{i18n.t('feed.featured_badge')}</span>
            </span>
          ) : photo.status === 'pending' ? (
            <span className="px-2.5 py-1 rounded-full bg-amber-400/90 backdrop-blur-sm text-noir-900 text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 shadow-md">
              <span>{i18n.t('feed.in_review')}</span>
            </span>
          ) : photo.questTitle ? (
            <span className="px-2.5 py-1 rounded-full bg-noir-900/80 backdrop-blur-sm text-gold-300 text-[10px] font-semibold flex items-center gap-1 border border-gold-400/30">
              <Trophy className="w-3.5 h-3.5 text-gold-400" />
              <span className="max-w-[100px] truncate">{photo.questTitle}</span>
            </span>
          ) : (
            <div />
          )}

          {/* Quick zoom icon */}
          <span className="w-7 h-7 rounded-full bg-black/40 backdrop-blur-sm text-white/80 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
            <Maximize2 className="w-3.5 h-3.5" />
          </span>
        </div>

        {/* Filter Watermark */}
        {photo.filterApplied && photo.filterApplied !== 'original' && (
          <div className="absolute bottom-2 right-2 px-2 py-0.5 rounded-md bg-black/60 backdrop-blur-xs text-[9px] text-cream-200 font-medium">
            {FILTER_LABELS[photo.filterApplied] || photo.filterApplied}
          </div>
        )}
      </div>

      {/* Card Info & Caption */}
      <div className="p-3.5 sm:p-4 flex-1 flex flex-col justify-between space-y-2.5">
        
        {/* Guest Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 rounded-full bg-gold-400/20 border border-gold-400/40 overflow-hidden flex-shrink-0">
              {photo.guestAvatar ? (
                <img
                  src={photo.guestAvatar}
                  alt={photo.guestName}
                  className="w-full h-full object-cover"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center text-[10px] font-bold text-gold-400">
                  {photo.guestName.charAt(0)}
                </div>
              )}
            </div>
            <div>
              <h4 className="text-xs font-semibold text-cream-100 leading-tight">
                {photo.guestName}
              </h4>
              {photo.source === 'photographer' && (
                <span className="inline-flex items-center gap-1 mt-0.5 px-1.5 py-0.5 rounded bg-gold-400/15 border border-gold-400/40 text-gold-300 text-[9px] font-bold uppercase tracking-wider">
                  <Camera className="w-2.5 h-2.5" /> Official Photographer
                </span>
              )}
              <div className="flex items-center gap-1.5 text-[10px] text-cream-400/70">
                {photo.guestTable && <span>{photo.guestTable} •</span>}
                <span>{timeAgo}</span>
              </div>
            </div>
          </div>
        </div>

        {/* Caption */}
        {photo.caption && (
          <p className="text-xs text-cream-200/90 font-serif italic leading-relaxed line-clamp-2">
            "{photo.caption}"
          </p>
        )}

        {/* Interactions: Hearts & Comments */}
        <div className="pt-2 border-t border-cream-400/10 flex items-center justify-between text-xs text-cream-300">
          <button
            onClick={handleLikeClick}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-full transition-all ${
              isLiked
                ? 'bg-rosewood-500/20 text-rosewood-400 font-bold'
                : 'hover:bg-noir-700 text-cream-400 hover:text-cream-200'
            } ${isLikeAnimating ? 'scale-125' : ''}`}
          >
            <Heart
              className={`w-4 h-4 transition-colors ${
                isLiked
                  ? 'text-rosewood-400 fill-rosewood-400'
                  : 'text-cream-400 group-hover:text-gold-400'
              }`}
            />
            <span>{photo.likesCount}</span>
          </button>

          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenComments(photo);
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 rounded-full hover:bg-noir-700 text-cream-400 hover:text-cream-200 transition-colors"
          >
            <MessageCircle className="w-4 h-4" />
            <span>{photo.commentsCount}</span>
          </button>
        </div>

        {/* Emoji Reactions — several kinds at once, independent of the like above */}
        <div className="flex items-center gap-1 flex-wrap">
          {PHOTO_REACTIONS.map(({ kind, glyph, labelKey }) => {
            const reactedBy = (photo.reactions || []).filter((r) => r.reaction === kind);
            const count = reactedBy.length;
            const hasReacted = reactedBy.some((r) => r.guestId === currentGuest.id);
            if (count === 0 && !hasReacted) {
              return (
                <button
                  key={kind}
                  onClick={(e) => handleReactClick(e, kind)}
                  title={i18n.t(labelKey)}
                  className="w-7 h-7 rounded-full flex items-center justify-center text-sm opacity-40 hover:opacity-100 hover:bg-noir-700 transition-all"
                >
                  {glyph}
                </button>
              );
            }
            return (
              <button
                key={kind}
                onClick={(e) => handleReactClick(e, kind)}
                title={i18n.t(labelKey)}
                className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs transition-all ${
                  hasReacted
                    ? 'bg-gold-400/20 border border-gold-400/50 text-gold-300 font-bold'
                    : 'bg-noir-900/60 border border-cream-400/10 text-cream-300 hover:border-cream-400/30'
                }`}
              >
                <span>{glyph}</span>
                <span>{count}</span>
              </button>
            );
          })}
        </div>

        {/* Comment Preview — the latest comment shown inline, matching the
            classic feed pattern (Instagram/Facebook) instead of hiding every
            comment behind a click into the lightbox. */}
        {photo.comments && photo.comments.length > 0 && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onOpenComments(photo);
            }}
            className="text-left space-y-0.5"
          >
            {photo.commentsCount > 1 && (
              <span className="block text-[11px] text-cream-400/60 hover:text-cream-300 transition-colors">
                {i18n.t('feed.view_all_comments', { n: photo.commentsCount })}
              </span>
            )}
            <p className="text-xs text-cream-200/90 leading-snug line-clamp-1">
              <span className="font-semibold text-gold-300">
                {photo.comments[photo.comments.length - 1].guestName}
              </span>{' '}
              {photo.comments[photo.comments.length - 1].commentText}
            </p>
          </button>
        )}
      </div>
    </div>
  );
};

export const PhotoCard = React.memo(PhotoCardComponent);
PhotoCard.displayName = 'PhotoCard';
