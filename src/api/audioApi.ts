import { apiFetch } from './apiClient';
import { AudioGuestbookEntry } from '../types';

export const audioApi = {
  // List audio entries scoped by eventId
  list: async (eventId: string): Promise<AudioGuestbookEntry[]> => {
    return apiFetch<AudioGuestbookEntry[]>(`/api/audio?eventId=${encodeURIComponent(eventId)}`);
  },

  // Save new audio entry — multipart, not base64-in-JSON (P7): a 60-120s
  // WebM recording inflates by ~33% as base64 for no benefit.
  create: async (entry: {
    eventId: string;
    guestId: string;
    guestName?: string;
    guestAvatar?: string;
    audioBlob: Blob;
    audioFilename?: string;
    durationSeconds: number;
    note?: string;
    localId?: string;
    guestToken?: string;
  }): Promise<AudioGuestbookEntry & { localId?: string; guestToken?: string }> => {
    const form = new FormData();
    form.append('audio', entry.audioBlob, entry.audioFilename || 'audio-message.webm');
    form.append('eventId', entry.eventId);
    form.append('guestId', entry.guestId);
    if (entry.guestName) form.append('guestName', entry.guestName);
    if (entry.guestAvatar) form.append('guestAvatar', entry.guestAvatar);
    form.append('durationSeconds', String(entry.durationSeconds));
    if (entry.note) form.append('note', entry.note);
    if (entry.localId) form.append('localId', entry.localId);
    if (entry.guestToken) form.append('guestToken', entry.guestToken);

    return apiFetch<AudioGuestbookEntry & { localId?: string; guestToken?: string }>('/api/audio', {
      method: 'POST',
      body: form,
    });
  },
};
