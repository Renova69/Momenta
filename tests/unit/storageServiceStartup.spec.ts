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
