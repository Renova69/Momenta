import React, { useId, useState, useRef, useEffect, useCallback } from 'react';
import { Guest, ScavengerQuest, PhotoFilter } from '../../types';
import { compressAndFilterImage } from '../../services/compressionService';
import { checkMediaSupport, mediaBlockMessageKey } from '../../utils/mediaSupport';
import { i18n } from '../../i18n';
import { useDialog } from '../../hooks/useDialog';
import { CameraViewfinder, FILTER_PREVIEW_CSS } from './CameraViewfinder';
import { CaptureReview } from './CaptureReview';
import confetti from 'canvas-confetti';
import { Camera, UploadCloud, Image as ImageIcon, ShieldAlert } from 'lucide-react';
import { mediaErrorKey } from '../../utils/mediaErrors';
import { AlbumClosedNotice } from '../common/AlbumClosedNotice';

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
  /** When the album closed to new photos (N-159): the camera says so instead of opening. */
  closedAt?: string | null;
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
  closedAt,
}) => {
  const [capturedRawUrl, setCapturedRawUrl] = useState<string | null>(null);
  const [processedUrl, setProcessedUrl] = useState<string | null>(null);
  const [selectedFilter, setSelectedFilter] = useState<PhotoFilter>('golden_glow');
  // N-126 — the golden default is the live camera's look. A photo chosen
  // from the gallery or the phone's own camera app is a finished photo, and
  // starts as itself unless the guest has picked a filter.
  const filterChosenRef = useRef(false);
  const chooseFilter = useCallback((filter: PhotoFilter) => {
    filterChosenRef.current = true;
    setSelectedFilter(filter);
  }, []);
  const [caption, setCaption] = useState('');
  const [selectedQuestId, setSelectedQuestId] = useState<string>(initialQuestId || '');
  const [isProcessing, setIsProcessing] = useState(false);
  const [useFrontCamera, setUseFrontCamera] = useState(false);
  // The frame is frozen on screen before the encoded photo exists, so the
  // review screen has something to show from the first tick.
  const [isCaptured, setIsCaptured] = useState(false);
  const [flash, setFlash] = useState(false);
  // Thumbnails of what has gone up in this session, newest first.
  const [sent, setSent] = useState<string[]>([]);

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
        // N-124 — the app's words, not the browser's English message.
        setCameraError(i18n.t(mediaErrorKey(err, 'camera')));
      }
    } finally {
      setIsStartingCamera(false);
    }
  }, [useFrontCamera, stopCamera]);

  useEffect(() => {
    if (isOpen && !capturedRawUrl && !closedAt) {
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
  }, [isOpen, capturedRawUrl, closedAt, useFrontCamera, startCamera, stopCamera]);

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

  /**
   * The shutter, in the order a camera does it.
   *
   * What made this feel a second slow was not the camera: it was everything
   * the old handler did before anything appeared on screen. `toDataURL` is a
   * synchronous base64 encode of a full-resolution frame on the main thread,
   * and only after it finished did the filter pass start, behind a spinner.
   * The guest pressed the button and watched a frozen interface.
   *
   * So: stop the picture first — pausing the video leaves the exact frame on
   * screen at no cost, which is the freeze a phone camera shows — and do the
   * encoding afterwards, while the guest is already looking at their photo
   * and reaching for the note field.
   */
  const snapPhotoFromVideo = () => {
    if (!videoRef.current) return;
    const video = videoRef.current;

    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1280;
    canvas.height = video.videoHeight || 720;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 1. Freeze. Nothing else happens on this tick.
    video.pause();
    setIsCaptured(true);
    setFlash(true);
    window.setTimeout(() => setFlash(false), 140);

    if (useFrontCamera) {
      // The preview is mirrored so the guest sees themselves as in a mirror;
      // the stored photo must read the right way round, or every selfie has
      // the venue's signage backwards.
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    // 2. Encode off the critical path. toBlob hands the work to the browser
    //    rather than blocking on a base64 string; toDataURL is the fallback
    //    for anything that does not implement it.
    const onEncoded = (dataUrl: string) => {
      setCapturedRawUrl(dataUrl);
      applyFilterToCaptured(dataUrl, selectedFilter);
      stopCamera();
    };

    try {
      if (typeof canvas.toBlob !== 'function') throw new Error('toBlob unavailable');
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            onEncoded(canvas.toDataURL('image/jpeg', 0.95));
            return;
          }
          const reader = new FileReader();
          reader.onload = (ev) => onEncoded(ev.target?.result as string);
          reader.onerror = () => onEncoded(canvas.toDataURL('image/jpeg', 0.95));
          reader.readAsDataURL(blob);
        },
        'image/jpeg',
        0.95
      );
    } catch {
      // Some embedded browsers have the method and refuse the call. The
      // photograph matters more than the milliseconds.
      onEncoded(canvas.toDataURL('image/jpeg', 0.95));
    }
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
  const titleId = useId();
  const fieldIds = useId();
  const uploadTitleId = useId();
  const { dialogRef, dialogProps } = useDialog({
    onClose,
    labelledBy: isUploadingMultiple ? uploadTitleId : titleId,
    enabled: isOpen,
    // Escape must not abandon photographs already on their way to the server.
    closeOnEscape: !isUploadingMultiple,
  });

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
    const filter: PhotoFilter = filterChosenRef.current ? selectedFilter : 'original';
    if (filter !== selectedFilter) setSelectedFilter(filter);

    const reader = new FileReader();
    reader.onload = (event) => {
      if (event.target?.result) {
        const rawUrl = event.target.result as string;
        setCapturedRawUrl(rawUrl);
        applyFilterToCaptured(rawUrl, filter);
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
    setIsCaptured(false);
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

    // Once per session, not once per shot: at three photos in a row it stops
    // being a celebration and starts being in the way of the next one.
    if (sent.length === 0) {
      confetti({
        particleCount: 80,
        spread: 70,
        origin: { y: 0.6 },
        colors: ['#D4AF37', '#F5EFE0', '#D98991', '#84A784'],
      });
    }

    // Back to the viewfinder rather than out of the camera. The upload is
    // already on its way (addPhoto writes locally first and syncs after), so
    // the next photograph does not wait for the last one to land — which is
    // how people actually take pictures at a party.
    setSent((prev) => [processedUrl ?? capturedRawUrl ?? '', ...prev].filter(Boolean).slice(0, 12));
    setCaption('');
    handleRetake();
  };

  if (!isOpen) return null;

  // N-159 — every way into the camera (the album's button, a challenge, the
  // bottom bar) lands here, so this one screen keeps a closed album closed.
  if (closedAt) {
    return (
      <div
        ref={dialogRef}
        {...dialogProps}
        className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/90 backdrop-blur-md animate-fade-in"
      >
        <div className="relative w-full max-w-sm bg-noir-900 rounded-3xl border border-gold-400/30 p-6 space-y-4 text-center">
          <h2 id={titleId} className="font-serif text-lg font-bold text-cream-100">
            {i18n.t('album.closed_camera_title')}
          </h2>
          <AlbumClosedNotice closedAt={closedAt} />
          <button
            type="button"
            onClick={onClose}
            className="w-full py-2.5 rounded-xl bg-noir-700 hover:bg-noir-600 text-cream-100 font-bold text-xs"
          >
            {i18n.t('common.close')}
          </button>
        </div>
      </div>
    );
  }

  if (isUploadingMultiple) {
    return (
      <div
        ref={dialogRef}
        {...dialogProps}
        className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-black/90 backdrop-blur-md animate-fade-in"
      >
        <div className="relative w-full max-w-sm bg-noir-900 rounded-3xl border border-gold-400/30 p-8 flex flex-col items-center text-center">
          <UploadCloud className="w-12 h-12 text-gold-400 animate-bounce mb-4" />
          <h3 id={uploadTitleId} className="font-serif text-lg font-bold text-cream-100 mb-2">{i18n.t('ui.camera_capture_modal.1')}</h3>
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

  const liveCameraAvailable = permissionState === 'granted' && !cameraError;
  const attachedQuest = quests.find((q) => q.id === selectedQuestId);

  return (
    <div
      ref={dialogRef}
      {...dialogProps}
      className="fixed inset-0 z-50 bg-black animate-fade-in overflow-hidden"
    >
      {/* The dialog's name (N-141). The screen is the picture, so the title is
          for screen readers only; without it this announced as "dialog". */}
      <h2 id={titleId} className="sr-only">
        {i18n.t('camera.title')}
      </h2>
      {/*
        The picture is the screen. Everything else is over it.

        This was a max-w-lg card with the camera boxed into an aspect-ratio
        viewport inside a padded, scrolling body — on a phone, the view of the
        room came to about a third of the display. A guest framing a shot
        across a dark reception needs the frame.
      */}
      <div className="absolute inset-0">
        {/* The still, once there is one to show. */}
        {(processedUrl || capturedRawUrl) && (
          <img
            src={processedUrl || capturedRawUrl || ''}
            alt={i18n.t('camera.captured_alt')}
            className="w-full h-full object-contain bg-black"
          />
        )}

        {/*
          The live camera. Kept mounted and merely hidden behind the still,
          because the frozen frame the guest is looking at immediately after
          the shutter *is* this paused video — remounting it would blank the
          screen at exactly the wrong moment.
        */}
        <video
          ref={videoRef}
          autoPlay
          playsInline
          muted
          className={`absolute inset-0 w-full h-full object-cover ${
            useFrontCamera ? '-scale-x-100' : ''
          } ${processedUrl || capturedRawUrl ? 'invisible' : ''}`}
          style={{ filter: isCaptured ? undefined : FILTER_PREVIEW_CSS[selectedFilter] }}
        />

        {/* The shutter's own flash: brief, and the only thing that happens
            on the tick the guest presses. */}
        {flash && <div className="absolute inset-0 bg-white pointer-events-none" />}

        {/* Permission / inaccessible camera fallback. Gone as soon as there is
            a photo to review, whichever way it arrived (N-108): it covers the
            whole modal, and hiding it only for the live shutter left a photo
            from the gallery or the phone's own camera app under it, with Send
            out of reach. */}
        {(permissionState === 'denied' || permissionState === 'unsupported' || cameraError) && !isCaptured && !capturedRawUrl && (
          /* N-133 — under the viewfinder's controls (z-20), not over them: at z-30
             it took every tap meant for close, the filters and the shutter. */
          <div className="absolute inset-0 p-6 flex flex-col items-center justify-center text-center bg-noir-950/95 text-cream-100 z-10 space-y-4">
            <div className="w-14 h-14 rounded-full bg-gold-400/10 border border-gold-400/30 flex items-center justify-center text-gold-400">
              <ShieldAlert className="w-7 h-7" />
            </div>

            <div className="space-y-1 max-w-xs">
              <h3 className="font-serif text-base font-semibold text-cream-100">
                {permissionState === 'denied' ? i18n.t('camera.permission_required') : i18n.t('camera.phone_cam')}
              </h3>
              <p className="text-xs text-cream-300/80">
                {cameraError || i18n.t('camera.permission_subtitle')}
              </p>
            </div>

            <div className="flex flex-col sm:flex-row gap-2 w-full max-w-xs pt-1">
              <button
                type="button"
                onClick={() => nativeCameraInputRef.current?.click()}
                className="flex-1 py-3 px-4 rounded-xl bg-linear-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-xs shadow-glow flex items-center justify-center gap-2 hover:brightness-110 active:scale-98 transition-transform"
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

        {/* The filtered copy being made. A thin bar, not a spinner over the
            photograph: the guest is looking at their picture and can write a
            note while this finishes. */}
        {isProcessing && (
          <div className="absolute inset-x-0 top-0 z-30 h-0.5 bg-gold-400/30 overflow-hidden">
            <div className="h-full w-1/3 bg-gold-400 animate-pulse" />
          </div>
        )}
      </div>

      {isCaptured || capturedRawUrl ? (
        <CaptureReview
          filter={selectedFilter}
          filters={FILTERS}
          onSelectFilter={chooseFilter}
          quests={quests}
          selectedQuestId={selectedQuestId}
          onSelectQuest={setSelectedQuestId}
          caption={caption}
          onCaptionChange={setCaption}
          onRetake={handleRetake}
          onSend={handleConfirmUpload}
          isProcessing={isProcessing || !processedUrl}
          batchCount={bulkFiles.length}
          fieldIds={fieldIds}
        />
      ) : (
        <CameraViewfinder
          filter={selectedFilter}
          filters={FILTERS}
          onSelectFilter={chooseFilter}
          onShutter={() => {
            if (streamRef.current && videoRef.current && liveCameraAvailable) {
              snapPhotoFromVideo();
            } else {
              nativeCameraInputRef.current?.click();
            }
          }}
          onPickFromGallery={() => fileInputRef.current?.click()}
          onUsePhoneCamera={() => nativeCameraInputRef.current?.click()}
          onFlipCamera={() => setUseFrontCamera(!useFrontCamera)}
          onClose={onClose}
          canFlip={liveCameraAvailable}
          sent={sent}
          questTitle={attachedQuest?.title}
        />
      )}

      {bulkTruncatedFrom !== null && (
        <p className="absolute inset-x-0 top-20 z-30 text-center text-[11px] text-gold-300 px-6">
          {i18n.t('camera.bulk_limit_notice', { selected: bulkTruncatedFrom, max: MAX_BULK_UPLOAD_FILES })}
        </p>
      )}

      {/* Hidden File Input for Gallery */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        aria-label={i18n.t('camera.gallery')}
        className="hidden"
        onChange={handleFileSelect}
      />

      {/* Hidden Native Camera Input — the path that works on every phone,
          whatever the browser will or will not preview. */}
      <input
        ref={nativeCameraInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        aria-label={i18n.t('camera.phone_cam')}
        className="hidden"
        onChange={handleFileSelect}
      />
    </div>
  );
};
