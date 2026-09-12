import { WeddingEvent, Guest, Photo, ScavengerQuest, AudioGuestbookEntry } from '../types';

/**
 * The cross-domain surface each storageService.ts domain module (guests,
 * photos, quests, audio, events, realtime...) needs from the others.
 *
 * WedStorageService builds one of these (as class-field arrow closures over
 * `this`, so private members stay callable without becoming public API) and
 * passes it into every domain function — the domain modules never import
 * each other directly, only this shape.
 */
export interface ServiceContext {
  getEvent: () => WeddingEvent;
  getPhotos: (eventId?: string) => Photo[];
  getQuests: (eventId?: string) => ScavengerQuest[];
  getAudioEntries: (eventId?: string) => AudioGuestbookEntry[];
  getCurrentGuest: (eventId?: string) => Guest | null;
  updateEvent: (updates: Partial<WeddingEvent>, syncBackend?: boolean) => WeddingEvent;
  notify: () => void;
  notifyError: (message: string) => void;
  syncGuestFromServer: (eventId: string, guestId?: string, guestToken?: string) => void;
  /** Drop the stored guest identity for an event once the server stops accepting it (M10). */
  forgetGuestIdentity: (eventId: string) => void;
  completeQuest: (questId: string, guestId: string) => void;
  joinEventRoom: (eventId: string) => void;
  syncFromBackend: (eventIdOverride?: string) => Promise<void>;
  emitReaction: (reaction: string, guestName: string | null) => void;
}
