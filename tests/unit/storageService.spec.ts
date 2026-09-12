import { describe, it, expect, beforeEach, vi } from 'vitest';
import { storageService } from '../../src/services/storageService';
import { Guest, WeddingEvent, QRCanvasConfig } from '../../src/types';
import { eventsApi } from '../../src/api/eventsApi';
import { photosApi } from '../../src/api/photosApi';
import { questsApi } from '../../src/api/questsApi';
import { audioApi } from '../../src/api/audioApi';
import { guestsApi } from '../../src/api/guestsApi';
import { offlineQueue } from '../../src/services/offlineQueueService';

function createMockResponse<T>(data: T, status = 200, ok = true): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    headers: new Headers(),
    json: async () => data,
    text: async () => JSON.stringify(data),
    blob: async () => new Blob([JSON.stringify(data)]),
    arrayBuffer: async () => new ArrayBuffer(0),
    formData: async () => new FormData(),
    clone: () => createMockResponse(data, status, ok),
    body: null,
    bodyUsed: false,
    redirected: false,
    type: 'basic',
    url: '',
  } as Response;
}

describe('Storage Service Spec', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('manages active wedding event configuration and updates', () => {
    const initial = storageService.getEvent();
    expect(initial.id).toBeDefined();

    storageService.updateEvent({ venueName: 'Grand Ballroom' });
    expect(storageService.getEvent().venueName).toBe('Grand Ballroom');
  });

  it('partitions cached event data per event id, not one shared slot (SEC-A8)', () => {
    // Simulates the same browser having viewed two different weddings.
    storageService.updateEvent({
      id: 'event-alpha',
      slug: 'alpha',
      hostEmail: 'alpha-host@example.com',
      hostUserId: 'user-alpha',
      venueName: 'Alpha Venue',
    });
    storageService.updateEvent({
      id: 'event-beta',
      slug: 'beta',
      hostEmail: 'beta-host@example.com',
      hostUserId: 'user-beta',
      venueName: 'Beta Venue',
    });

    // The currently-active event (the pointer) is the one most recently set.
    const current = storageService.getEvent();
    expect(current.id).toBe('event-beta');
    expect(current.hostEmail).toBe('beta-host@example.com');
    expect(current.venueName).toBe('Beta Venue');

    // Alpha's data is still there under its own key, untouched by beta's
    // write — a single shared key would have had beta's fields bleed into
    // (or replace) alpha's the moment beta was cached.
    const alphaRaw = localStorage.getItem('wedmoments_event_event-alpha');
    expect(alphaRaw).toBeTruthy();
    const alpha = JSON.parse(alphaRaw!);
    expect(alpha.hostEmail).toBe('alpha-host@example.com');
    expect(alpha.venueName).toBe('Alpha Venue');

    // No single global "wedmoments_event" key exists to leak across events.
    expect(localStorage.getItem('wedmoments_event')).toBeNull();
  });

  it('manages guest identity scoped by eventId and registerGuest flow', async () => {
    const event = storageService.getEvent();
    const guest: Guest = {
      id: 'guest-123',
      eventId: event.id,
      name: 'Victoria & Mark',
      tableNumber: 'Table 5',
      isVip: true,
      createdAt: new Date().toISOString(),
    };

    storageService.setCurrentGuest(guest);
    const retrieved = storageService.getCurrentGuest();

    expect(retrieved?.id).toBe('guest-123');
    expect(retrieved?.name).toBe('Victoria & Mark');
    expect(retrieved?.tableNumber).toBe('Table 5');
    expect(retrieved?.isVip).toBe(true);

    const guestsList = storageService.getGuests(event.id);
    expect(Array.isArray(guestsList)).toBe(true);

    // Register guest flow
    vi.spyOn(guestsApi, 'register').mockResolvedValue({
      id: 'server-g-1',
      eventId: event.id,
      name: 'Registered Guest',
      tableNumber: 'Table 2',
      createdAt: new Date().toISOString(),
    });

    const registered = await storageService.registerGuest('Registered Guest', 'Table 2');
    expect(registered.name).toBe('Registered Guest');
  });

  it('manages photos, likes, and comments state', async () => {
    const event = storageService.getEvent();
    const guest: Guest = {
      id: 'guest-456',
      eventId: event.id,
      name: 'David',
      createdAt: new Date().toISOString(),
    };
    storageService.setCurrentGuest(guest);

    const photo = await storageService.addPhoto({
      guestId: guest.id,
      guestName: guest.name,
      fullUrl: 'https://example.com/photo.jpg',
      caption: 'Such a joyful toast! 🥂',
      filterApplied: 'golden_glow',
    });

    expect(photo.id).toMatch(/^photo-/);
    expect(photo.caption).toBe('Such a joyful toast! 🥂');

    const photos = storageService.getPhotos(event.id);
    expect(photos.length).toBeGreaterThanOrEqual(1);

    // Toggle Like
    storageService.toggleLikePhoto(photo.id, guest.id);
    const photoAfterLike = storageService.getPhotos(event.id).find((p) => p.id === photo.id);
    expect(photoAfterLike?.likesCount).toBe(1);
    expect(photoAfterLike?.likedByGuestIds).toContain(guest.id);

    // Toggle Like again (Unlike)
    storageService.toggleLikePhoto(photo.id, guest.id);
    const photoAfterUnlike = storageService.getPhotos(event.id).find((p) => p.id === photo.id);
    expect(photoAfterUnlike?.likesCount).toBe(0);

    // Add Comment
    storageService.addComment(photo.id, guest.id, guest.name, 'Beautiful wedding!');
    const photoAfterComment = storageService.getPhotos(event.id).find((p) => p.id === photo.id);
    expect(photoAfterComment?.commentsCount).toBe(1);
    expect(photoAfterComment?.comments?.[0]?.commentText).toBe('Beautiful wedding!');
  });

  it('manages scavenger quests and completions', () => {
    const event = storageService.getEvent();
    const quest = storageService.addQuest('Special Toast', 'Capture the best toast', 'sparkles', 25);
    expect(quest.id).toBeDefined();

    const guest: Guest = {
      id: 'guest-quest-runner',
      eventId: event.id,
      name: 'Runner',
      createdAt: new Date().toISOString(),
    };
    storageService.setCurrentGuest(guest);

    storageService.completeQuest(quest.id, guest.id);
    const questsAfter = storageService.getQuests(event.id);
    const questFound = questsAfter.find((q) => q.id === quest.id);

    expect(questFound?.completedByGuestIds).toContain(guest.id);
  });

  it('manages audio guestbook entries and QR canvas config', () => {
    const event = storageService.getEvent();
    const guest: Guest = {
      id: 'guest-audio',
      eventId: event.id,
      name: 'Sarah',
      createdAt: new Date().toISOString(),
    };
    storageService.setCurrentGuest(guest);

    const entry = storageService.addAudioEntry(
      new Blob([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3])], { type: 'audio/webm' }),
      18,
      'From the bridesmaids with joy!'
    );

    expect(entry.durationSeconds).toBe(18);
    const audioList = storageService.getAudioEntries(event.id);
    expect(audioList.length).toBeGreaterThanOrEqual(1);

    storageService.updateQRCanvasConfig({ headline: 'Scan for Magic Moments', canvasSize: 'A3' });
    const updatedQr = storageService.getQRCanvasConfig(event.id);
    expect(updatedQr.headline).toBe('Scan for Magic Moments');
    expect(updatedQr.canvasSize).toBe('A3');
  });

  it('clears a dead blob: URL left over from a reload that interrupted an audio upload (FE-04)', () => {
    // Simulates the crash-landing state: a page reload happened before the
    // upload's .then() could reconcile the entry with the server's real
    // URL, so localStorage still holds a blob: reference from the previous
    // page load — guaranteed dead, since the browser only keeps a blob: URL
    // alive for the load that created it.
    const eventId = `event-fe04-${Date.now()}`;
    storageService.updateEvent({ id: eventId });

    const staleEntry = {
      id: 'aud-stale-1',
      eventId,
      guestId: 'guest-stale',
      guestName: 'Stale Guest',
      audioUrl: 'blob:http://localhost/00000000-dead-beef',
      durationSeconds: 12,
      note: 'left mid-upload',
      createdAt: new Date().toISOString(),
    };
    localStorage.setItem(`wedmoments_audio_${eventId}`, JSON.stringify([staleEntry]));

    const entries = storageService.getAudioEntries(eventId);
    expect(entries[0].audioUrl).toBe('');

    // The correction is persisted, not just returned for this one call.
    const persisted = JSON.parse(localStorage.getItem(`wedmoments_audio_${eventId}`)!);
    expect(persisted[0].audioUrl).toBe('');
  });

  it('throttles concurrent backend photo uploads instead of firing a whole bulk batch at once (FE-06)', async () => {
    // Mirrors CameraCaptureModal's bulk loop: addPhoto() is called once per
    // file, back-to-back, without awaiting the network call. Each pending
    // request's original stays alive in memory until it settles — this
    // simulates 5 files' uploads all landing "in flight" at the same
    // instant, which is exactly the shape that used to OOM a mobile tab.
    const guest: Guest = {
      id: 'guest-fe06',
      eventId: storageService.getEvent().id,
      name: 'Bulk Uploader',
      createdAt: new Date().toISOString(),
    };
    storageService.setCurrentGuest(guest);

    let concurrent = 0;
    let maxConcurrent = 0;
    const releasers: (() => void)[] = [];
    vi.spyOn(photosApi, 'create').mockImplementation(() => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      return new Promise((resolve) => {
        releasers.push(() => {
          concurrent--;
          resolve({ id: 'server-' + releasers.length } as never);
        });
      });
    });

    const BATCH_SIZE = 5;
    for (let i = 0; i < BATCH_SIZE; i++) {
      // Not awaited — matches how the bulk loop fires these off today.
      void storageService.addPhoto({
        guestId: guest.id,
        guestName: guest.name,
        fullUrl: `data:image/jpeg;base64,compressed-${i}`,
        originalUrl: `data:image/jpeg;base64,full-resolution-original-${i}`,
      });
    }

    // Microtask-only flushing — this file shares module-level singletons
    // (offlineQueue) across tests, and a real setTimeout macrotask can let
    // an unrelated, still-in-flight background operation from an earlier
    // test interleave here. The whole addPhoto -> runThrottledPhotoUpload
    // chain is plain promises with no timers of its own, so draining
    // microtasks is enough to let it settle.
    const flushMicrotasks = async () => {
      for (let i = 0; i < 20; i++) await Promise.resolve();
    };

    await flushMicrotasks();
    expect(maxConcurrent).toBe(1);

    // Release them one at a time — the queue should keep pace at exactly 1.
    for (let i = 0; i < BATCH_SIZE; i++) {
      releasers.shift()?.();
      await flushMicrotasks();
    }

    expect(maxConcurrent).toBe(1);
  });

  it('processes all incoming real-time WebSocket events correctly', () => {
    const event = storageService.getEvent();
    const serviceInternal = storageService as unknown as {
      handleRealtimeEvent: (msg: { type: string; payload: unknown; eventId?: string }) => void;
    };

    // 1. PHOTO_ADDED
    serviceInternal.handleRealtimeEvent({
      type: 'PHOTO_ADDED',
      eventId: event.id,
      payload: {
        id: 'photo-ws-1',
        eventId: event.id,
        guestId: 'g1',
        guestName: 'Guest 1',
        fullUrl: 'https://cdn.example.com/p1.jpg',
        caption: 'WS Photo',
        status: 'approved',
      },
    });

    const photosAfterAdd = storageService.getPhotos(event.id);
    expect(photosAfterAdd.some((p) => p.id === 'photo-ws-1')).toBe(true);

    // 2. PHOTO_LIKED
    serviceInternal.handleRealtimeEvent({
      type: 'PHOTO_LIKED',
      eventId: event.id,
      payload: { photoId: 'photo-ws-1', guestId: 'g2' },
    });
    const photoLiked = storageService.getPhotos(event.id).find((p) => p.id === 'photo-ws-1');
    expect(photoLiked?.likedByGuestIds).toContain('g2');

    // 3. PHOTO_UNLIKED
    serviceInternal.handleRealtimeEvent({
      type: 'PHOTO_UNLIKED',
      eventId: event.id,
      payload: { photoId: 'photo-ws-1', guestId: 'g2' },
    });
    const photoUnliked = storageService.getPhotos(event.id).find((p) => p.id === 'photo-ws-1');
    expect(photoUnliked?.likedByGuestIds).not.toContain('g2');

    // 4. COMMENT_ADDED
    serviceInternal.handleRealtimeEvent({
      type: 'COMMENT_ADDED',
      eventId: event.id,
      payload: {
        id: 'comm-ws-1',
        photoId: 'photo-ws-1',
        guestId: 'g3',
        guestName: 'Guest 3',
        commentText: 'Awesome!',
      },
    });
    const photoCommented = storageService.getPhotos(event.id).find((p) => p.id === 'photo-ws-1');
    expect(photoCommented?.commentsCount).toBe(1);

    // 5. PHOTO_STATUS_UPDATED
    serviceInternal.handleRealtimeEvent({
      type: 'PHOTO_STATUS_UPDATED',
      eventId: event.id,
      payload: { photoId: 'photo-ws-1', status: 'featured' },
    });
    expect(storageService.getPhotos(event.id).find((p) => p.id === 'photo-ws-1')?.status).toBe('featured');

    // 6. PHOTO_REMOVED
    serviceInternal.handleRealtimeEvent({
      type: 'PHOTO_REMOVED',
      eventId: event.id,
      payload: { photoId: 'photo-ws-1' },
    });
    expect(storageService.getPhotos(event.id).some((p) => p.id === 'photo-ws-1')).toBe(false);

    // 7. QUEST_ADDED & QUEST_DELETED
    serviceInternal.handleRealtimeEvent({
      type: 'QUEST_ADDED',
      eventId: event.id,
      payload: {
        id: 'quest-ws-1',
        eventId: event.id,
        title: 'Dance Challenge',
        points: 20,
      },
    });
    expect(storageService.getQuests(event.id).some((q) => q.id === 'quest-ws-1')).toBe(true);

    serviceInternal.handleRealtimeEvent({
      type: 'QUEST_DELETED',
      eventId: event.id,
      payload: { questId: 'quest-ws-1' },
    });
    expect(storageService.getQuests(event.id).some((q) => q.id === 'quest-ws-1')).toBe(false);

    // 8. AUDIO_ADDED
    serviceInternal.handleRealtimeEvent({
      type: 'AUDIO_ADDED',
      eventId: event.id,
      payload: {
        id: 'aud-ws-1',
        eventId: event.id,
        guestId: 'g1',
        audioUrl: 'https://cdn.example.com/a.mp4',
        durationSeconds: 15,
      },
    });
    expect(storageService.getAudioEntries(event.id).some((a) => a.id === 'aud-ws-1')).toBe(true);

    // 9. EVENT_UPDATED
    serviceInternal.handleRealtimeEvent({
      type: 'EVENT_UPDATED',
      eventId: event.id,
      payload: { venueName: 'WS Castle Venue' },
    });
    expect(storageService.getEvent().venueName).toBe('WS Castle Venue');
  });

  it('supports deletePhoto, loadEventBySlug, syncFromBackend, and resetToDefaults', async () => {
    global.fetch = vi.fn().mockResolvedValue(createMockResponse({ success: true }));

    const event = storageService.getEvent();
    const guest: Guest = { id: 'g1', eventId: event.id, name: 'G1', createdAt: new Date().toISOString() };
    storageService.setCurrentGuest(guest);

    const photo = await storageService.addPhoto({
      guestId: 'g1',
      guestName: 'G1',
      fullUrl: 'https://cdn.example.com/del.jpg',
    });

    expect(storageService.getPhotos(event.id).some((p) => p.id === photo.id)).toBe(true);
    await storageService.deletePhoto(photo.id);
    expect(storageService.getPhotos(event.id).some((p) => p.id === photo.id)).toBe(false);

    // Mock loadEventBySlug
    const mockRemoteEvent: Partial<WeddingEvent> = {
      id: 'e-remote-1',
      slug: 'remote-wedding',
      title: 'Remote Wedding',
      hostName: 'Remote Host',
      hostEmail: 'host@remote.com',
      eventDate: '2026-10-10T16:00:00Z',
      venueName: 'Beach Villa',
      welcomeMessage: 'Welcome!',
      themePalette: 'rose_blush',
      planTier: 'deluxe_keepsake',
    };

    vi.spyOn(eventsApi, 'getBySlug').mockResolvedValue(mockRemoteEvent as WeddingEvent);
    vi.spyOn(photosApi, 'list').mockResolvedValue([]);
    vi.spyOn(questsApi, 'list').mockResolvedValue([]);
    vi.spyOn(audioApi, 'list').mockResolvedValue([]);
    vi.spyOn(eventsApi, 'getQRConfig').mockResolvedValue({} as QRCanvasConfig);

    const loaded = await storageService.loadEventBySlug('remote-wedding');
    expect(loaded?.slug).toBe('remote-wedding');
    expect(storageService.getEvent().id).toBe('e-remote-1');

    // Test resetToDefaults
    storageService.resetToDefaults();
    expect(storageService.getEvent()).toBeDefined();
  });

  describe('demo fixtures are never a fallback for a real, uncached visitor (P8)', () => {
    it('returns empty collections, not the sample wedding, with no cache and demo mode off', () => {
      // A brand-new browser with zero localStorage state resolves to the same
      // fallback event id the demo seed also uses - the bug wasn't reachable
      // through eventId scoping, only through never seeding in the first place.
      expect(storageService.getGuests()).toEqual([]);
      expect(storageService.getPhotos()).toEqual([]);
      expect(storageService.getQuests()).toEqual([]);
      expect(storageService.getAudioEntries()).toEqual([]);
    });

    it('returns a generic QR canvas default, not the demo fixture headline/copy', () => {
      const config = storageService.getQRCanvasConfig();
      expect(config.headline).toBe('');
      expect(config.subtext).toBe('');
      expect(config.headline).not.toContain('Запечатайте');
    });
  });

  describe('offline-queued photo reconciles with its server id on flush, not duplicated (FE-03)', () => {
    it('replaces the local temp-id photo with the server one instead of adding a second row', async () => {
      storageService.updateEvent({ id: 'event-fe03', slug: 'fe03-spec' });

      // This file doesn't reset the shared offlineQueue's IndexedDB between
      // tests (unlike offlineQueue.spec.ts's dedicated reset) - drain
      // whatever earlier tests left behind so this test's own item is the
      // only one in play.
      for (const stale of await offlineQueue.getQueue()) {
        await offlineQueue.removeItem(stale.id);
      }

      // Simulate what addPhoto's optimistic-UI path already does on the
      // direct-success case, but leave it enqueued as if the initial online
      // attempt had failed — isolates the enqueue -> flush -> reconcile
      // pipeline (FE-03) from addPhoto's own fire-and-forget network timing.
      const localId = 'photo-fe03-local';
      const photos = [
        {
          id: localId,
          eventId: 'event-fe03',
          guestId: 'guest-1',
          guestName: 'Spec Guest',
          storagePath: '',
          thumbnailUrl: 'data:image/jpeg;base64,AA==',
          fullUrl: 'data:image/jpeg;base64,AA==',
          status: 'approved',
          filterApplied: 'original',
          likesCount: 0,
          commentsCount: 0,
          likedByGuestIds: [],
          comments: [],
          createdAt: new Date().toISOString(),
        },
      ];
      localStorage.setItem('wedmoments_photos_event-fe03', JSON.stringify(photos));

      await offlineQueue.enqueue('photo', {
        eventId: 'event-fe03',
        localId,
        guestId: 'guest-1',
        fullUrl: 'data:image/jpeg;base64,AA==',
      });
      // Other tests in this file share the same singleton offlineQueue and
      // leave un-awaited background work in flight, so tolerate other items
      // being present — only this test's own item is asserted on.
      expect((await offlineQueue.getQueue()).some((i) => i.payload.localId === localId)).toBe(true);

      const fetchSpy = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => ({
          id: 'server-photo-fe03',
          localId,
          eventId: 'event-fe03',
          guestId: 'guest-1',
          fullUrl: 'https://cdn.example.com/photo.jpg',
        }),
      } as unknown as Response);
      global.fetch = fetchSpy;

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (offlineQueue as any).isProcessing = false;
      const isOnlineSpy = vi.spyOn(offlineQueue, 'isOnline').mockReturnValue(true);
      await offlineQueue.flushQueue();
      isOnlineSpy.mockRestore();

      expect(fetchSpy).toHaveBeenCalled();

      const updated = storageService.getPhotos('event-fe03');
      expect(updated.some((p) => p.id === localId)).toBe(false);
      const reconciled = updated.find((p) => p.id === 'server-photo-fe03');
      expect(reconciled).toBeDefined();
      expect(reconciled?.fullUrl).toBe('https://cdn.example.com/photo.jpg');
      // Exactly one row for this photo, not two.
      expect(updated.filter((p) => p.guestId === 'guest-1').length).toBe(1);
    });
  });
});
