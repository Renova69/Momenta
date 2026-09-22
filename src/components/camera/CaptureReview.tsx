import React from 'react';
import { PhotoFilter, ScavengerQuest } from '../../types';
import { i18n } from '../../i18n';
import { Check, Trophy, UploadCloud, X } from 'lucide-react';

/**
 * What a guest sees the instant after the shutter: their photograph, whole,
 * with everything else laid over it.
 *
 * The note, the quest and the filter used to live in a scrolling panel below
 * a boxed thumbnail. Here the picture is the screen, and the sheet over the
 * bottom of it is small enough to see what you photographed while you write
 * about it.
 */

export interface CaptureReviewProps {
  filter: PhotoFilter;
  filters: { id: PhotoFilter; label: string; previewColor: string }[];
  onSelectFilter: (filter: PhotoFilter) => void;
  quests: ScavengerQuest[];
  selectedQuestId: string;
  onSelectQuest: (questId: string) => void;
  caption: string;
  onCaptionChange: (caption: string) => void;
  onRetake: () => void;
  onSend: () => void;
  /** True while the filtered copy is still being made. */
  isProcessing: boolean;
  /** How many photos are in this gallery selection, when it is more than one. */
  batchCount: number;
  fieldIds: string;
}

export const CaptureReview: React.FC<CaptureReviewProps> = ({
  filter,
  filters,
  onSelectFilter,
  quests,
  selectedQuestId,
  onSelectQuest,
  caption,
  onCaptionChange,
  onRetake,
  onSend,
  isProcessing,
  batchCount,
  fieldIds,
}) => (
  <>
    <div
      className="absolute inset-x-0 top-0 z-20 flex items-center justify-between p-4 bg-gradient-to-b from-black/70 to-transparent"
      style={{ paddingTop: 'max(1rem, env(safe-area-inset-top))' }}
    >
      <button
        type="button"
        onClick={onRetake}
        aria-label={i18n.t('camera.retake')}
        className="w-10 h-10 rounded-full bg-black/50 backdrop-blur-sm text-white flex items-center justify-center active:scale-95 transition-transform"
      >
        <X className="w-5 h-5" />
      </button>
      {batchCount > 1 && (
        <span className="px-3 py-1 rounded-full bg-black/60 backdrop-blur-sm text-cream-100 text-[11px] font-semibold">
          {i18n.t('camera.upload_count', { count: batchCount })}
        </span>
      )}
      <span className="w-10" />
    </div>

    <div
      className="absolute inset-x-0 bottom-0 z-20 bg-gradient-to-t from-black/90 via-black/75 to-transparent pt-10 px-4 space-y-3"
      style={{ paddingBottom: 'max(1rem, env(safe-area-inset-bottom))' }}
    >
      <div className="flex gap-2 overflow-x-auto no-scrollbar">
        {filters.map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => onSelectFilter(f.id)}
            aria-pressed={filter === f.id}
            className={`shrink-0 px-3 py-1.5 rounded-full text-[11px] font-semibold border transition-all flex items-center gap-1 ${
              filter === f.id
                ? 'bg-gold-400 text-noir-900 border-gold-400'
                : 'bg-black/40 text-cream-200 border-white/20 backdrop-blur-sm'
            }`}
          >
            {filter === f.id && <Check className="w-3 h-3" />}
            {f.label}
          </button>
        ))}
      </div>

      {quests.length > 0 && (
        <div className="flex items-center gap-2">
          <Trophy className="w-4 h-4 text-gold-400 shrink-0" />
          <label htmlFor={`${fieldIds}-quest`} className="sr-only">
            {i18n.t('camera.tag_quest')}
          </label>
          <select
            id={`${fieldIds}-quest`}
            value={selectedQuestId}
            onChange={(e) => onSelectQuest(e.target.value)}
            className="flex-1 px-3 py-2 rounded-xl bg-black/50 backdrop-blur-sm border border-white/20 text-cream-100 text-xs focus:outline-none focus:border-gold-400"
          >
            <option value="">{i18n.t('camera.no_quest')}</option>
            {quests.map((q) => (
              <option key={q.id} value={q.id}>
                {q.title} (+{q.points} {i18n.t('quests.pts')})
              </option>
            ))}
          </select>
        </div>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1">
          <label htmlFor={`${fieldIds}-note`} className="sr-only">
            {i18n.t('camera.leave_note')}
          </label>
          <textarea
            id={`${fieldIds}-note`}
            value={caption}
            onChange={(e) => onCaptionChange(e.target.value)}
            placeholder={i18n.t('camera.note_placeholder')}
            rows={2}
            maxLength={240}
            className="w-full px-3 py-2.5 rounded-xl bg-black/50 backdrop-blur-sm border border-white/20 text-cream-100 text-xs placeholder:text-cream-300/50 focus:outline-none focus:border-gold-400 resize-none"
          />
        </div>

        <button
          type="button"
          onClick={onSend}
          disabled={isProcessing}
          aria-label={i18n.t('camera.share_button')}
          className="w-14 h-14 shrink-0 rounded-full bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 shadow-glow flex items-center justify-center active:scale-95 transition-transform disabled:opacity-50"
        >
          <UploadCloud className="w-6 h-6" />
        </button>
      </div>
    </div>
  </>
);
