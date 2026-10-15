import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * N-61 — uploads queued offline went up only on an 'online' event or the next
 * enqueue. A guest who took photos without signal, closed the tab and opened
 * it again later with signal had them sitting on the phone while they
 * believed they were uploaded. The app now flushes the queue when it starts.
 *
 * The storage service is a module-level singleton built at import, so the
 * module is loaded fresh with the queue's flush already being watched.
 */
afterEach(() => {
  vi.resetModules();
  vi.restoreAllMocks();
});

describe('when the app starts (N-61)', () => {
  it('flushes uploads left in the queue from an earlier visit', async () => {
    vi.resetModules();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);
    const { offlineQueue } = await import('../../src/services/offlineQueueService');
    const flush = vi.spyOn(offlineQueue, 'flushQueue').mockResolvedValue(undefined);

    await import('../../src/services/storageService');

    expect(flush).toHaveBeenCalled();
  });
});

/**
 * N-148 — a returning visitor got the album from this browser's cache and
 * the record was never asked for again: a guest reopening the link saw the
 * title from their last visit after the host had renamed it, and a host who
 * had bought a plan on another device saw the studio still locked.
 */
describe('when the app starts with an album cached (N-148)', () => {
  const ALBUM_ID = 'dddddddd-4444-4555-8666-777788889999';

  function answer(body: unknown, status = 200): Response {
    return { ok: status < 400, status, json: async () => body } as Response;
  }

  it('reads the album record again, quietly', async () => {
    vi.resetModules();
    localStorage.setItem('wedmoments_active_event_id', ALBUM_ID);
    localStorage.setItem(`wedmoments_event_${ALBUM_ID}`, JSON.stringify({ id: ALBUM_ID, slug: 'mira-i-daniel', title: 'Old title' }));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) =>
      String(input).includes('/api/events/slug/mira-i-daniel')
        ? answer({ id: ALBUM_ID, slug: 'mira-i-daniel', title: 'New title' })
        : answer({}, 503)
    );
    const { offlineQueue } = await import('../../src/services/offlineQueueService');
    vi.spyOn(offlineQueue, 'flushQueue').mockResolvedValue(undefined);

    const { storageService } = await import('../../src/services/storageService');

    await vi.waitFor(() => expect(storageService.getEvent().title).toBe('New title'));
    localStorage.clear();
  });

  it('asks nothing for the demo album that stands in for none', async () => {
    vi.resetModules();
    localStorage.clear();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(answer({}, 503));
    const { offlineQueue } = await import('../../src/services/offlineQueueService');
    vi.spyOn(offlineQueue, 'flushQueue').mockResolvedValue(undefined);

    await import('../../src/services/storageService');
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(fetchSpy.mock.calls.map(([url]) => String(url)).filter((u) => u.includes('/api/events/slug/'))).toEqual([]);
  });
});

describe('when the live connection comes back (N-68)', () => {
  it('reloads the album and its details, since what was sent meanwhile is lost', async () => {
    vi.resetModules();
    let handlers: { onReconnect?: () => void } | undefined;
    vi.doMock('../../src/services/realtimeSocket', () => ({
      RealtimeSocket: class {
        constructor(_host: string, h: { onReconnect?: () => void }) {
          handlers = h;
        }
        connect() {}
        joinEventRoom() {}
      },
    }));
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);
    const { offlineQueue } = await import('../../src/services/offlineQueueService');
    vi.spyOn(offlineQueue, 'flushQueue').mockResolvedValue(undefined);
    const { storageService } = await import('../../src/services/storageService');
    const sync = vi.spyOn(storageService, 'syncFromBackend').mockResolvedValue(undefined);
    const refresh = vi.spyOn(storageService, 'refreshEventDetails').mockResolvedValue(undefined);

    handlers?.onReconnect?.();

    expect(sync).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledTimes(1);
    vi.doUnmock('../../src/services/realtimeSocket');
  });
});
