import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Guest, ScavengerQuest, PhotoFilter } from '../../types';
import { compressAndFilterImage } from '../../services/compressionService';
import { checkMediaSupport, mediaBlockMessageKey } from '../../utils/mediaSupport';
import { i18n } from '../../i18n';
import confetti from 'canvas-confetti';
import {
  X,
  Camera,
  RefreshCw,
  UploadCloud,
  Sparkles,
  Check,
  Trophy,
  Sliders,
  Image as ImageIcon,
  ShieldAlert,
} from 'lucide-react';

interface CameraCaptureModalProps {
  isOpen: boolean;
  onClose: () => void;
  currentGuest: Guest;
  quests: ScavengerQuest[];
  selectedQuestId?: string;
  onPhotoUploaded: (photoData: {
    guestId: string;
    guestName: string;
    guestAvatar?: string;
    guestTable?: string;
    fullUrl: string;
    thumbnailUrl?: string;
    originalUrl?: string;
    caption?: string;
    filterApplied: PhotoFilter;
    questId?: string;
    questTitle?: string;
  }) => void;
}

// SEC-W3: cap on how many files a single bulk selection processes.
const MAX_BULK_UPLOAD_FILES = 10;

const FILTERS: { id: PhotoFilter; label: string; previewColor: string }[] = [
  { id: 'original', label: i18n.t('filter.original'), previewColor: 'from-neutral-700 to-neutral-900' },
  { id: 'golden_glow', label: i18n.t('filter.golden_glow'), previewColor: 'from-amber-600 to-yellow-800' },
  { id: 'vintage_warmth', label: i18n.t('filter.vintage_warmth'), previewColor: 'from-orange-700 to-amber-900' },
  { id: 'black_white', label: i18n.t('filter.black_white'), previewColor: 'from-neutral-400 to-neutral-800' },
  { id: 'film_grain', label: i18n.t('filter.film_grain'), previewColor: 'from-stone-600 to-stone-900' },
];

export const CameraCaptureModal: React.FC<CameraCaptureModalProps> = ({
  isOpen,
  onClose,
  currentGuest,
  quests,
  selectedQuestId: initialQuestId,
  onPhotoUploaded,
}) => {
  const [capturedRawUrl, setCapturedRawUrl] = useState<string | null>(null);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<PhotoFilter>('golden_glow');
  const [caption, setCaption] = useState('');
  const [selectedQuestId, setSelectedQuestId] = useState<string>(initialQuestId || '');
  const [isProcessing, setIsProcessing] = useState(false);
  const [useFrontCamera, setUseFrontCamera] = useState(false);

  // Permission and stream states
  const [permissionState, setPermissionState] = useState<'prompt' | 'granted' | 'denied' | 'unsupported'>('prompt');
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [, setIsStartingCamera] = useState(false);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nativeCameraInputRef = useRef<HTMLInputElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);

  const stopCamera = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }
  }, []);

  const startCamera = useCallback(async () => {
    // On a plain-HTTP LAN address the camera API is not merely blocked, it is
    // absent — say so, rather than telling the guest to tap a button that
    // cannot work.
    const support = checkMediaSupport();
    if (!support.available) {
      setPermissionState('unsupported');
      setCameraError(i18n.t(mediaBlockMessageKey(support.reason), { origin: support.origin }));
      return;
    }

    setIsStartingCamera(true);
    setCameraError(null);

    try {
      stopCamera();

      const constraints: MediaStreamConstraints = {
        video: {
          facingMode: useFrontCamera ? 'user' : 'environment',
          // This frame is archived as the original, so request the highest
          // resolution the device offers; browsers clamp `ideal` to what exists.
          width: { ideal: 4096 },
          height: { ideal: 3072 },
        },
        audio: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      streamRef.current = stream;
      setPermissionState('granted');

      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.onloadedmetadata = () => {
          videoRef.current?.play().catch(() => {});
        };
      }
    } catch (err: unknown) {
      console.warn('[Camera Permission Error]:', err);
      const isError = err instanceof Error;
      if (isError && (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError')) {
        setPermissionState('denied');
        setCameraError(i18n.t('camera.permission_subtitle'));
      } else {
        setPermissionState('unsupported');
        setCameraError(isError ? (err instanceof Error ? err.message : String(err)) : i18n.t('camera.permission_subtitle'));
      }
    } finally {
      setIsStartingCamera(false);
    }
  }, [useFrontCamera, stopCamera]);

  useEffect(() => {
    if (isOpen && !capturedRawUrl) {
      if (navigator.permissions && navigator.permissions.query) {
        navigator.permissions
          .query({ name: 'camera' as PermissionName })
          .then((status) => {
            if (status.state === 'granted') {
              setPermissionState('granted');
              startCamera();
            } else if (status.state === 'denied') {
              setPermissionState('denied');
              setCameraError(i18n.t('camera.permission_subtitle'));
            } else {
              setPermissionState('prompt');
              startCamera();
            }
          })
          .catch(() => {
            startCamera();
          });
      } else {
        startCamera();
      }
    } else {
      stopCamera();
    }

    return () => {
      stopCamera();
    };
  }, [isOpen, capturedRawUrl, useFrontCamera, startCamera, stopCamera]);

  useEffect(() => {
    if (initialQuestId) {
      setSelectedQuestId(initialQuestId);
    }
  }, [initialQuestId]);

  // Re-apply the filter when the guest picks a different one. `capturedRawUrl`
  // is read from the current render but deliberately not a dependency: a new
  // capture already applies the filter in its own handler, so depending on it
  // here would filter every photo twice.
  useEffect(() => {
    if (capturedRawUrl) {
      applyFilterToCaptured(capturedRawUrl, selectedFilter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedFilter]);

  const snapPhotoFromVideo = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    if (useFrontCamera) {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }

    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
    setCapturedRawUrl(dataUrl);
    applyFilterToCaptured(dataUrl, selectedFilter);
    stopCamera();
  };

  const [isUploadingMultiple, setIsUploadingMultiple] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [totalFiles, setTotalFiles] = useState(0);

  const [bulkFiles, setBulkFiles] = useState<File[]>([]);
  // SEC-W3: an uncapped bulk selection piles up one full-size data: URL per
  // file, all resident in memory before any of them finish compressing -
  // 20+ photos from a phone camera is enough to get the tab killed by the
  // OS on mobile RAM budgets. Track how many were dropped so the UI can say so.
  const [bulkTruncatedFrom, setBulkTruncatedFrom] = useState<number | null>(null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    if (files.length > 1) {
      const selected = Array.from(files);
      if (selected.length > MAX_BULK_UPLOAD_FILES) {
        setBulkTruncatedFrom(selected.length);
        setBulkFiles(selected.slice(0, MAX_BULK_UPLOAD_FILES));
      } else {
        setBulkTruncatedFrom(null);
        setBulkFiles(selected);
      }
    } else {
      setBulkTruncatedFrom(null);
      setBulkFiles([]);
    }

    // The confirm/upload button only needs `capturedRawUrl` truthy, so this
    // preview read must stay a plain, immediate FileReader byte-encode — not
    // gated on decoding the image. `applyFilterToCaptured` below fills in the
    // actual filtered preview in the background; the OOM fix for a large
    // multi-photo selection lives in handleConfirmUpload's per-file loop,
    // which is what actually decodes every photo in the batch sequentially —
    // this single preview thumbnail for file[0] was never that risk.
    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        const rawUrl = event.target.result as string;
        setCapturedRawUrl(rawUrl);
        applyFilterToCaptured(rawUrl, selectedFilter);
        stopCamera();
      }
    };
    reader.readAsDataURL(files[0]);
    e.target.value = '';
  };

  const applyFilterToCaptured = async (rawUrl: string, filter: PhotoFilter) => {
    setIsProcessing(true);
    try {
      const result = await compressAndFilterImage(rawUrl, {
        maxWidth: 1600,
        maxHeight: 1600,
        quality: 0.85,
        filter,
      });
      setProcessedUrl(result.dataUrl);
    } catch (err) {
      console.error('Filter processing error:', err);
      setProcessedUrl(rawUrl);
    } finally {
      setIsProcessing(false);
    }
  };

  const handleRetake = () => {
    setCapturedRawUrl(null);
    setProcessedUrl(null);
    setBulkFiles([]);
    setBulkTruncatedFrom(null);
    setCaption('');
    setCameraError(null);
    startCamera();
  };

  const handleConfirmUpload = async () => {
    if (!processedUrl && bulkFiles.length === 0) return;

    const attachedQuest = quests.find((q) => q.id === selectedQuestId);

    if (bulkFiles.length > 1) {
      setIsUploadingMultiple(true);
      setTotalFiles(bulkFiles.length);
      setUploadProgress(0);

      for (let i = 0; i < bulkFiles.length; i++) {
        try {
          const file = bulkFiles[i];

          // Compress and filter — decodes the File directly via
          // createImageBitmap (compressionService.ts), not a data: URL, so a
          // full-resolution gallery original is never held as a giant base64
          // string or a redundant <img>-internal bitmap while this loop
          // processes the rest of the batch one at a time.
          const compressed = await compressAndFilterImage(file, {
            maxWidth: 1600,
            maxHeight: 1600,
            quality: 0.85,
            filter: selectedFilter,
          });

          // The archived original still needs to travel to the server as a
          // data: URL (POST /api/photos is JSON, not multipart) — a
          // byte-level base64 encode, not a pixel decode, so it does not
          // carry the same OOM risk the compression step above did.
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const r = new FileReader();
            r.onload = (ev) => (ev.target?.result ? resolve(ev.target.result as string) : reject(new Error('read failed')));
            r.onerror = () => reject(new Error('read failed'));
            r.readAsDataURL(file);
          });

          // Upload
          onPhotoUploaded({
            guestId: currentGuest.id,
            guestName: currentGuest.name,
            guestAvatar: currentGuest.avatarUrl,
            guestTable: currentGuest.tableNumber,
            // Display copy carries the filter; the original is archived for the
            // high-resolution export. The server derives the thumbnail.
            fullUrl: compressed.dataUrl,
            originalUrl: dataUrl,
            caption: caption.trim() || undefined,
            filterApplied: selectedFilter,
            questId: attachedQuest?.id,
            questTitle: attachedQuest?.title,
          });
        } catch (err) {
          console.error(`[Camera] Error processing bulk file ${i}:`, err);
          // Skip this photo and continue with others instead of freezing
        } finally {
          setUploadProgress(i + 1);
        }
      }
      setIsUploadingMultiple(false);
    } else {
      onPhotoUploaded({
        guestId: currentGuest.id,
        guestName: currentGuest.name,
        guestAvatar: currentGuest.avatarUrl,
        guestTable: currentGuest.tableNumber,
        fullUrl: processedUrl!,
        originalUrl: capturedRawUrl ?? undefined,
        caption: caption.trim() || undefined,
        filterApplied: selectedFilter,
        questId: attachedQuest?.id,
        questTitle: attachedQuest?.title,
      });
    }

    confetti({
      particleCount: 80,
      spread: 70,
      origin: { y: 0.6 },
      colors: ['#D4AF37', '#F5EFE0', '#D98991', '#84A784'],
    });

    handleRetake();
    onClose();
  };

  if (!isOpen) return null;

  if (isUploadingMultiple) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/90 backdrop-blur-md animate-fade-in">
        <div className="relative w-full max-w-sm bg-noir-900 rounded-3xl border border-gold-400/30 p-8 flex flex-col items-center text-center">
          <UploadCloud className="w-12 h-12 text-gold-400 animate-bounce mb-4" />
          <h3 className="font-serif text-lg font-bold text-cream-100 mb-2">{i18n.t('ui.camera_capture_modal.1')}</h3>
          <p className="text-sm text-cream-300">
            {i18n.t('camera.upload_progress', { done: uploadProgress, total: totalFiles })}
          </p>
          <div className="w-full bg-noir-800 rounded-full h-2 mt-4 overflow-hidden">
            <div 
              className="bg-gold-400 h-2 transition-all duration-300 ease-out" 
              style={{ width: `${(uploadProgress / Math.max(1, totalFiles)) * 100}%` }}
            />
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/90 backdrop-blur-md animate-fade-in">
      <div className="relative w-full max-w-lg bg-noir-900 rounded-3xl border border-gold-400/30 shadow-2xl overflow-hidden flex flex-col max-h-[94vh]">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-cream-400/10 bg-noir-800/80">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gold-400/20 flex items-center justify-center border border-gold-400/40">
              <Camera className="w-4 h-4 text-gold-400" />
            </div>
            <div>
              <h3 className="font-serif text-lg font-bold text-cream-100 leading-tight">
                {capturedRawUrl 
                  ? bulkFiles.length > 1 
                    ? i18n.t('camera.uploading_count', { count: bulkFiles.length })
                    : i18n.t('camera.edit_title') 
                  : i18n.t('camera.title')}
              </h3>
              <p className="text-[11px] text-cream-400/70">
                {capturedRawUrl
                  ? bulkFiles.length > 1
                    ? (i18n.getLanguage() === 'bg' ? i18n.t('camera.bulk_hint') : 'Select filter and quest for all photos.')
                    : i18n.t('camera.leave_note')
                  : i18n.t('app.subtitle')}
              </p>
              {bulkTruncatedFrom !== null && (
                <p className="text-[11px] text-gold-400/90 mt-0.5">
                  {i18n.t('camera.bulk_limit_notice', { selected: bulkTruncatedFrom, max: MAX_BULK_UPLOAD_FILES })}
                </p>
              )}
            </div>
          </div>

          <button
            onClick={onClose}
            className="p-1.5 rounded-full bg-noir-700 text-cream-300 hover:text-white transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Viewport / Body */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4">
          {/* CAMERA / PREVIEW VIEWPORT */}
          <div className="relative w-full aspect-[4/3] sm:aspect-square bg-black rounded-2xl overflow-hidden border border-gold-400/20 shadow-inner flex items-center justify-center">
            {capturedRawUrl ? (
              <div className="relative w-full h-full flex items-center justify-center bg-noir-950">
                <img
                  src={processedUrl || capturedRawUrl}
                  alt="Captured moment"
                  className="w-full h-full object-cover"
                />
                {isProcessing && (
                  <div className="absolute inset-0 bg-black/40 backdrop-blur-xs flex items-center justify-center">
                    <Sparkles className="w-8 h-8 text-gold-400 animate-spin" />
                  </div>
                )}
              </div>
            ) : (
              <>
                <video
                  ref={videoRef}
                  autoPlay
                  playsInline
                  muted
                  className={`w-full h-full object-cover ${useFrontCamera ? '-scale-x-100' : ''}`}
                />

                {/* Permission / Inaccessible Camera Fallback Overlay */}
                {(permissionState === 'denied' || permissionState === 'unsupported' || cameraError) && (
                  <div className="absolute inset-0 p-6 flex flex-col items-center justify-center text-center bg-noir-950/95 text-cream-100 z-10 space-y-4">
                    <div className="w-14 h-14 rounded-full bg-gold-400/10 border border-gold-400/30 flex items-center justify-center text-gold-400">
                      <ShieldAlert className="w-7 h-7" />
                    </div>

                    <div className="space-y-1 max-w-xs">
                      <h4 className="font-serif text-base font-semibold text-cream-100">
                        {permissionState === 'denied' ? i18n.t('camera.permission_required') : i18n.t('camera.phone_cam')}
                      </h4>
                      <p className="text-xs text-cream-300/80">
                        {cameraError || i18n.t('camera.permission_subtitle')}
                      </p>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-2 w-full max-w-xs pt-1">
                      <button
                        type="button"
                        onClick={() => nativeCameraInputRef.current?.click()}
                        className="flex-1 py-3 px-4 rounded-xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-xs shadow-glow flex items-center justify-center gap-2 hover:brightness-110 active:scale-98 transition-transform"
                      >
                        <Camera className="w-4 h-4" />
                        <span>{i18n.t('camera.open_phone_cam')}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        className="py-3 px-4 rounded-xl bg-noir-800 border border-cream-400/20 text-cream-200 text-xs font-semibold hover:bg-noir-700 transition-colors flex items-center justify-center gap-2"
                      >
                        <ImageIcon className="w-4 h-4 text-cream-300" />
                        <span>{i18n.t('camera.gallery')}</span>
                      </button>
                    </div>

                    {permissionState === 'denied' && (
                      <button
                        type="button"
                        onClick={startCamera}
                        className="text-[11px] text-gold-400/80 hover:text-gold-300 underline pt-1"
                      >
                        {i18n.t('camera.retry_permission')}
                      </button>
                    )}
                  </div>
                )}

                {/* Flip camera button overlay */}
                {permissionState === 'granted' && !cameraError && (
                  <button
                    type="button"
                    onClick={() => setUseFrontCamera(!useFrontCamera)}
                    title="Flip camera"
                    className="absolute top-3 right-3 p-2.5 rounded-full bg-black/60 backdrop-blur-md text-white border border-white/20 hover:scale-110 active:scale-95 transition-transform z-20 shadow-md"
                  >
                    <RefreshCw className="w-4 h-4" />
                  </button>
                )}
              </>
            )}

            {/* Hidden File Input for Gallery */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              multiple
              className="hidden"
              onChange={handleFileSelect}
            />

            {/* Hidden Native Camera Input for 100% reliable mobile camera capture */}
            <input
              ref={nativeCameraInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={handleFileSelect}
            />
          </div>

          {/* EDITING CONTROLS (Only after photo is taken) */}
          {capturedRawUrl ? (
            <div className="space-y-4">
              {/* Filter Selector */}
              <div>
                <div className="flex items-center gap-1.5 text-xs font-semibold text-cream-300 mb-2">
                  <Sliders className="w-3.5 h-3.5 text-gold-400" />
                  <span>{i18n.t('camera.filter_title')}</span>
                </div>
                <div className="grid grid-cols-5 gap-2">
                  {FILTERS.map((f) => {
                    const isSelected = selectedFilter === f.id;
                    return (
                      <button
                        key={f.id}
                        type="button"
                        onClick={() => setSelectedFilter(f.id)}
                        className={`flex flex-col items-center gap-1 p-1.5 rounded-xl border transition-all ${
                          isSelected
                            ? 'border-gold-400 bg-gold-400/15 shadow-glow scale-105'
                            : 'border-cream-400/10 bg-noir-800/60 hover:border-cream-400/30'
                        }`}
                      >
                        <div
                          className={`w-full aspect-square rounded-lg bg-gradient-to-tr ${f.previewColor} border border-white/10 flex items-center justify-center`}
                        >
                          {isSelected && <Check className="w-3.5 h-3.5 text-gold-300" />}
                        </div>
                        <span className="text-[10px] text-cream-300 truncate w-full text-center">
                          {f.label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Scavenger Quest Tagging */}
              {quests.length > 0 && (
                <div>
                  <label className="flex items-center gap-1.5 text-xs font-semibold text-cream-300 mb-1.5">
                    <Trophy className="w-3.5 h-3.5 text-gold-400" />
                    <span>{i18n.t('camera.tag_quest')}</span>
                  </label>
                  <select
                    value={selectedQuestId}
                    onChange={(e) => setSelectedQuestId(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-noir-800 border border-cream-400/20 text-cream-100 text-xs focus:outline-none focus:border-gold-400"
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

              {/* Caption Box */}
              <div>
                <label className="block text-xs font-semibold text-cream-300 mb-1.5">
                  {i18n.t('camera.leave_note')}
                </label>
                <textarea
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  placeholder={i18n.t('camera.note_placeholder')}
                  rows={2}
                  maxLength={240}
                  className="w-full px-3 py-2 rounded-xl bg-noir-800 border border-cream-400/20 text-cream-100 text-xs placeholder:text-cream-400/40 focus:outline-none focus:border-gold-400 resize-none"
                />
              </div>
            </div>
          ) : (
            // PRE-CAPTURE CONTROLS
            <div className="flex items-center justify-around py-3">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="flex flex-col items-center gap-1 text-cream-300 hover:text-white transition-colors group"
              >
                <div className="w-12 h-12 rounded-full bg-noir-800 border border-cream-400/20 flex items-center justify-center group-hover:border-gold-400/50 transition-colors">
                  <ImageIcon className="w-5 h-5 text-cream-200" />
                </div>
                <span className="text-[11px]">{i18n.t('camera.gallery')}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  if (streamRef.current && videoRef.current && permissionState === 'granted') {
                    snapPhotoFromVideo();
                  } else {
                    nativeCameraInputRef.current?.click();
                  }
                }}
                className="w-18 h-18 rounded-full p-1 border-2 border-gold-400 shadow-glow flex items-center justify-center hover:scale-105 active:scale-95 transition-transform"
                title={i18n.t('camera.title')}
              >
                <div className="w-14 h-14 rounded-full bg-gradient-to-r from-gold-400 to-gold-500 shadow-inner flex items-center justify-center">
                  <Camera className="w-6 h-6 text-noir-900" />
                </div>
              </button>

              <button
                type="button"
                onClick={() => nativeCameraInputRef.current?.click()}
                className="flex flex-col items-center gap-1 text-cream-300 hover:text-white transition-colors group"
              >
                <div className="w-12 h-12 rounded-full bg-noir-800 border border-cream-400/20 flex items-center justify-center group-hover:border-gold-400/50 transition-colors">
                  <Camera className="w-5 h-5 text-gold-400" />
                </div>
                <span className="text-[11px]">{i18n.t('camera.phone_cam')}</span>
              </button>
            </div>
          )}
        </div>

        {/* Footer Actions */}
        {capturedRawUrl && (
          <div className="flex items-center justify-between p-4 border-t border-cream-400/10 bg-noir-800/90 gap-3">
            <button
              type="button"
              onClick={handleRetake}
              className="px-4 py-2.5 rounded-xl border border-cream-400/20 text-cream-200 hover:bg-noir-700 text-xs font-medium transition-colors"
            >
              {i18n.t('camera.retake')}
            </button>

            <button
              type="button"
              onClick={handleConfirmUpload}
              disabled={isProcessing}
              className="flex-1 flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-xs shadow-glow hover:brightness-110 active:scale-98 transition-all disabled:opacity-50"
            >
              <UploadCloud className="w-4 h-4" />
              <span>
                {bulkFiles.length > 1
                  ? i18n.t('camera.upload_count', { count: bulkFiles.length })
                  : i18n.t('camera.share_button')}
              </span>
            </button>
          </div>
        )}
      </div>
    </div>
  );
};
