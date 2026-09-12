import { apiFetch } from './apiClient';

export interface ExportTicket {
  token: string;
  expiresIn: number;
  filename: string;
}

export interface EventUsage {
  tier: string;
  usedBytes: number;
  limitBytes: number;
  usedLabel: string;
  limitLabel: string;
  percentUsed: number;
  pooled: boolean;
  photoCount: number;
  maxPhotos: number | null;
  expiresAt: string | null;
}
import { WeddingEvent, QRCanvasConfig } from '../types';

export const eventsApi = {
  // Get event by slug
  getBySlug: async (slug: string): Promise<WeddingEvent | null> => {
    return apiFetch<WeddingEvent>(`/api/events/slug/${encodeURIComponent(slug)}`);
  },

  // Get event by UUID
  getById: async (id: string): Promise<WeddingEvent> => {
    return apiFetch<WeddingEvent>(`/api/events/${id}`);
  },

  // List the authenticated host's events (multi-event dashboard)
  listMine: async (): Promise<WeddingEvent[]> => {
    return apiFetch<WeddingEvent[]>('/api/events');
  },

  // Create a new event (requires auth)
  create: async (eventData: Partial<WeddingEvent>): Promise<WeddingEvent> => {
    return apiFetch<WeddingEvent>('/api/events', {
      method: 'POST',
      body: JSON.stringify(eventData),
    });
  },

  // Update event settings (requires auth)
  update: async (id: string, updates: Partial<WeddingEvent>): Promise<WeddingEvent> => {
    return apiFetch<WeddingEvent>(`/api/events/${id}`, {
      method: 'PUT',
      body: JSON.stringify(updates),
    });
  },

  // Get QR canvas config
  getQRConfig: async (id: string): Promise<QRCanvasConfig> => {
    return apiFetch<QRCanvasConfig>(`/api/events/${id}/qr-config`);
  },

  // Update QR canvas config (requires auth)
  updateQRConfig: async (id: string, config: Partial<QRCanvasConfig>): Promise<QRCanvasConfig> => {
    return apiFetch<QRCanvasConfig>(`/api/events/${id}/qr-config`, {
      method: 'PUT',
      body: JSON.stringify(config),
    });
  },

  // Get export ZIP URL
  getZipExportUrl: (eventId: string): string => {
    return `/api/events/${eventId}/export-zip`;
  },

  // Get Showcase Public Feed
  getShowcaseFeed: async (): Promise<WeddingEvent[]> => {
    return apiFetch<WeddingEvent[]>('/api/events/showcase/feed');
  },

  // Fire-and-forget live reaction for the projector wall.
  sendReaction: async (
    eventId: string,
    reaction: 'heart' | 'clap' | 'cheers' | 'laugh' | 'party',
    guestName?: string
  ): Promise<{ success: boolean }> => {
    return apiFetch<{ success: boolean }>(`/api/events/${eventId}/reactions`, {
      method: 'POST',
      body: JSON.stringify({ reaction, guestName }),
    });
  },

  // Storage position and retention deadline. Host only.
  getUsage: async (eventId: string): Promise<EventUsage> => {
    return apiFetch<EventUsage>(`/api/events/${eventId}/usage`);
  },

  // Mint a short-lived link for the ZIP download. See server/lib/downloadToken.ts
  // for why the credential travels in the URL for this one case.
  requestExportTicket: async (eventId: string): Promise<ExportTicket> => {
    return apiFetch<ExportTicket>(`/api/events/${eventId}/export-token`, { method: 'POST' });
  },

  /**
   * End every guest session on this album (M10). Host-only.
   *
   * Kills every guest token already issued and releases each device's
   * fingerprint slot, so returning guests re-join as new identities. Their
   * existing photos and comments stay exactly where they are.
   */
  resetGuestSessions: async (eventId: string): Promise<{ guestsReset: number }> => {
    return apiFetch<{ guestsReset: number }>(`/api/events/${eventId}/guest-sessions/reset`, {
      method: 'POST',
    });
  },

  /**
   * Permanently delete an event, its photos, audio and guests (D2).
   *
   * `confirmSlug` must equal the event's own slug — the server checks it
   * against the stored value and refuses otherwise. This is the erasure path,
   * so there is no undo.
   */
  remove: async (
    eventId: string,
    confirmSlug: string
  ): Promise<{ success: boolean; photosDeleted: number; bytesFreed: number }> => {
    return apiFetch(`/api/events/${eventId}`, {
      method: 'DELETE',
      body: JSON.stringify({ confirmSlug }),
    });
  },
};
