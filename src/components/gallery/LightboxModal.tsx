import React, { useState } from 'react';
import { Photo, Guest, PhotoReactionKind } from '../../types';
import { i18n } from '../../i18n';
import { formatTimeAgo } from '../../utils/date';
import {
  X,
  Heart,
  Download,
  Share2,
  Trophy,
  Send,
  User,
  Sparkles,
  Check
} from 'lucide-react';

interface LightboxModalProps {
  photo: Photo | null;
  onClose: () => void;
  currentGuest: Guest;
  onLike: (photoId: string) => void;
  onReact: (photoId: string, reaction: PhotoReactionKind) => void;
  onAddComment: (photoId: string, text: string) => void;
}

// Same glyphs/vocabulary as PhotoCard's reaction bar and the ambient
// live-reaction bar — one shared vocabulary across the whole app.
const REACTIONS: { kind: PhotoReactionKind; glyph: string; labelKey: string }[] = [
  { kind: 'heart', glyph: String.fromCodePoint(0x2764, 0xfe0f), labelKey: 'reaction.heart' },
  { kind: 'clap', glyph: String.fromCodePoint(0x1f44f), labelKey: 'reaction.clap' },
  { kind: 'cheers', glyph: String.fromCodePoint(0x1f942), labelKey: 'reaction.cheers' },
  { kind: 'laugh', glyph: String.fromCodePoint(0x1f602), labelKey: 'reaction.laugh' },
  { kind: 'party', glyph: String.fromCodePoint(0x1f389), labelKey: 'reaction.party' },
];

/** Deterministic pastel-ish avatar color from a name, so the same guest always gets the same color. */
function avatarColorFor(name: string): string {
  const palette = ['#D4AF37', '#D98991', '#84A784', '#8FA8C9', '#C98FBF', '#C9A17E'];
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return palette[hash % palette.length];
}

export const LightboxModal: React.FC<LightboxModalProps> = ({
  photo,
  onClose,
  currentGuest,
  onLike,
  onReact,
  onAddComment,
}) => {
  const [newComment, setNewComment] = useState('');
  const [isCopied, setIsCopied] = useState(false);

  if (!photo) return null;

  const isLiked = photo.likedByGuestIds?.includes(currentGuest.id);

  const handleSubmitComment = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newComment.trim()) return;
    onAddComment(photo.id, newComment);
    setNewComment('');
  };

  const handleDownload = () => {
    // Defense in depth (SEC-W1) — the server only ever hands back a photo
    // whose fullUrl it generated itself (SEC-A1 closed the path that could
    // plant anything else), but a download link built from a photo field
    // costs nothing extra to double-check before it's ever clicked.
    // data:/blob: are allowed too (FE-11): fullUrl legitimately holds one of
    // these during the optimistic-upload window, between a guest capturing a
    // photo and the server's real URL replacing it — both are inherently
    // local/self-generated, never an attacker-controlled redirect target.
    if (!/^(https?:|data:|blob:|\/)/i.test(photo.fullUrl)) return;
    const link = document.createElement('a');
    link.href = photo.fullUrl;
    link.download = `wedmoments-${photo.id}.jpg`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleCopyLink = () => {
    if (typeof navigator !== 'undefined' && navigator.clipboard) {
      navigator.clipboard.writeText(photo.fullUrl);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4 bg-black/90 backdrop-blur-lg animate-fade-in">
      <div className="relative w-full max-w-5xl h-full max-h-[90vh] bg-noir-900 rounded-3xl border border-cream-400/20 shadow-2xl overflow-hidden flex flex-col md:flex-row">
        
        {/* Close Button */}
        <button
          onClick={onClose}
          className="absolute top-4 right-4 z-20 p-2 rounded-full bg-black/60 text-white hover:bg-black/90 transition-colors border border-white/10"
        >
          <X className="w-5 h-5" />
        </button>

        {/* Left / Main Photo Area */}
        <div className="flex-1 relative bg-black flex items-center justify-center overflow-hidden p-2">
          <img
            src={photo.fullUrl}
            alt={photo.caption || 'Wedding Photo'}
            className="max-h-full max-w-full object-contain rounded-xl shadow-2xl"
          />

          {/* Featured on TV badge */}
          {photo.status === 'featured' && (
            <div className="absolute top-4 left-4 px-3 py-1 rounded-full bg-gold-400 text-noir-900 text-xs font-bold flex items-center gap-1 shadow-glow">
              <Sparkles className="w-3.5 h-3.5 fill-noir-900" />
              <span>{i18n.t('lightbox.on_tv')}</span>
            </div>
          )}

          {photo.questTitle && (
            <div className="absolute bottom-4 left-4 px-3 py-1 rounded-full bg-noir-900/80 backdrop-blur-sm text-gold-300 text-xs font-semibold flex items-center gap-1.5 border border-gold-400/30">
              <Trophy className="w-3.5 h-3.5 text-gold-400" />
              <span>{i18n.t('lightbox.quest_tag')} {photo.questTitle}</span>
            </div>
          )}
        </div>

        {/* Right / Details & Comments Panel */}
        <div className="w-full md:w-96 flex flex-col bg-noir-800/90 border-t md:border-t-0 md:border-l border-cream-400/10">
          
          {/* Photo Author & Metadata */}
          <div className="p-4 border-b border-cream-400/10 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-gold-400/20 border border-gold-400/40 flex items-center justify-center overflow-hidden">
                {photo.guestAvatar ? (
                  <img
                    src={photo.guestAvatar}
                    alt={photo.guestName}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <User className="w-5 h-5 text-gold-400" />
                )}
              </div>
              <div>
                <h4 className="font-serif font-bold text-sm text-cream-100">
                  {photo.guestName}
                </h4>
                <div className="flex items-center gap-2 text-[11px] text-cream-400/70">
                  {photo.guestTable && <span>{photo.guestTable}</span>}
                  {photo.guestTable && <span>•</span>}
                  <span>{new Date(photo.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Caption & Comments List */}
          <div className="flex-1 overflow-y-auto p-4 space-y-4">
            {photo.caption && (
              <div className="p-3 rounded-2xl bg-noir-900/80 border border-gold-400/20">
                <p className="text-xs text-cream-100 font-serif italic leading-relaxed">
                  "{photo.caption}"
                </p>
              </div>
            )}

            {/* Comments Stream */}
            <div className="space-y-3">
              <div className="flex items-center justify-between text-xs font-semibold text-cream-400/80">
                <span>{i18n.t('lightbox.wishes_title')}</span>
                <span>{photo.comments?.length || 0}</span>
              </div>

              {photo.comments && photo.comments.length > 0 ? (
                <div className="space-y-3">
                  {photo.comments.map((comm) => (
                    <div key={comm.id} className="flex items-start gap-2">
                      <div
                        className="w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-noir-900 shrink-0 mt-0.5"
                        style={{ backgroundColor: avatarColorFor(comm.guestName) }}
                      >
                        {comm.guestName.charAt(0).toUpperCase()}
                      </div>
                      <div className="flex-1 p-2.5 rounded-2xl rounded-tl-sm bg-noir-900/60 border border-cream-400/10 text-xs">
                        <div className="flex items-center justify-between gap-2 mb-0.5">
                          <span className="font-semibold text-gold-400">{comm.guestName}</span>
                          <span className="text-[10px] text-cream-400/60 shrink-0">
                            {formatTimeAgo(comm.createdAt)}
                          </span>
                        </div>
                        <p className="text-cream-200 leading-relaxed">{comm.commentText}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-cream-400/50 italic text-center py-4">
                  {i18n.t('lightbox.no_comments')}
                </p>
              )}
            </div>
          </div>

          {/* Action Bar */}
          <div className="p-4 border-t border-cream-400/10 bg-noir-900/90 space-y-3">
            {/* Emoji Reactions */}
            <div className="flex items-center gap-1 flex-wrap">
              {REACTIONS.map(({ kind, glyph, labelKey }) => {
                const reactedBy = (photo.reactions || []).filter((r) => r.reaction === kind);
                const count = reactedBy.length;
                const hasReacted = reactedBy.some((r) => r.guestId === currentGuest.id);
                if (count === 0 && !hasReacted) {
                  return (
                    <button
                      key={kind}
                      onClick={() => onReact(photo.id, kind)}
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
                    onClick={() => onReact(photo.id, kind)}
                    title={i18n.t(labelKey)}
                    className={`flex items-center gap-1 px-2 py-1 rounded-full text-xs transition-all ${
                      hasReacted
                        ? 'bg-gold-400/20 border border-gold-400/50 text-gold-300 font-bold'
                        : 'bg-noir-800/80 border border-cream-400/10 text-cream-300 hover:border-cream-400/30'
                    }`}
                  >
                    <span>{glyph}</span>
                    <span>{count}</span>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between gap-2">
              <button
                onClick={() => onLike(photo.id)}
                className={`flex items-center gap-2 px-3.5 py-1.5 rounded-full transition-all text-xs font-semibold ${
                  isLiked
                    ? 'bg-rosewood-500/20 text-rosewood-400 border border-rosewood-400/40'
                    : 'bg-noir-800 text-cream-300 hover:text-white border border-cream-400/15'
                }`}
              >
                <Heart className={`w-4 h-4 ${isLiked ? 'fill-rosewood-400' : ''}`} />
                <span>{photo.likesCount} {i18n.t('feed.likes')}</span>
              </button>

              <div className="flex items-center gap-1.5">
                {/* Copy Direct Public URL Button */}
                <button
                  onClick={handleCopyLink}
                  className={`flex items-center gap-1 px-2.5 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                    isCopied
                      ? 'bg-gold-400 text-noir-900 border-gold-400 font-bold'
                      : 'bg-noir-800 text-cream-300 hover:text-white border-cream-400/15'
                  }`}
                  title={i18n.t('lightbox.share_link')}
                >
                  {isCopied ? <Check className="w-3.5 h-3.5" /> : <Share2 className="w-3.5 h-3.5" />}
                  <span>{isCopied ? i18n.t('lightbox.copied_link') : i18n.t('lightbox.share_link')}</span>
                </button>

                {/* Download High-Res File */}
                <button
                  onClick={handleDownload}
                  className="p-1.5 rounded-full bg-noir-800 text-cream-300 hover:text-white border border-cream-400/15 transition-colors"
                  title={i18n.t('lightbox.download_photo')}
                >
                  <Download className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Comment Form */}
            <form onSubmit={handleSubmitComment} className="flex gap-2">
              <input
                type="text"
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder={i18n.t('lightbox.write_placeholder')}
                className="flex-1 px-3 py-2 rounded-xl bg-noir-800 border border-cream-400/20 text-xs text-cream-100 placeholder:text-cream-400/40 focus:outline-none focus:border-gold-400"
              />
              <button
                type="submit"
                disabled={!newComment.trim()}
                className="p-2 rounded-xl bg-gold-400 text-noir-900 font-bold hover:brightness-110 disabled:opacity-40 transition-all"
              >
                <Send className="w-4 h-4" />
              </button>
            </form>
          </div>
        </div>
      </div>
    </div>
  );
};
