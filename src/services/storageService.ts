import {
  WeddingEvent,
  Guest,
  Photo,
  ScavengerQuest,
  AudioGuestbookEntry,
  QRCanvasConfig,
  PhotoStatus,
  PhotoFilter,
  PhotoReactionKind,
  PlanTier
} from '../types';
import { ENV } from '../config/env';
import { eventsApi, type CoverSource } from '../api/eventsApi';
import { offlineQueue, QueuedUpload } from './offlineQueueService';
import { i18n } from '../i18n';
import { ServiceContext } from './storageServiceContext';
import { RealtimeSocket } from './realtimeSocket';
import { RealtimeMessage, applyRealtimeMessage } from './realtimeMessages';
import { ReactionKind, LiveReaction, ReactionListener } from './reactionTypes';

import type { RemoteEventPayload } from './eventNormalization';
import * as eventService from './eventService';
import * as guestService from './guestService';
import * as photoService from './photoService';
import * as questService from './questService';
import * as audioService from './audioService';
import { refusedUploadMessage } from './uploadRefusal';
import { translatedRefusal } from '../api/apiClient';
import * as qrCanvasService from './qrCanvasService';
import * as syncService from './storageSyncService';

export type { ReactionKind, LiveReaction };

type Listener = () => void;
type ErrorListener = (message: string) => void;

/**
 * The local-first wedding album service: every read/write goes through
 * localStorage first (so the UI never blocks on the network), each mutation
 * fires an async, best-effort sync to the PostgreSQL/R2 backend, and the
 * event WebSocket keeps every connected guest/host in sync in real time.
 *
 * The domain logic itself (guests, photos, quests, audio, QR canvas, event
 * settings, realtime message handling, backend sync) lives in the sibling
 * `*Service.ts` modules — this class is the composition root: it owns the
 * pub/sub plumbing (`listeners`/`errorListeners`/`reactionListeners`), the
 * WebSocket connection, and a `ServiceContext` that lets those modules call
 * back into each other (e.g. addPhoto completing a quest) without importing
 * one another directly.
 */
class WedStorageService {
  private listeners: Set<Listener> = new Set();
  private errorListeners: Set<ErrorListener> = new Set();
  private eventGoneListeners: Set<(eventId: string) => void> = new Set();
  private reactionListeners: Set<ReactionListener> = new Set();

  private readonly realtimeSocket = new RealtimeSocket(ENV.WS_URL, {
    // N-127 — no room to join while no album is open; the demo one stood in.
    getActiveEventId: () => (syncService.isDemoFallback(this.getEvent().id) ? '' : this.getEvent().id),
    onMessage: (data) => this.handleRealtimeEvent(data as RealtimeMessage),
    // N-68 — photos, approvals and deletions broadcast while the socket was
    // down never arrive. Reload what a page load would.
    onReconnect: () => {
      void this.syncFromBackend();
      void this.refreshEventDetails();
    },
  });

  private readonly ctx: ServiceContext = {
    getEvent: () => this.getEvent(),
    getPhotos: (eventId) => this.getPhotos(eventId),
    getQuests: (eventId) => this.getQuests(eventId),
    getAudioEntries: (eventId) => this.getAudioEntries(eventId),
    getCurrentGuest: (eventId) => this.getCurrentGuest(eventId),
    updateEvent: (updates, syncBackend) => this.updateEvent(updates, syncBackend),
    notify: () => this.notify(),
    notifyError: (message) => this.notifyError(message),
    notifyEventGone: (eventId) => this.notifyEventGone(eventId),
    syncGuestFromServer: (eventId, guestId, guestToken) => this.syncGuestFromServer(eventId, guestId, guestToken),
    forgetGuestIdentity: (eventId) => guestService.clearCurrentGuest(this.ctx, eventId),
    completeQuest: (questId, guestId) => this.completeQuest(questId, guestId),
    joinEventRoom: (eventId) => this.joinEventRoom(eventId),
    syncFromBackend: (eventIdOverride) => this.syncFromBackend(eventIdOverride),
    emitReaction: (reaction, guestName) => this.emitReaction(reaction, guestName),
    refreshEventDetails: () => this.refreshEventDetails(),
  };

  constructor() {
    syncService.initializeDefaults(this.ctx);
    if (typeof window !== 'undefined') {
      this.realtimeSocket.connect();
      this.syncFromBackend();
      // N-148 — the album record too, not only its photos: a returning
      // visitor was shown the cached copy from their last visit, whatever
      // the host had changed since, plan included.
      void this.refreshEventDetails();
      // FE-03: audio's syncFromBackend does a full unconditional overwrite,
      // so a flushed offline audio entry self-heals on the next sync -
      // photos merge instead, so a flushed photo needs its temp id
      // reconciled with the server's explicitly, or it duplicates.
      offlineQueue.onFlushSuccess((item, serverResponse) => {
        if (item.type === 'photo') this.reconcileFlushedPhoto(item, serverResponse);
      });
      // N-60 — a photo or message the queue gave up on is said out loud, not
      // left as a console warning the guest never sees.
      offlineQueue.onItemDropped((item, reason) => {
        // N-150 — the message said the item "was removed from this phone",
        // and nothing removed it: it stayed in the feed as if it had been sent.
        const payload = item.payload as { eventId?: string; localId?: string };
        const eventId = payload.eventId || this.ctx.getEvent().id;
        if (payload.localId) {
          if (item.type === 'audio') audioService.discardLocalAudioEntry(this.ctx, eventId, payload.localId);
          else photoService.discardLocalPhoto(this.ctx, eventId, payload.localId);
        }
        if (reason.refused) {
          const words = translatedRefusal(reason.code, reason.message || i18n.t('error.forbidden'), reason.body);
          this.notifyError(refusedUploadMessage(item.type, reason.code, words));
          return;
        }
        this.notifyError(i18n.t(item.type === 'audio' ? 'offline.audio_dropped' : 'offline.photo_dropped'));
      });
      // N-61 — uploads queued before the app was closed go up when it opens,
      // not only at the next 'online' event or the next photo.
      void offlineQueue.flushQueue();
    }
  }

  private reconcileFlushedPhoto(item: QueuedUpload, serverResponse: Record<string, unknown>): void {
    photoService.reconcileFlushedPhoto(this.ctx, item, serverResponse);
  }

  // Handle incoming real-time events with strict event-room filtering
  private handleRealtimeEvent(msg: RealtimeMessage): void {
    applyRealtimeMessage(this.ctx, msg);
  }

  public joinEventRoom(eventId: string): void {
    this.realtimeSocket.joinEventRoom(eventId);
  }

  public async syncFromBackend(eventIdOverride?: string): Promise<void> {
    await syncService.syncFromBackend(this.ctx, eventIdOverride);
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to write failures that the user needs to know about.
   *
   * Settings changes are applied optimistically to localStorage, so without this
   * a rejected save (expired session, tier gate, network) looked like it worked
   * until the next reload.
   */
  public subscribeErrors(listener: ErrorListener): () => void {
    this.errorListeners.add(listener);
    return () => this.errorListeners.delete(listener);
  }

  private notify(): void {
    this.listeners.forEach((fn) => fn());
  }

  private notifyError(message: string): void {
    this.errorListeners.forEach((fn) => fn(message));
  }

  /**
   * Subscribe to the album being erased underneath this browser.
   *
   * Distinct from an error: nothing failed, there is simply nothing left to
   * show, and every cached photo on this device is now of an album that does
   * not exist. Guests used to carry on browsing it until their next upload
   * failed for no stated reason.
   */
  public subscribeEventGone(listener: (eventId: string) => void): () => void {
    this.eventGoneListeners.add(listener);
    return () => this.eventGoneListeners.delete(listener);
  }

  private notifyEventGone(eventId: string): void {
    this.eventGoneListeners.forEach((fn) => fn(eventId));
  }

  private emitReaction(reaction: string, guestName: string | null): void {
    this.reactionListeners.forEach((fn) =>
      fn({
        id: `rx-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        reaction: reaction as ReactionKind,
        guestName,
      })
    );
  }

  /** Subscribe to live reactions arriving over the event WebSocket. */
  public subscribeReactions(listener: ReactionListener): () => void {
    this.reactionListeners.add(listener);
    return () => this.reactionListeners.delete(listener);
  }

  /** Send a live reaction to everyone watching this event. */
  public sendReaction(reaction: ReactionKind, guestName?: string): void {
    const event = this.getEvent();
    if (!event?.id) return;
    eventsApi.sendReaction(event.id, reaction, guestName).catch((err) => {
      console.warn('[Storage] Reaction not delivered:', err);
    });
  }

  // --- GETTERS (Strictly scoped to eventId) ---
  public getEvent(): WeddingEvent {
    return eventService.getEvent();
  }

  public getGuests(eventId?: string): Guest[] {
    return guestService.getGuests(this.ctx, eventId);
  }

  public getCurrentGuest(eventId?: string): Guest | null {
    return guestService.getCurrentGuest(this.ctx, eventId);
  }

  public getPhotos(eventId?: string): Photo[] {
    return photoService.getPhotos(this.ctx, eventId);
  }

  public getQuests(eventId?: string): ScavengerQuest[] {
    return questService.getQuests(this.ctx, eventId);
  }

  public getAudioEntries(eventId?: string): AudioGuestbookEntry[] {
    return audioService.getAudioEntries(this.ctx, eventId);
  }

  public getQRCanvasConfig(eventId?: string): QRCanvasConfig {
    return qrCanvasService.getQRCanvasConfig(this.ctx, eventId);
  }

  // --- ACTIONS ---
  public updateEvent(updates: Partial<WeddingEvent>, syncBackend: boolean = true): WeddingEvent {
    return eventService.updateEvent(this.ctx, updates, syncBackend);
  }

  /**
   * Set the plan tier for real, then re-read the event from the server rather
   * than optimistically writing the new tier locally — the server's copy
   * (`getEffectiveTierForEvent`) is the only thing tier-gating ever trusts, so
   * showing anything else here would just reproduce the bug this replaces
   * (client claims an upgrade the server doesn't have).
   */
  /** Re-read the album's own record only. See eventService.refreshEventDetails. */
  public refreshEventDetails(): Promise<void> {
    // The demo album standing in for none has no record to read (N-127).
    if (syncService.isDemoFallback(this.getEvent().id)) return Promise.resolve();
    return eventService.refreshEventDetails(this.ctx);
  }

  public async upgradePlanTier(tier: PlanTier): Promise<void> {
    await eventService.upgradePlanTier(this.ctx, tier);
  }

  /** The album's cover, through its own route (N-139). See eventService.setCover. */
  public setCover(source: CoverSource): Promise<void> {
    return eventService.setCover(this.ctx, source);
  }

  public removeCover(): Promise<void> {
    return eventService.removeCover(this.ctx);
  }

  public setCurrentGuest(guest: Guest): void {
    guestService.setCurrentGuest(this.ctx, guest);
  }

  private syncGuestFromServer(eventId: string, guestId?: string, guestToken?: string): void {
    guestService.syncGuestFromServer(this.ctx, eventId, guestId, guestToken);
  }

  public async registerGuest(name: string, tableNumber?: string, avatarUrl?: string): Promise<Guest> {
    return guestService.registerGuest(this.ctx, name, tableNumber, avatarUrl);
  }

  public async addPhoto(photoData: {
    guestId: string;
    guestName: string;
    guestAvatar?: string;
    guestTable?: string;
    fullUrl: string;
    thumbnailUrl?: string;
    originalUrl?: string;
    caption?: string;
    filterApplied?: PhotoFilter;
    questId?: string;
    questTitle?: string;
  }): Promise<Photo> {
    return photoService.addPhoto(this.ctx, photoData);
  }

  public toggleLikePhoto(photoId: string, guestId: string): void {
    photoService.toggleLikePhoto(this.ctx, photoId, guestId);
  }

  public togglePhotoReaction(photoId: string, reaction: PhotoReactionKind, guestId: string): void {
    photoService.togglePhotoReaction(this.ctx, photoId, reaction, guestId);
  }

  public addComment(photoId: string, guestId: string, guestName: string, commentText: string): void {
    photoService.addComment(this.ctx, photoId, guestId, guestName, commentText);
  }

  public setPhotoStatus(photoId: string, status: PhotoStatus): void {
    photoService.setPhotoStatus(this.ctx, photoId, status);
  }

  public async deletePhoto(photoId: string): Promise<void> {
    await photoService.deletePhoto(this.ctx, photoId);
  }

  public completeQuest(questId: string, guestId: string): void {
    questService.completeQuest(this.ctx, questId, guestId);
  }

  public addQuest(title: string, description: string, iconName: string = 'camera', points: number = 10): ScavengerQuest {
    return questService.addQuest(this.ctx, title, description, iconName, points);
  }

  public deleteQuest(questId: string): void {
    questService.deleteQuest(this.ctx, questId);
  }

  /**
   * `audioBlob` goes to the server as multipart, not base64-in-JSON (P7) —
   * the local entry plays back from an object URL immediately, then gets
   * reconciled with the server's real, permanent URL once the upload lands.
   */
  public addAudioEntry(
    audioBlob: Blob,
    durationSeconds: number,
    note?: string,
    mimeType: string = 'audio/webm'
  ): AudioGuestbookEntry {
    return audioService.addAudioEntry(this.ctx, audioBlob, durationSeconds, note, mimeType);
  }

  public updateQRCanvasConfig(updates: Partial<QRCanvasConfig>): QRCanvasConfig {
    return qrCanvasService.updateQRCanvasConfig(this.ctx, updates);
  }

  public async loadEventBySlug(slug: string): Promise<WeddingEvent | null> {
    return eventService.loadEventBySlug(this.ctx, slug);
  }

  public async openSignedInAlbum(signedIn: RemoteEventPayload): Promise<void> {
    return eventService.openSignedInAlbum(this.ctx, signedIn);
  }

  public async ensureOwnAlbum(hostUserId: string): Promise<'kept' | 'opened' | 'none'> {
    return eventService.ensureOwnAlbum(this.ctx, hostUserId);
  }

  public forgetEvent(eventId: string): void {
    eventService.forgetEvent(eventId);
    this.ctx.notify();
  }

  public resetToDefaults(): void {
    syncService.resetToDefaults(this.ctx);
  }
}

export const storageService = new WedStorageService();
