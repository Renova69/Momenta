import { Guest, AudioGuestbookEntry } from '../types';
import { audioApi } from '../api/audioApi';
import { offlineQueue } from './offlineQueueService';
import { STORAGE_KEYS } from './storageKeys';
import { ServiceContext } from './storageServiceContext';

// FE-04 — a blob: URL only lives as long as the page load that created it.
// Tracks which events' audio have already been swept for dead blob: URLs
// this session, so the one-time cleanup in getAudioEntries() runs once per
// event and never touches a blob: URL legitimately created later in the
// same session.
const sweptAudioBlobEventIds: Set<string> = new Set();

export function getAudioEntries(ctx: ServiceContext, eventId?: string): AudioGuestbookEntry[] {
  const targetId = eventId || ctx.getEvent().id;
  try {
    const data = localStorage.getItem(STORAGE_KEYS.AUDIO(targetId));
    const entries: AudioGuestbookEntry[] = data ? JSON.parse(data) : [];

    // FE-04 — any blob: URL still present the first time this event's
    // audio is read in a fresh page load is dead on arrival: the browser
    // only keeps a blob: URL alive for the page load that created it, and
    // no createObjectURL call has happened yet this session. It means a
    // reload interrupted the upload before the server's real URL could
    // reconcile it. Clear it here instead of handing the player a
    // guaranteed ERR_FILE_NOT_FOUND.
    if (!sweptAudioBlobEventIds.has(targetId)) {
      sweptAudioBlobEventIds.add(targetId);
      if (entries.some((e) => e.audioUrl?.startsWith('blob:'))) {
        const cleaned = entries.map((e) => (e.audioUrl?.startsWith('blob:') ? { ...e, audioUrl: '' } : e));
        localStorage.setItem(STORAGE_KEYS.AUDIO(targetId), JSON.stringify(cleaned));
        return cleaned;
      }
    }

    return entries;
  } catch {
    return [];
  }
}

/**
 * `audioBlob` goes to the server as multipart, not base64-in-JSON (P7) —
 * the local entry plays back from an object URL immediately, then gets
 * reconciled with the server's real, permanent URL once the upload lands.
 */
export function addAudioEntry(
  ctx: ServiceContext,
  audioBlob: Blob,
  durationSeconds: number,
  note?: string,
  mimeType: string = 'audio/webm'
): AudioGuestbookEntry {
  const event = ctx.getEvent();
  const currentGuest: Guest = ctx.getCurrentGuest() || {
    id: 'anonymous',
    eventId: event.id,
    name: 'Guest',
    avatarUrl: undefined,
    createdAt: new Date().toISOString(),
  };
  const localId = 'aud-' + Date.now();
  const localBlobUrl = URL.createObjectURL(audioBlob);
  const extension = mimeType.includes('mp4') ? 'mp4' : mimeType.includes('ogg') ? 'ogg' : 'webm';
  const filename = `audio-${Date.now()}.${extension}`;

  const newEntry: AudioGuestbookEntry = {
    id: localId,
    eventId: event.id,
    guestId: currentGuest.id,
    guestName: currentGuest.name,
    guestAvatar: currentGuest.avatarUrl,
    audioUrl: localBlobUrl,
    durationSeconds,
    note: note?.trim(),
    createdAt: new Date().toISOString(),
  };

  const entries = [newEntry, ...getAudioEntries(ctx, event.id)];
  localStorage.setItem(STORAGE_KEYS.AUDIO(event.id), JSON.stringify(entries));
  ctx.notify();

  audioApi
    .create({
      eventId: event.id,
      guestId: currentGuest.id,
      guestName: currentGuest.name,
      guestAvatar: currentGuest.avatarUrl,
      audioBlob,
      audioFilename: filename,
      durationSeconds,
      note,
      localId,
      guestToken: currentGuest.guestToken,
    })
    .then((serverEntry) => {
      ctx.syncGuestFromServer(event.id, serverEntry.guestId, serverEntry.guestToken);
      const current = getAudioEntries(ctx, event.id);
      const updated = current.map((e) => (e.id === localId ? { ...e, ...serverEntry } : e));
      localStorage.setItem(STORAGE_KEYS.AUDIO(event.id), JSON.stringify(updated));
      URL.revokeObjectURL(localBlobUrl);
      ctx.notify();
    })
    .catch((err) => {
      console.warn('Backend sync failed for audio guestbook, enqueuing offline:', err);
      offlineQueue.enqueue('audio', {
        eventId: event.id,
        guestId: currentGuest.id,
        guestName: currentGuest.name,
        guestAvatar: currentGuest.avatarUrl,
        audioBlob,
        audioFilename: filename,
        durationSeconds,
        note,
        localId,
        guestToken: currentGuest.guestToken,
      });
    });

  return newEntry;
}
