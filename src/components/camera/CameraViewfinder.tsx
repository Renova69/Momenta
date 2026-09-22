import React from 'react';
import { PhotoFilter } from '../../types';
import { i18n } from '../../i18n';
import { Camera, Image as ImageIcon, RefreshCw, X } from 'lucide-react';

/**
 * The live camera, the way a phone shows one: the picture is the screen and
 * the controls sit on top of it.
 *
 * It used to be a square viewport inside a padded card inside a modal, which
 * on a phone left the actual view of the room about a third of the display.
 * A guest framing a shot across a dark reception needs the frame, not the
 * chrome.
 */

export interface CameraViewfinderProps {
  /** Applied live to the preview so the guest frames the shot they will get. */
  filter: PhotoFilter;
  filters: { id: PhotoFilter; label: string; previewColor: string }[];
  onSelectFilter: (filter: PhotoFilter) => void;
  onShutter: () => void;
  onPickFromGallery: () => void;
  onUsePhoneCamera: () => void;
  onFlipCamera: () => void;
  onClose: () => void;
  /** Hidden while the camera cannot show a picture — there is nothing to flip. */
  canFlip: boolean;
  /** Thumbnails of what has already gone up in this session, newest first. */
  sent: string[];
  questTitle?: string;
}

/** The same CSS the compression pass bakes in, so the preview is not a lie. */
export const FILTER_PREVIEW_CSS: Record<PhotoFilter, string> = {
  original: 'none',
  golden_glow: 'saturate(1.25) contrast(1.05) sepia(0.18) brightness(1.04)',
  vintage_warmth: 'sepia(0.4) saturate(1.2) contrast(0.95) brightness(1.02)',
  black_white: 'grayscale(1) contrast(1.1)',
  film_grain: 'contrast(1.08) saturate(0.9) sepia(0.12)',
};

export const CameraViewfinder: React.FC<CameraViewfinderProps> = ({
  filter,
  filters,
  onSelectFilter,
  onShutter,
  onPickFromGallery,
  onUsePhoneCamera,
  onFlipCamera,
  onClose,
  canFlip,
  sent,
  questTitle,
}) => (
  <>
    {/* Top bar — over the picture, not above it. */}
    <div
      className="absolute inset-x-0 top-0 z-20 flex items-start justify-between gap-3 p-4 bg-gradient-to-b from-black/70 to-transparent"
      style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={i18n.t('common.close')}
        className="w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm text-white flex items-center justify-center active:scale-95 transition-transform"
      >
        <X className="w-5 h-5" />
      </button>

      {questTitle && (
        <span className="mt-1 px-3 py-1 rounded-full bg-gold-400/90 text-noir-900 text-[11px] font-bold truncate max-w-[55%]">
          {questTitle}
        </span>
      )}

      {canFlip ? (
        <button
          type="button"
          onClick={onFlipCamera}
          aria-label={i18n.t('camera.flip')}
          className="w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm text-white flex items-center justify-center active:scale-95 transition-transform"
        >
          <RefreshCw className="w-5 h-5" />
        </button>
      ) : (
        <span className="w-10" />
      )}
    </div>

    {/* Bottom controls. */}
    <div
      className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/85 via-black/60 to-transparent pt-8"
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      {/* Filters, chosen before the shot the way a camera app does. */}
      <div className="flex gap-2 overflow-x-auto px-4 pb-3 no-scrollbar">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onSelectFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-semibold border transition-all ${
              filter === f.id
                ? 'bg-gold-400 text-noir-900 border-gold-400'
                : 'bg-black/40 text-cream-200 border-white/20 backdrop-blur-sm'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="flex items-center justify-between px-8 pb-2">
        <button
          type="button"
          onClick={onPickFromGallery}
          aria-label={i18n.t('camera.gallery')}
          className="w-12 h-12 rounded-xl overflow-hidden border border-white/30 bg-black/40 backdrop-blur-sm flex items-center justify-center active:scale-95 transition-transform"
        >
          {sent[0] ? (
            <img src={sent[0]} alt="" className="w-full h-full object-cover" />
          ) : (
            <ImageIcon className="w-5 h-5 text-white" />
          )}
        </button>

        {/* The shutter: big, centred, and reachable with a thumb. */}
        <button
          type="button"
          onClick={onShutter}
          aria-label={i18n.t('camera.shutter')}
          className="w-[72px] h-[72px] rounded-full border-4 border-white/90 p-1 active:scale-90 transition-transform"
        >
          <span className="block w-full h-full rounded-full bg-white shadow-inner" />
        </button>

        <button
          type="button"
          onClick={onUsePhoneCamera}
          aria-label={i18n.t('camera.phone_cam')}
          className="w-12 h-12 rounded-xl border border-white/30 bg-black/40 backdrop-blur-sm flex items-center justify-center active:scale-95 transition-transform"
        >
          <Camera className="w-5 h-5 text-gold-400" />
        </button>
      </div>

      {sent.length > 0 && (
        <p className="text-center text-[11px] text-cream-200/80 pb-1">
          {i18n.t('camera.sent_count', { count: sent.length })}
        </p>
      )}
    </div>
  </>
);
