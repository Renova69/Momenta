import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Where a queued upload is actually sent.
 *
 * The deployed topology has the app on one origin and the API on another
 * (`VITE_API_URL`). A flush that resolved its base URL from the page instead
 * would POST every photo a guest took offline at the static host, get a 404,
 * count a retry, and drop the photo after the third one — the exact failure
 * the queue exists to prevent, and only in production.
 *
 * `ENV` reads the environment once at import, so it is mocked before the
 * service is loaded. That is also why this lives in its own file.
 */

vi.mock('../../src/config/env', () => ({
  ENV: { API_URL: 'https://api.example.com/', WS_URL: 'wss://api.example.com', IS_PROD: false },
}));

const { OfflineQueueService } = await import('../../src/services/offlineQueueService');

function response(status = 201): Response {
  return {
    ok: status < 400,
    status,
    json: async () => ({ id: 'server-1', localId: 'photo-local-1' }),
    text: async () => '{}',
  } as Response;
}

function resetQueueDb(): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.deleteDatabase('wedmoments_offline_queue');
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
    req.onblocked = () => resolve();
  });
}

describe('the base URL a flush posts to', () => {
  beforeEach(async () => {
    localStorage.clear();
    vi.restoreAllMocks();
    await resetQueueDb();
  });

  it('is the configured API host, not the page the guest happens to be on', async () => {
    const queue = new OfflineQueueService();
    const isOnline = vi.spyOn(queue, 'isOnline').mockReturnValue(false);
    await queue.enqueue('photo', {
      eventId: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
      localId: 'photo-local-1',
      fullUrl: 'data:image/jpeg;base64,AA==',
    });

    const fetchMock = vi.fn().mockResolvedValue(response());
    global.fetch = fetchMock;
    isOnline.mockReturnValue(true);
    await queue.flushQueue();

    expect(fetchMock).toHaveBeenCalledWith('https://api.example.com/api/photos', expect.anything());
  });
});
