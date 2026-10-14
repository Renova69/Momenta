import { apiFetch } from './apiClient';
import { Guest } from '../types';

export const guestsApi = {
  // Register or update guest profile with device fingerprint persistence
  register: async (data: {
    eventId: string;
    name: string;
    tableNumber?: string;
    avatarUrl?: string;
    deviceFingerprint?: string;
  }): Promise<Guest> => {
    return apiFetch<Guest>('/api/guests', {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Store this guest's selfie (N-107). `image` is the picture as a data: URL;
  // the answer is where the server stored it.
  setAvatar: async (
    guestId: string,
    data: { eventId: string; guestToken?: string; image: string }
  ): Promise<{ avatarUrl: string }> => {
    return apiFetch<{ avatarUrl: string }>(`/api/guests/${encodeURIComponent(guestId)}/avatar`, {
      method: 'POST',
      body: JSON.stringify(data),
    });
  },

  // Lookup returning guest by device fingerprint
  lookup: async (eventId: string, deviceFingerprint: string): Promise<Guest | null> => {
    try {
      return await apiFetch<Guest>(`/api/guests?eventId=${encodeURIComponent(eventId)}&deviceFingerprint=${encodeURIComponent(deviceFingerprint)}`);
    } catch {
      return null;
    }
  },
};
