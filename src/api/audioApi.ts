import { apiFetch } from './apiClient';
import { AudioGuestbookEntry } from '../types';
import { getOrCreateDeviceFingerprint } from '../services/storageKeys';

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

    // The upload rate limiter keys on the device, falling back to the client's
    // IP when it cannot identify one. It runs before multer, so a
    // `deviceFingerprint` field inside this FormData would be invisible to it
    // — req.body is not parsed yet — and every guest at a venue shares the
    // building's NAT address. That fallback would therefore give the whole
    // reception one shared budget of twenty recordings a minute, and the
    // twenty-first guest would be told they personally were uploading too
    // fast. The header is readable before the body is parsed, which is why the
    // server reads this one (server/middleware/rateLimit.ts, deviceKey).
    return apiFetch<AudioGuestbookEntry & { localId?: string; guestToken?: string }>('/api/audio', {
      method: 'POST',
      body: form,
      headers: { 'x-device-fingerprint': getOrCreateDeviceFingerprint() },
    });
  },
};
