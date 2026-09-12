import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OfflineQueueService, withStore } from '../../src/services/offlineQueueService';

/**
 * Regression for OPEN_ITEMS.md P2 — the offline queue used to live in
 * localStorage and serialize the full upload payload, including a raw
 * capture's uncompressed `originalUrl` data URL (5-15MB). A single queued
 * offline photo could exceed the origin's entire 5MB localStorage quota by
 * itself; the old code caught the QuotaExceededError and silently dropped
 * the item — permanent photo loss with no signal to the guest.
 *
 * The queue now lives in IndexedDB (no such ceiling in practice), so the
 * same payload that used to blow the quota must enqueue cleanly.
 */

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

/** A base64 blob roughly the size of an uncompressed phone-camera capture. */
function bigDataUrl(megabytes: number): string {
  return 'data:image/jpeg;base64,' + 'A'.repeat(megabytes * 1024 * 1024);
}

function resetQueueDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('wedmoments_offline_queue');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

describe('Offline Queue & Resilience Spec', () => {
  let queueService: OfflineQueueService;

  beforeEach(async () => {
    localStorage.clear();
    vi.restoreAllMocks();
    await resetQueueDb();
    queueService = new OfflineQueueService();
  });

  it('initializes with an empty queue and checks online status', async () => {
    expect(await queueService.getQueue()).toEqual([]);
    expect(typeof queueService.isOnline()).toBe('boolean');
  });

  it('enqueues photo and audio items and notifies subscribers', async () => {
    vi.spyOn(queueService, 'isOnline').mockReturnValue(false);
    const listener = vi.fn();
    const unsub = queueService.subscribe(listener);

    const item1 = await queueService.enqueue('photo', {
      eventId: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
      guestId: 'guest-1',
      fullUrl: 'https://example.com/photo.jpg',
    });

    expect(item1).not.toBeNull();
    expect((await queueService.getQueue()).length).toBe(1);
    expect(listener).toHaveBeenCalled();

    const item2 = await queueService.enqueue('audio', {
      eventId: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
      guestId: 'guest-1',
      audioUrl: 'https://example.com/audio.mp4',
      durationSeconds: 22,
    });

    expect(item2).not.toBeNull();
    expect((await queueService.getQueue()).length).toBe(2);

    unsub();
  });

  it('atomically removes completed items without race conditions', async () => {
    vi.spyOn(queueService, 'isOnline').mockReturnValue(false);
    const item1 = await queueService.enqueue('photo', { id: 'p1' });
    const item2 = await queueService.enqueue('photo', { id: 'p2' });

    expect((await queueService.getQueue()).length).toBe(2);
    if (item1) await queueService.removeItem(item1.id);

    const remaining = await queueService.getQueue();
    expect(remaining.length).toBe(1);
    expect(remaining[0].id).toBe(item2?.id);
  });

  it('caps queue at MAX_QUEUE_SIZE (50 items)', async () => {
    // Offline: each enqueue() would otherwise fire a real, unmocked,
    // un-awaited flushQueue() (jsdom reports navigator.onLine as true by
    // default) that keeps running past this test's completion and corrupts
    // whichever test runs next against the same underlying IndexedDB.
    vi.spyOn(queueService, 'isOnline').mockReturnValue(false);
    for (let i = 0; i < 55; i++) {
      await queueService.enqueue('photo', { index: i });
    }
    expect((await queueService.getQueue()).length).toBe(50);
  });

  it('flushes queue items successfully on network connectivity', async () => {
    vi.spyOn(queueService, 'isOnline').mockReturnValue(false);
    global.fetch = vi.fn().mockResolvedValue(createMockResponse({ success: true }));

    await queueService.enqueue('photo', { id: 'p1' });
    await queueService.enqueue('audio', { id: 'a1' });

    expect((await queueService.getQueue()).length).toBe(2);

    vi.spyOn(queueService, 'isOnline').mockReturnValue(true);
    await queueService.flushQueue();

    expect((await queueService.getQueue()).length).toBe(0);
  });

  it('increments retries on failure and drops item after exceeding max retries', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('Network offline'));

    // Offline during enqueue so it does not also fire its own un-awaited
    // auto-flush racing the explicit flushQueue() calls below.
    const isOnlineSpy = vi.spyOn(queueService, 'isOnline').mockReturnValue(false);
    await queueService.enqueue('photo', { id: 'fail-photo' });
    expect((await queueService.getQueue()).length).toBe(1);

    isOnlineSpy.mockReturnValue(true);
    await queueService.flushQueue();
    expect((await queueService.getQueue())[0].retryCount).toBe(1);

    // retryCount is at 1; 4 more failing attempts reach MAX_RETRIES (5), and
    // one further call is what actually observes that and drops the item.
    for (let i = 0; i < 5; i++) {
      await queueService.flushQueue();
    }

    expect((await queueService.getQueue()).length).toBe(0);
  });

  it('enqueues a payload too large for localStorage without dropping it (P2)', async () => {
    // The old localStorage-backed queue caught QuotaExceededError here and
    // returned null, silently discarding the guest's photo. 8MB alone
    // exceeds most browsers' 5MB-per-origin localStorage quota.
    vi.spyOn(queueService, 'isOnline').mockReturnValue(false);
    const item = await queueService.enqueue('photo', {
      eventId: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
      guestId: 'guest-1',
      fullUrl: bigDataUrl(1),
      originalUrl: bigDataUrl(8),
    });

    expect(item).not.toBeNull();
    const queue = await queueService.getQueue();
    expect(queue.length).toBe(1);
    expect((queue[0].payload.originalUrl as string).length).toBeGreaterThan(8 * 1024 * 1024);
  });

  it('flushes a large queued payload intact', async () => {
    let sentBody: string | undefined;
    global.fetch = vi.fn().mockImplementation((_url: string, init: RequestInit) => {
      sentBody = init.body as string;
      return Promise.resolve(createMockResponse({ id: 'server-photo-1' }, 201));
    });

    // Offline during enqueue so the explicit flushQueue() below is the only
    // flush attempt in flight — an auto-triggered one racing it can win the
    // single-flight `isProcessing` guard and leave the explicit call a no-op.
    const isOnlineSpy = vi.spyOn(queueService, 'isOnline').mockReturnValue(false);
    await queueService.enqueue('photo', {
      eventId: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
      guestId: 'guest-1',
      fullUrl: bigDataUrl(1),
      originalUrl: bigDataUrl(6),
    });
    isOnlineSpy.mockReturnValue(true);
    await queueService.flushQueue();

    expect(sentBody).toBeDefined();
    expect(JSON.parse(sentBody!).originalUrl.length).toBeGreaterThan(6 * 1024 * 1024);
    expect((await queueService.getQueue()).length).toBe(0);
  });

  describe('withStore waits for tx.oncomplete, not just request.onsuccess (FE-02)', () => {
    // A hand-built fake IDBDatabase/transaction/request gives full control
    // over event timing, independent of whether fake-indexeddb happens to
    // reproduce WebKit's specific early-close-abort bug — this asserts the
    // actual contract: resolving (and closing the connection) only after
    // the transaction is durable, not merely after the request is accepted.
    function buildFakeDb(resultValue: string) {
      const req: { result: string; onsuccess?: () => void; onerror?: () => void } = {
        result: resultValue,
      };
      const tx: { oncomplete?: () => void; onerror?: () => void; onabort?: () => void } = {};
      const closeSpy = vi.fn();
      const fakeTx: Record<string, unknown> = { objectStore: () => ({}) };
      Object.defineProperties(fakeTx, {
        oncomplete: { get: () => tx.oncomplete, set: (v) => { tx.oncomplete = v; } },
        onerror: { get: () => tx.onerror, set: (v) => { tx.onerror = v; } },
        onabort: { get: () => tx.onabort, set: (v) => { tx.onabort = v; } },
      });
      const db = {
        transaction: () => fakeTx,
        close: closeSpy,
      };
      return {
        db: db as unknown as IDBDatabase,
        request: req as unknown as IDBRequest,
        fireRequestSuccess: () => req.onsuccess?.(),
        fireTxComplete: () => tx.oncomplete?.(),
        closeSpy,
      };
    }

    it('does not resolve (or close the connection) on request.onsuccess alone', async () => {
      const { db, request, fireRequestSuccess, closeSpy } = buildFakeDb('server-value');
      let resolved = false;
      const promise = withStore('readwrite', () => request, db);
      promise.then(() => { resolved = true; });

      fireRequestSuccess();
      await Promise.resolve();
      await Promise.resolve();

      expect(resolved).toBe(false);
      expect(closeSpy).not.toHaveBeenCalled();
    });

    it('resolves with the request result and closes the connection once tx.oncomplete fires', async () => {
      const { db, request, fireRequestSuccess, fireTxComplete, closeSpy } = buildFakeDb('server-value');
      const promise = withStore('readwrite', () => request, db);

      fireRequestSuccess();
      fireTxComplete();

      const result = await promise;
      expect(result).toBe('server-value');
      expect(closeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('flushQueue reports success back for reconciliation (FE-03)', () => {
    it('fires an onFlushSuccess listener with the parsed server response, after removing the item', async () => {
      global.fetch = vi.fn().mockResolvedValue(
        createMockResponse({ id: 'server-photo-1', localId: 'photo-local-1', guestId: 'g1' }, 201)
      );

      const isOnlineSpy = vi.spyOn(queueService, 'isOnline').mockReturnValue(false);
      await queueService.enqueue('photo', {
        eventId: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
        localId: 'photo-local-1',
        fullUrl: 'data:image/jpeg;base64,AA==',
      });

      const received: Array<{ type: string; response: unknown }> = [];
      const unsub = queueService.onFlushSuccess((item, response) => {
        received.push({ type: item.type, response });
      });

      isOnlineSpy.mockReturnValue(true);
      await queueService.flushQueue();

      expect((await queueService.getQueue()).length).toBe(0);
      expect(received.length).toBe(1);
      expect(received[0].type).toBe('photo');
      expect((received[0].response as { id: string }).id).toBe('server-photo-1');
      expect((received[0].response as { localId: string }).localId).toBe('photo-local-1');

      unsub();
    });

    it('does not fire onFlushSuccess when the response is not JSON', async () => {
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 201,
        json: async () => { throw new Error('not json'); },
      } as unknown as Response);

      const isOnlineSpy = vi.spyOn(queueService, 'isOnline').mockReturnValue(false);
      await queueService.enqueue('photo', { localId: 'photo-local-2' });

      const listener = vi.fn();
      const unsub = queueService.onFlushSuccess(listener);

      isOnlineSpy.mockReturnValue(true);
      await queueService.flushQueue();

      // The item is still removed - the upload itself succeeded - just
      // nothing to reconcile.
      expect((await queueService.getQueue()).length).toBe(0);
      expect(listener).not.toHaveBeenCalled();

      unsub();
    });
  });
});
