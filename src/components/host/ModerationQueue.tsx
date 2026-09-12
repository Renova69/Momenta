import React, { useState } from 'react';
import { Photo, PhotoStatus } from '../../types';
import { i18n } from '../../i18n';
import {
  Check,
  X,
  Sparkles,
  Shield,
  Clock,
  Eye,
  Trash2,
  ListChecks,
  CheckSquare,
  Square
} from 'lucide-react';

interface ModerationQueueProps {
  photos: Photo[];
  onSetStatus: (photoId: string, status: PhotoStatus) => void;
  onDeletePhoto: (photoId: string) => void;
}

export const ModerationQueue: React.FC<ModerationQueueProps> = ({
  photos,
  onSetStatus,
  onDeletePhoto,
}) => {
  const pendingPhotos = photos.filter((p) => p.status === 'pending');
  const approvedPhotos = photos.filter((p) => p.status === 'approved');
  const featuredPhotos = photos.filter((p) => p.status === 'featured');

  const [isSelecting, setIsSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelectMode = () => {
    setIsSelecting((prev) => !prev);
    setSelectedIds(new Set());
  };

  const toggleSelected = (photoId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(photoId)) next.delete(photoId);
      else next.add(photoId);
      return next;
    });
  };

  const handleSingleDelete = (photoId: string) => {
    if (window.confirm(i18n.t('host.delete_confirm'))) {
      onDeletePhoto(photoId);
    }
  };

  const handleDeleteSelected = () => {
    if (selectedIds.size === 0) return;
    if (window.confirm(i18n.t('host.delete_selected_confirm', { count: selectedIds.size }))) {
      selectedIds.forEach((id) => onDeletePhoto(id));
      setSelectedIds(new Set());
      setIsSelecting(false);
    }
  };

  return (
    <div className="space-y-6">
      
      {/* Moderation Banner */}
      <div className="bg-noir-800/80 rounded-2xl p-4 border border-cream-400/10 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gold-400/20 flex items-center justify-center text-gold-400">
            <Shield className="w-5 h-5" />
          </div>
          <div>
            <h4 className="font-semibold text-sm text-cream-100">
              {i18n.t('host.moderation_title')}
            </h4>
            <p className="text-xs text-cream-400/70">
              {i18n.t('host.moderation_desc')}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 text-xs">
          <span className="px-2.5 py-1 rounded-full bg-rosewood-500/20 text-rosewood-300 font-bold border border-rosewood-400/30">
            {i18n.t('moderation.pending_count', { count: pendingPhotos.length })}
          </span>
          <span className="px-2.5 py-1 rounded-full bg-gold-400/20 text-gold-300 font-bold border border-gold-400/30">
            {featuredPhotos.length} {i18n.t('host.tv_featured')}
          </span>
        </div>
      </div>

      {/* PENDING APPROVAL QUEUE */}
      <div className="space-y-3">
        <h4 className="font-serif text-lg font-bold text-cream-100 flex items-center gap-2">
          <Clock className="w-4 h-4 text-gold-400" />
          <span>{i18n.t('host.needs_review')} ({pendingPhotos.length})</span>
        </h4>

        {pendingPhotos.length > 0 ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {pendingPhotos.map((photo) => (
              <div
                key={photo.id}
                className="bg-noir-800 rounded-2xl border border-cream-400/15 overflow-hidden shadow-lg flex flex-col"
              >
                <div className="relative aspect-[4/3] bg-black">
                  <img
                    src={photo.thumbnailUrl || photo.fullUrl}
                    alt="Pending review"
                    className="w-full h-full object-cover"
                  />
                  <div className="absolute top-2 left-2 px-2 py-0.5 rounded-md bg-black/60 text-[10px] text-cream-300 font-medium">
                    {photo.guestName} ({photo.guestTable || i18n.t('moderation.no_table')})
                  </div>
                </div>

                <div className="p-3 flex-1 flex flex-col justify-between">
                  {photo.caption && (
                    <p className="text-xs text-cream-300 italic mb-3">"{photo.caption}"</p>
                  )}

                  <div className="flex items-center gap-2 pt-2 border-t border-cream-400/10">
                    <button
                      onClick={() => onSetStatus(photo.id, 'approved')}
                      className="flex-1 py-1.5 rounded-xl bg-sage-500/20 hover:bg-sage-500/30 text-sage-300 border border-sage-400/40 text-xs font-semibold flex items-center justify-center gap-1 transition-colors"
                    >
                      <Check className="w-3.5 h-3.5" />
                      <span>{i18n.t('host.approve')}</span>
                    </button>

                    <button
                      onClick={() => onSetStatus(photo.id, 'featured')}
                      className="flex-1 py-1.5 rounded-xl bg-gold-400 text-noir-900 font-bold text-xs flex items-center justify-center gap-1 shadow-glow hover:brightness-110 transition-all"
                    >
                      <Sparkles className="w-3.5 h-3.5 fill-noir-900" />
                      <span>{i18n.t('host.feature')}</span>
                    </button>

                    <button
                      onClick={() => onSetStatus(photo.id, 'rejected')}
                      className="p-1.5 rounded-xl bg-rosewood-500/20 hover:bg-rosewood-500/30 text-rosewood-300 border border-rosewood-400/40 transition-colors"
                      title={i18n.t('host.reject')}
                    >
                      <X className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="p-8 text-center rounded-2xl bg-noir-800/40 border border-cream-400/10 text-xs text-cream-400/70">
            {i18n.t('host.all_caught_up')}
          </div>
        )}
      </div>

      {/* ALL ACTIVE PHOTOS MANAGEMENT */}
      <div className="space-y-3 pt-6 border-t border-cream-400/10">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <h4 className="font-serif text-lg font-bold text-cream-100 flex items-center gap-2">
            <Eye className="w-4 h-4 text-gold-400" />
            <span>{i18n.t('host.active_photos')} ({approvedPhotos.length + featuredPhotos.length})</span>
          </h4>

          <button
            type="button"
            onClick={toggleSelectMode}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-semibold border transition-colors ${
              isSelecting
                ? 'bg-gold-400/20 text-gold-300 border-gold-400/40'
                : 'bg-noir-800 text-cream-300 border-cream-400/10 hover:bg-noir-700'
            }`}
          >
            <ListChecks className="w-3.5 h-3.5" />
            <span>{isSelecting ? i18n.t('host.cancel_selection') : i18n.t('host.select_photos')}</span>
          </button>
        </div>

        {isSelecting && selectedIds.size > 0 && (
          <div className="flex items-center justify-between gap-3 bg-rosewood-500/10 border border-rosewood-400/30 rounded-xl px-4 py-2.5">
            <span className="text-xs font-semibold text-rosewood-200">
              {i18n.t('host.selected_count', { count: selectedIds.size })}
            </span>
            <button
              type="button"
              onClick={handleDeleteSelected}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-rosewood-600 hover:bg-rosewood-500 text-white text-xs font-bold transition-colors"
            >
              <Trash2 className="w-3.5 h-3.5" />
              <span>{i18n.t('host.delete_selected')}</span>
            </button>
          </div>
        )}

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-3">
          {[...featuredPhotos, ...approvedPhotos].map((photo) => {
            const isFeatured = photo.status === 'featured';
            const isSelected = selectedIds.has(photo.id);

            return (
              <div
                key={photo.id}
                onClick={isSelecting ? () => toggleSelected(photo.id) : undefined}
                className={`group relative rounded-xl overflow-hidden border bg-noir-800 aspect-square ${
                  isSelecting ? 'cursor-pointer' : ''
                } ${isSelected ? 'border-gold-400 ring-2 ring-gold-400/50' : 'border-cream-400/10'}`}
              >
                <img
                  src={photo.thumbnailUrl || photo.fullUrl}
                  alt="Approved"
                  className="w-full h-full object-cover"
                />

                {isFeatured && (
                  <div className="absolute top-1.5 left-1.5 px-1.5 py-0.5 rounded bg-gold-400 text-noir-900 text-[9px] font-bold">
                    {i18n.t('host.tv_featured')}
                  </div>
                )}

                {isSelecting ? (
                  <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-md bg-black/60 flex items-center justify-center text-gold-300">
                    {isSelected ? <CheckSquare className="w-4 h-4" /> : <Square className="w-4 h-4" />}
                  </div>
                ) : (
                  /* Hover overlay actions */
                  <div className="absolute inset-0 bg-black/75 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col items-center justify-center gap-1.5 p-2">
                    <button
                      onClick={() => onSetStatus(photo.id, isFeatured ? 'approved' : 'featured')}
                      className="w-full py-1 rounded bg-gold-400 text-noir-900 font-bold text-[10px] flex items-center justify-center gap-1"
                    >
                      <Sparkles className="w-3 h-3" />
                      <span>{isFeatured ? i18n.t('host.unfeature') : i18n.t('host.feature_tv')}</span>
                    </button>

                    <button
                      onClick={() => handleSingleDelete(photo.id)}
                      className="w-full py-1 rounded bg-rosewood-600/80 hover:bg-rosewood-600 text-white text-[10px] flex items-center justify-center gap-1"
                    >
                      <Trash2 className="w-3 h-3" />
                      <span>{i18n.t('host.delete')}</span>
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};
