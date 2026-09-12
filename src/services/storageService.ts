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
import { eventsApi } from '../api/eventsApi';
import { offlineQueue, QueuedUpload } from './offlineQueueService';
import { ServiceContext } from './storageServiceContext';
import { RealtimeSocket } from './realtimeSocket';
import { RealtimeMessage, applyRealtimeMessage } from './realtimeMessages';
import { ReactionKind, LiveReaction, ReactionListener } from './reactionTypes';

import * as eventService from './eventService';
import * as guestService from './guestService';
import * as photoService from './photoService';
import * as questService from './questService';
import * as audioService from './audioService';
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
  private reactionListeners: Set<ReactionListener> = new Set();

  private readonly realtimeSocket = new RealtimeSocket(ENV.WS_URL, {
    getActiveEventId: () => this.getEvent().id,
    onMessage: (data) => this.handleRealtimeEvent(data as RealtimeMessage),
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
    syncGuestFromServer: (eventId, guestId, guestToken) => this.syncGuestFromServer(eventId, guestId, guestToken),
    forgetGuestIdentity: (eventId) => guestService.clearCurrentGuest(this.ctx, eventId),
    completeQuest: (questId, guestId) => this.completeQuest(questId, guestId),
    joinEventRoom: (eventId) => this.joinEventRoom(eventId),
    syncFromBackend: (eventIdOverride) => this.syncFromBackend(eventIdOverride),
    emitReaction: (reaction, guestName) => this.emitReaction(reaction, guestName),
  };

  constructor() {
    syncService.initializeDefaults(this.ctx);
    if (typeof window !== 'undefined') {
      this.realtimeSocket.connect();
      this.syncFromBackend();
      // FE-03: audio's syncFromBackend does a full unconditional overwrite,
      // so a flushed offline audio entry self-heals on the next sync -
      // photos merge instead, so a flushed photo needs its temp id
      // reconciled with the server's explicitly, or it duplicates.
      offlineQueue.onFlushSuccess((item, serverResponse) => {
        if (item.type === 'photo') this.reconcileFlushedPhoto(item, serverResponse);
      });
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
  public async upgradePlanTier(tier: PlanTier): Promise<void> {
    await eventService.upgradePlanTier(this.ctx, tier);
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

  public resetToDefaults(): void {
    syncService.resetToDefaults(this.ctx);
  }
}

export const storageService = new WedStorageService();
