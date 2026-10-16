/**
 * The album's cover (N-139): the photo behind the couple's names at the top
 * of the album. Nothing in the studio set one, so every album's top section
 * was the gradient alone.
 *
 * Upload is the first way, because the cover matters most before the wedding,
 * when the album is still empty: an engagement photo, say. Choosing from the
 * album is the second, and offers only photos guests can already see — the
 * server refuses any other, so the cover cannot show a photo still waiting for
 * moderation or for the disposable reveal. Either way the server keeps its own
 * copy, so deleting the photo later leaves the cover in place.
 */

import React, { useId, useState } from 'react';
import { ImageIcon, Upload, Images, Trash2, X } from 'lucide-react';
import { i18n } from '../../../i18n';
import { compressAndFilterImage } from '../../../services/compressionService';
import { useDialog } from '../../../hooks/useDialog';
import { photoAlt } from '../../../utils/photoAlt';
import type { Photo } from '../../../types';
import type { CoverSource } from '../../../api/eventsApi';

/** The cover is stored at display size; there is no use sending more. */
const COVER_UPLOAD_EDGE = 1600;

interface CoverPhotoFieldProps {
  coverImageUrl?: string | null;
  photos: Photo[];
  onSetCover: (source: CoverSource) => Promise<void>;
  onRemoveCover: () => Promise<void>;
}

/** What a guest's feed shows: approved or featured, not locked for the reveal. */
function guestsCanSee(photo: Photo): boolean {
  return (photo.status === 'approved' || photo.status === 'featured') && !photo.isLocked;
}

function messageOf(err: unknown): string {
  return err instanceof Error && err.message ? err.message : i18n.t('host.cover_failed');
}

export const CoverPhotoField: React.FC<CoverPhotoFieldProps> = ({ coverImageUrl, photos, onSetCover, onRemoveCover }) => {
  const uploadId = useId();
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPicking, setIsPicking] = useState(false);

  const save = async (work: () => Promise<void>) => {
    setIsSaving(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setIsSaving(false);
    }
  };

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    await save(async () => {
      const { dataUrl } = await compressAndFilterImage(file, { maxWidth: COVER_UPLOAD_EDGE, maxHeight: COVER_UPLOAD_EDGE });
      await onSetCover({ image: dataUrl });
    });
  };

  const handlePick = async (photoId: string) => {
    setIsPicking(false);
    await save(() => onSetCover({ photoId }));
  };

  const handleRemove = async () => {
    if (!window.confirm(i18n.t('host.cover_remove_confirm'))) return;
    await save(onRemoveCover);
  };

  const buttonClass =
    'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold border transition-colors disabled:opacity-50';

  return (
    <div>
      <span className="block text-xs font-semibold text-cream-300 mb-1">{i18n.t('host.cover_title')}</span>
      <p className="text-[11px] text-cream-400 mb-2">{i18n.t('host.cover_hint')}</p>

      <div className="relative h-28 rounded-2xl overflow-hidden border border-cream-400/10 bg-linear-to-br from-noir-900 via-noir-800 to-gold-900/30">
        {coverImageUrl ? (
          <img src={coverImageUrl} alt={i18n.t('host.cover_current_alt')} className="w-full h-full object-cover" />
        ) : (
          <div className="w-full h-full flex items-center justify-center gap-2 text-cream-400 text-xs">
            <ImageIcon className="w-4 h-4" aria-hidden="true" />
            <span>{i18n.t('host.cover_none')}</span>
          </div>
        )}
        {isSaving && (
          <div role="status" className="absolute inset-0 flex items-center justify-center bg-noir-900/70 text-cream-100 text-xs">
            {i18n.t('host.cover_saving')}
          </div>
        )}
      </div>

      <div className="flex flex-wrap gap-2 mt-2">
        <label
          htmlFor={uploadId}
          className={`${buttonClass} cursor-pointer bg-gold-400/10 border-gold-400/40 text-gold-300 hover:bg-gold-400/20 focus-within:ring-2 focus-within:ring-gold-400`}
        >
          <Upload className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{i18n.t('host.cover_upload')}</span>
          <input
            id={uploadId}
            type="file"
            accept="image/*"
            className="sr-only"
            disabled={isSaving}
            onChange={handleUpload}
          />
        </label>
        <button
          type="button"
          onClick={() => setIsPicking(true)}
          disabled={isSaving}
          className={`${buttonClass} bg-noir-900 border-cream-400/20 text-cream-200 hover:border-gold-400/50`}
        >
          <Images className="w-3.5 h-3.5" aria-hidden="true" />
          <span>{i18n.t('host.cover_pick')}</span>
        </button>
        {coverImageUrl && (
          <button
            type="button"
            onClick={handleRemove}
            disabled={isSaving}
            className={`${buttonClass} bg-noir-900 border-cream-400/20 text-cream-300 hover:text-rosewood-300 hover:border-rosewood-400/50`}
          >
            <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            <span>{i18n.t('host.cover_remove')}</span>
          </button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-2 text-xs text-rosewood-300">
          {error}
        </p>
      )}

      {isPicking && (
        <CoverPicker photos={photos.filter(guestsCanSee)} onPick={handlePick} onClose={() => setIsPicking(false)} />
      )}
    </div>
  );
};

interface CoverPickerProps {
  photos: Photo[];
  onPick: (photoId: string) => void;
  onClose: () => void;
}

const CoverPicker: React.FC<CoverPickerProps> = ({ photos, onPick, onClose }) => {
  const titleId = useId();
  const { dialogRef, dialogProps } = useDialog({ onClose, labelledBy: titleId });

  return (
    <div
      ref={dialogRef}
      {...dialogProps}
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/85 backdrop-blur-md animate-fade-in"
    >
      <div className="relative w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-3xl bg-noir-900 border border-gold-400/30 p-5 sm:p-6">
        <button
          type="button"
          onClick={onClose}
          aria-label={i18n.t('common.close')}
          className="absolute top-3 right-3 p-2 rounded-full bg-noir-800 text-cream-300 hover:text-white"
        >
          <X className="w-4 h-4" aria-hidden="true" />
        </button>
        <h2 id={titleId} className="font-serif text-xl font-bold text-cream-100 mb-4 pr-10">
          {i18n.t('host.cover_pick_title')}
        </h2>
        {photos.length === 0 ? (
          <p className="text-sm text-cream-300">{i18n.t('host.cover_pick_empty')}</p>
        ) : (
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {photos.map((p) => (
              <button
                key={p.id}
                type="button"
                onClick={() => onPick(p.id)}
                aria-label={photoAlt(p)}
                className="aspect-square rounded-xl overflow-hidden border border-cream-400/10 hover:border-gold-400 focus-visible:border-gold-400 transition-colors"
              >
                <img src={p.thumbnailUrl || p.fullUrl} alt="" loading="lazy" className="w-full h-full object-cover" />
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
