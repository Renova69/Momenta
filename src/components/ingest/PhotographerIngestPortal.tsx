import React, { useCallback, useRef, useState } from 'react';
import { WeddingEvent } from '../../types';
import { ingestApi, IngestFailure } from '../../api/ingestApi';
import { ERROR_CODE_KEYS } from '../../api/apiClient';
import { i18n } from '../../i18n';
import {
  UploadCloud,
  Camera,
  CheckCircle2,
  Award,
  X,
  Image as ImageIcon,
  Loader2,
} from 'lucide-react';

interface PhotographerIngestPortalProps {
  event: WeddingEvent;
  onClose: () => void;
}

/** Answers the server sends no code for, said by their status. */
const REFUSAL_STATUS_KEYS: Record<number, string> = {
  401: 'ingest.reason_bad_key',
  404: 'ingest.reason_album_gone',
  413: 'ingest.reason_file_too_big',
  429: 'ingest.reason_too_fast',
};

/**
 * Why a file did not arrive, in the photographer's language (N-105): the
 * server's code first, then its status, then a general reason. Its own
 * English wording is never shown.
 */
function refusalText(failure: IngestFailure): string {
  if (failure.code === 'NETWORK') return i18n.t('ingest.reason_network');
  const key =
    (failure.code && ERROR_CODE_KEYS[failure.code]) ||
    (failure.status && REFUSAL_STATUS_KEYS[failure.status]) ||
    'ingest.portal_upload_failed';
  return i18n.t(key);
}

export const PhotographerIngestPortal: React.FC<PhotographerIngestPortalProps> = ({ event, onClose }) => {
  const [key, setKey] = useState<string>(() => {
    if (typeof window === 'undefined') return '';
    // Prefer the fragment (never sent to a server); fall back to the query
    // string so links shared before this change still work.
    const fromHash = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('key');
    const fromQuery = new URLSearchParams(window.location.search).get('key');
    return fromHash || fromQuery || '';
  });
  const [photographerName, setPhotographerName] = useState(i18n.t('ingest.default_label'));
  const [caption, setCaption] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [uploadedCount, setUploadedCount] = useState(0);
  // N-129 — in a moderated album the photos wait for the couple; "sent to
  // the live screen" told the photographer they were already up.
  const [awaitingApproval, setAwaitingApproval] = useState(0);
  const [error, setError] = useState('');
  const inputRef = useRef<HTMLInputElement | null>(null);

  const addFiles = useCallback((list: FileList | File[]) => {
    const accepted = Array.from(list).filter((f) => f.type.startsWith('image/'));
    setFiles((prev) => [...prev, ...accepted]);
    setUploadedCount(0);
    setError('');
  }, []);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer?.files) addFiles(e.dataTransfer.files);
  };

  const handleUpload = async () => {
    if (!key.trim()) {
      setError(i18n.t('ingest.portal_need_key'));
      return;
    }
    if (files.length === 0) {
      setError(i18n.t('ingest.portal_need_files'));
      return;
    }

    setIsUploading(true);
    setError('');
    setProgress(0);
    try {
      const { photos, failed } = await ingestApi.uploadPhotos(event.id, key.trim(), files, {
        photographerName: photographerName.trim() || i18n.t('ingest.default_label'),
        caption: caption.trim() || undefined,
        concurrency: 4,
        onProgress: (done, total) => setProgress(Math.round((done / total) * 100)),
      });
      // N-103 — a retry adds to what is already on the screen; it used to
      // replace it, so 8 frames and a retry of 2 read as "2 sent".
      setUploadedCount((sent) => sent + photos.length);
      setAwaitingApproval(
        (waiting) => waiting + photos.filter((photo) => (photo as { status?: string }).status === 'pending').length
      );
      // N-75 — only what did not arrive stays selected, so pressing Upload
      // again never sends a frame to the live screen twice.
      setFiles(failed.map((f) => f.file));
      if (failed.length > 0) {
        setError(
          i18n.t('ingest.portal_some_failed', {
            count: failed.length,
            total: files.length,
            reason: refusalText(failed[0]),
          })
        );
      }
    } catch (err) {
      setError((err instanceof Error ? err.message : '') || i18n.t('ingest.portal_upload_failed'));
    } finally {
      setIsUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-noir-950 text-cream-100 flex flex-col">
      <header className="sticky top-0 z-30 bg-noir-900/90 backdrop-blur-md border-b border-gold-400/20">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-gold-400/20 border border-gold-400/40 flex items-center justify-center">
              <Camera className="w-4.5 h-4.5 text-gold-400" />
            </div>
            <div>
              <h1 className="font-serif text-lg font-bold leading-tight">{i18n.t('ingest.portal_title')}</h1>
              <p className="text-[11px] text-cream-400/70">{event.title}</p>
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label={i18n.t('common.close')}
            className="p-2 rounded-full bg-noir-800 text-cream-300 hover:text-white"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
      </header>

      <main className="flex-1 max-w-5xl w-full mx-auto px-4 sm:px-6 py-8 space-y-6">
        {/* Key + identity */}
        <div className="bg-noir-800/80 rounded-3xl border border-gold-400/20 p-5 sm:p-6 space-y-4">
          <div className="flex items-center gap-2 text-gold-300">
            <Award className="w-5 h-5" />
            <span className="text-xs font-bold uppercase tracking-wider">{i18n.t('ingest.portal_badge_note')}</span>
          </div>

          <div>
            <label className="block text-xs font-semibold text-cream-300 mb-1">{i18n.t('ingest.portal_key_label')}</label>
            <input
              type="text"
              value={key}
              onChange={(e) => setKey(e.target.value)}
              placeholder="wmi_..."
              className="w-full px-3 py-2.5 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 font-mono focus:outline-none focus:border-gold-400"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold text-cream-300 mb-1">{i18n.t('ingest.portal_name_label')}</label>
              <input
                type="text"
                value={photographerName}
                onChange={(e) => setPhotographerName(e.target.value)}
                className="w-full px-3 py-2.5 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-cream-300 mb-1">{i18n.t('ingest.portal_caption_label')}</label>
              <input
                type="text"
                value={caption}
                onChange={(e) => setCaption(e.target.value)}
                placeholder={i18n.t('ingest.portal_caption_placeholder')}
                className="w-full px-3 py-2.5 rounded-xl bg-noir-900 border border-cream-400/20 text-xs text-cream-100 focus:outline-none focus:border-gold-400"
              />
            </div>
          </div>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => inputRef.current?.click()}
          className={`rounded-3xl border-2 border-dashed p-10 sm:p-14 text-center cursor-pointer transition-colors ${
            isDragging ? 'border-gold-400 bg-gold-400/10' : 'border-cream-400/20 bg-noir-800/60 hover:border-gold-400/40'
          }`}
        >
          <UploadCloud className={`w-12 h-12 mx-auto mb-3 ${isDragging ? 'text-gold-400' : 'text-cream-400/60'}`} />
          <h3 className="font-serif text-xl font-bold">{i18n.t('ingest.portal_drop')}</h3>
          <p className="text-xs text-cream-400/70 mt-1">{i18n.t('ingest.portal_browse')}</p>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => e.target.files && addFiles(e.target.files)}
          />
        </div>

        {/* Selected files */}
        {files.length > 0 && (
          <div className="bg-noir-800/60 rounded-2xl border border-cream-400/10 p-4">
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-cream-200 flex items-center gap-2">
                <ImageIcon className="w-4 h-4 text-gold-400" /> {i18n.t('ingest.files_selected', { count: files.length })}
              </span>
              <button onClick={() => setFiles([])} className="text-[11px] text-cream-400/70 hover:text-cream-200">{i18n.t('ingest.portal_clear')}</button>
            </div>
            <div className="grid grid-cols-4 sm:grid-cols-6 gap-2">
              {files.slice(0, 12).map((f, i) => (
                <div key={i} className="aspect-square rounded-lg bg-noir-900 overflow-hidden flex items-center justify-center text-[9px] text-cream-400/60 truncate p-1">
                  {f.name}
                </div>
              ))}
            </div>
          </div>
        )}

        {error && (
          <p className="text-xs text-rosewood-300 bg-rosewood-900/40 border border-rosewood-400/30 rounded-xl p-3">{error}</p>
        )}

        {uploadedCount > 0 && !isUploading && (
          <div className="flex items-center gap-2 text-sage-300 text-sm font-semibold">
            <CheckCircle2 className="w-5 h-5" />{' '}
            {awaitingApproval > 0
              ? i18n.t('ingest.portal_sent_pending', { count: uploadedCount })
              : i18n.t('ingest.portal_sent', { count: uploadedCount })}
          </div>
        )}

        <button
          onClick={handleUpload}
          disabled={isUploading}
          className="w-full py-4 rounded-2xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold shadow-glow hover:brightness-110 flex items-center justify-center gap-2 disabled:opacity-60"
        >
          {isUploading ? <Loader2 className="w-5 h-5 animate-spin" /> : <UploadCloud className="w-5 h-5" />}
          <span>
            {isUploading
              ? i18n.t('ingest.portal_uploading', { progress })
              : files.length > 0
                ? i18n.t('ingest.portal_upload_button', { count: files.length })
                : i18n.t('ingest.portal_upload_none')}
          </span>
        </button>
      </main>
    </div>
  );
};
