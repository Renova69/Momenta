import React, { useState, useRef, useEffect } from 'react';
import { AudioGuestbookEntry } from '../../types';
import { i18n } from '../../i18n';
import confetti from 'canvas-confetti';
import { checkMediaSupport, mediaBlockMessageKey } from '../../utils/mediaSupport';
import {
  Mic,
  Square,
  Play,
  Pause,
  Upload,
  Volume2,
  Clock
} from 'lucide-react';

interface AudioGuestbookProps {
  entries: AudioGuestbookEntry[];
  onAddAudioEntry: (audioBlob: Blob, durationSeconds: number, note?: string, mimeType?: string) => void;
}

export const AudioGuestbook: React.FC<AudioGuestbookProps> = ({
  entries,
  onAddAudioEntry,
}) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingSeconds, setRecordingSeconds] = useState(0);
  const [recordedBlobUrl, setRecordedBlobUrl] = useState<string | null>(null);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [note, setNote] = useState('');
  const [playingId, setPlayingId] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const timerIntervalRef = useRef<number | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const currentAudioElementRef = useRef<HTMLAudioElement | null>(null);
  const recordedMimeTypeRef = useRef<{ mimeType: string; extension: string }>({ mimeType: 'audio/webm', extension: 'webm' });

  // [FIX H-16] Cleanup on unmount — stop timer, mic, and audio
  useEffect(() => {
    return () => {
      if (timerIntervalRef.current) clearInterval(timerIntervalRef.current);
      if (mediaRecorderRef.current?.state !== 'inactive') {
        mediaRecorderRef.current?.stop();
      }
      if (currentAudioElementRef.current) {
        currentAudioElementRef.current.pause();
        currentAudioElementRef.current.src = '';
        currentAudioElementRef.current.load();
      }
      if (recordedBlobUrl) {
        URL.revokeObjectURL(recordedBlobUrl);
      }
    };
  }, [recordedBlobUrl]);

  const getSupportedAudioMimeType = () => {
    if (typeof MediaRecorder === 'undefined') return { mimeType: 'audio/webm', extension: 'webm' };
    if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return { mimeType: 'audio/webm;codecs=opus', extension: 'webm' };
    if (MediaRecorder.isTypeSupported('audio/webm')) return { mimeType: 'audio/webm', extension: 'webm' };
    if (MediaRecorder.isTypeSupported('audio/mp4')) return { mimeType: 'audio/mp4', extension: 'mp4' };
    if (MediaRecorder.isTypeSupported('audio/aac')) return { mimeType: 'audio/aac', extension: 'm4a' };
    return { mimeType: '', extension: 'webm' };
  };

  const startRecording = async () => {
    setErrorMsg(null);

    // Without this the call throws a bare TypeError on http:// LAN addresses,
    // because navigator.mediaDevices does not exist outside a secure context.
    const support = checkMediaSupport();
    if (!support.available) {
      setErrorMsg(i18n.t(mediaBlockMessageKey(support.reason), { origin: support.origin }));
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioChunksRef.current = [];
      const supported = getSupportedAudioMimeType();
      recordedMimeTypeRef.current = supported;

      const options = supported.mimeType ? { mimeType: supported.mimeType } : undefined;
      const recorder = new MediaRecorder(stream, options);
      mediaRecorderRef.current = recorder;

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) audioChunksRef.current.push(event.data);
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: supported.mimeType || 'audio/webm' });
        const blobUrl = URL.createObjectURL(audioBlob);
        setRecordedBlob(audioBlob);
        setRecordedBlobUrl(blobUrl);
        stream.getTracks().forEach((t) => t.stop());
      };

      recorder.start();
      setIsRecording(true);
      setRecordingSeconds(0);

      timerIntervalRef.current = window.setInterval(() => {
        setRecordingSeconds((prev) => {
          if (prev >= 60) {
            stopRecording();
            return 60;
          }
          return prev + 1;
        });
      }, 1000);
    } catch (err) {
      console.error('Microphone permission error:', err);
      setErrorMsg(i18n.t('audio.mic_permission_error') || i18n.t('audio.mic_denied'));
    }
  };

  const stopRecording = () => {
    if (timerIntervalRef.current) {
      clearInterval(timerIntervalRef.current);
      timerIntervalRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
  };

  // Hands the raw blob to storageService, which uploads it as multipart
  // (P7) and manages its own optimistic-preview-then-reconcile object URL —
  // separate from this component's own pre-save preview URL, revoked below
  // once the recording is handed off.
  const handleSaveRecording = async () => {
    if (!recordedBlobUrl || !recordedBlob) return;
    setIsSaving(true);
    setErrorMsg(null);

    try {
      const { mimeType } = recordedMimeTypeRef.current;
      onAddAudioEntry(recordedBlob, recordingSeconds || 1, note, mimeType || 'audio/webm');

      confetti({ particleCount: 50, spread: 60, origin: { y: 0.7 }, colors: ['#D4AF37', '#F5EFE0', '#D98991'] });

      URL.revokeObjectURL(recordedBlobUrl);
      setRecordedBlobUrl(null);
      setRecordedBlob(null);
      setRecordingSeconds(0);
      setNote('');
    } catch (err) {
      console.error('[AudioGuestbook] Save error:', err);
      setErrorMsg(i18n.t('audio.save_failed'));
    } finally {
      setIsSaving(false);
    }
  };

  const togglePlayback = (id: string, url: string) => {
    if (playingId === id) {
      if (currentAudioElementRef.current) {
        currentAudioElementRef.current.pause();
        currentAudioElementRef.current.src = '';
        currentAudioElementRef.current.load();
      }
      setPlayingId(null);
      return;
    }

    if (currentAudioElementRef.current) {
      currentAudioElementRef.current.pause();
      currentAudioElementRef.current.src = '';
      currentAudioElementRef.current.load();
    }

    const audio = new Audio(url);
    currentAudioElementRef.current = audio;
    setPlayingId(id);

    audio.onended = () => {
      audio.src = '';
      audio.load();
      setPlayingId(null);
    };
    audio.onerror = () => {
      audio.src = '';
      audio.load();
      setPlayingId(null);
    };
    audio.play().catch(() => setPlayingId(null));
  };

  const formatSeconds = (sec: number) => {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  };

  return (
    <div className="space-y-8">
      
      {/* Vintage Phone Booth Recorder Hero */}
      <div className="bg-gradient-to-br from-noir-800 via-[#1c1813] to-noir-900 rounded-3xl p-6 sm:p-8 border border-gold-400/30 shadow-2xl relative overflow-hidden text-center">
        
        {/* Glow decoration */}
        <div className="absolute left-1/2 -top-12 -translate-x-1/2 w-64 h-32 bg-gold-400/10 rounded-full blur-3xl pointer-events-none" />

        <div className="max-w-md mx-auto space-y-3 mb-6">
          <div className="w-14 h-14 rounded-full bg-gold-400/15 border border-gold-400/40 flex items-center justify-center mx-auto text-gold-400 shadow-glow">
            <Mic className="w-7 h-7" />
          </div>
          <h3 className="font-serif text-2xl font-bold text-cream-100">
            {i18n.t('audio.title')}
          </h3>
          <p className="text-xs sm:text-sm text-cream-300/80 leading-relaxed">
            {i18n.t('audio.subtitle')}
          </p>
        </div>

        {errorMsg && (
          <div className="mb-4 p-3 rounded-xl bg-rosewood-900/60 border border-rosewood-400/40 text-rosewood-200 text-xs max-w-sm mx-auto">
            {errorMsg}
          </div>
        )}

        {/* Dynamic Recorder State Machine */}
        {!recordedBlobUrl ? (
          <div className="space-y-4">
            <div className="flex flex-col items-center justify-center gap-3">
              {isRecording ? (
                <button
                  type="button"
                  onClick={stopRecording}
                  className="w-24 h-24 rounded-full bg-rosewood-600 hover:bg-rosewood-500 border-4 border-rosewood-400 shadow-glow flex flex-col items-center justify-center text-white active:scale-95 transition-all animate-pulse"
                >
                  <Square className="w-8 h-8 fill-current mb-1" />
                  <span className="text-[10px] font-bold uppercase">{i18n.t('audio.stop_btn')}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={startRecording}
                  className="w-24 h-24 rounded-full bg-gradient-to-tr from-gold-500 to-gold-400 hover:brightness-110 border-4 border-gold-300/40 shadow-glow flex flex-col items-center justify-center text-noir-900 active:scale-95 transition-all"
                >
                  <Mic className="w-8 h-8 mb-1" />
                  <span className="text-[10px] font-bold uppercase tracking-wider">{i18n.t('audio.record_btn')}</span>
                </button>
              )}

              {/* Timer status */}
              <div className="font-mono text-base font-bold text-gold-300">
                {isRecording ? (
                  <span className="flex items-center gap-1.5 text-rosewood-400">
                    <span className="w-2.5 h-2.5 rounded-full bg-rosewood-500 animate-ping" />
                    <span>{formatSeconds(recordingSeconds)} / 1:00</span>
                  </span>
                ) : (
                  <span className="text-cream-400/60">0:00 / 1:00</span>
                )}
              </div>
            </div>
            <p className="text-[11px] text-cream-400/60">
              {isRecording ? i18n.t('audio.recording') : i18n.t('audio.record_btn')}
            </p>
          </div>
        ) : (
          /* Preview & Save Form */
          <div className="max-w-md mx-auto space-y-4 bg-noir-900/80 p-5 rounded-2xl border border-gold-400/20">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-gold-400 flex items-center gap-1.5">
                <Volume2 className="w-4 h-4" />
                <span>{i18n.t('audio.play_preview')} ({formatSeconds(recordingSeconds)})</span>
              </span>

              <button
                type="button"
                onClick={() => togglePlayback('preview', recordedBlobUrl)}
                className="px-3 py-1.5 rounded-full bg-gold-400 text-noir-900 font-bold text-xs flex items-center gap-1 hover:brightness-110"
              >
                {playingId === 'preview' ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5 fill-current" />}
                <span>{playingId === 'preview' ? i18n.t('audio.pause') : i18n.t('audio.listen')}</span>
              </button>
            </div>

            <textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={i18n.t('audio.note_placeholder')}
              rows={2}
              maxLength={150}
              className="w-full px-3 py-2 rounded-xl bg-noir-800 border border-cream-400/20 text-cream-100 text-xs placeholder:text-cream-400/40 focus:outline-none focus:border-gold-400 resize-none"
            />

            <div className="flex items-center gap-2 pt-1">
              <button
                type="button"
                onClick={() => {
                  setRecordedBlobUrl(null);
                  setRecordingSeconds(0);
                }}
                className="flex-1 py-2.5 rounded-xl border border-cream-400/20 text-cream-200 text-xs font-medium hover:bg-noir-800"
              >
                {i18n.t('camera.retake')}
              </button>

              <button
                type="button"
                onClick={handleSaveRecording}
                disabled={isSaving}
                className="flex-[2] py-2.5 rounded-xl bg-gradient-to-r from-gold-400 to-gold-500 text-noir-900 font-bold text-xs shadow-glow hover:brightness-110 flex items-center justify-center gap-1.5 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <Upload className="w-4 h-4" />
                <span>{isSaving ? i18n.t('audio.saving') : i18n.t('audio.save_btn')}</span>
              </button>
            </div>
          </div>
        )}

      </div>

      {/* Spoken Messages Feed */}
      <div className="space-y-4">
        <h4 className="font-serif text-lg font-bold text-cream-100 flex items-center gap-2">
          <Volume2 className="w-5 h-5 text-gold-400" />
          <span>{i18n.t('hero.audio_messages')} ({entries.length})</span>
        </h4>

        {entries.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {entries.map((entry) => {
              const isPlaying = playingId === entry.id;

              return (
                <div
                  key={entry.id}
                  className="p-4 rounded-2xl bg-noir-800/90 border border-cream-400/15 shadow-md flex items-start gap-3 justify-between"
                >
                  <div className="flex items-start gap-3 min-w-0">
                    <img
                      src={entry.guestAvatar || `https://api.dicebear.com/7.x/micah/svg?seed=${encodeURIComponent(entry.guestName)}`}
                      alt={entry.guestName}
                      className="w-10 h-10 rounded-full border border-gold-400/30 object-cover shrink-0"
                    />
                    <div className="min-w-0">
                      <h5 className="font-serif text-sm font-bold text-cream-100 truncate">
                        {entry.guestName}
                      </h5>
                      {entry.note && (
                        <p className="text-xs text-cream-200/90 italic font-serif mt-0.5 line-clamp-2">
                          "{entry.note}"
                        </p>
                      )}
                      <div className="flex items-center gap-2 mt-2 text-[11px] text-cream-400/60">
                        <Clock className="w-3 h-3 text-gold-400" />
                        <span>{formatSeconds(entry.durationSeconds)}</span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => togglePlayback(entry.id, entry.audioUrl)}
                    className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 shadow-sm transition-transform active:scale-95 ${
                      isPlaying
                        ? 'bg-rosewood-500 text-white animate-pulse'
                        : 'bg-gold-400 text-noir-900 hover:brightness-110'
                    }`}
                  >
                    {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 fill-current ml-0.5" />}
                  </button>
                </div>
              );
            })}
          </div>
        ) : (
          <div className="p-8 text-center rounded-2xl bg-noir-800/30 border border-cream-400/10 text-cream-400/60 text-xs">
            {i18n.t('audio.empty_title')} — {i18n.t('audio.empty_desc')}
          </div>
        )}
      </div>

    </div>
  );
};
