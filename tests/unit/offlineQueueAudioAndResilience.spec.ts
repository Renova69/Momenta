import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OfflineQueueService } from '../../src/services/offlineQueueService';

/**
 * The flush path's shape and its refusals.
 *
 * `offlineQueue.spec.ts` covers the queue itself — enqueue, the size cap, the
 * IndexedDB transaction semantics, and reconciliation after a successful
 * upload. This covers what actually goes on the wire and when it doesn't.
 *
 * The audio half is the part that has to be right by construction. `/api/audio`
 * takes multipart only, so a queued voice message cannot be replayed as JSON
 * the way a queued photo is; it has to be rebuilt into a FormData with the
 * Blob still attached. That blob only survives the wait because the queue moved
 * to IndexedDB — the old localStorage queue could not have serialized it at
 * all — so an audio item that flushes as anything other than multipart is a
 * guest's message lost on a venue's wifi, which is exactly the condition the
 * queue exists for.
 */

function jsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
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

/** jsdom reports a fixed navigator.onLine, so the flag has to be replaced. */
function setOnline(value: boolean) {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value });
}

let queue: OfflineQueueService;

beforeEach(async () => {
  localStorage.clear();
  vi.restoreAllMocks();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  await resetQueueDb();
  setOnline(true);
  queue = new OfflineQueueService();
});

afterEach(() => {
  setOnline(true);
});

describe('flushing an audio item', () => {
  /**
   * Hand the flush a queued item directly, rather than through the store.
   *
   * `fake-indexeddb` structured-clones a Blob into a plain object, so a Blob
   * put into the queue here does not come back as one — `instanceof Blob` is
   * false and the audio part is skipped. A real browser's IndexedDB stores
   * Blobs natively, so that is a limitation of the double and not of the code.
   * Reading the queue through this seam keeps these tests about the thing they
   * are actually checking: how a queued voice message is rebuilt into a
   * request. The round-trip itself is covered in `offlineQueue.spec.ts`.
   */
  function queueHolding(payload: Record<string, unknown>) {
    vi.spyOn(queue, 'getQueue').mockResolvedValue([
      { id: 'queue-1', type: 'audio', payload, queuedAt: new Date().toISOString(), retryCount: 0 },
    ]);
  }

  it('posts multipart with the blob attached, not JSON', async () => {
    const audioBlob = new Blob(['voice'], { type: 'audio/webm' });
    queueHolding({ audioBlob, audioFilename: 'greeting.webm', eventId: 'e1', guestId: 'g1' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'a1' }));
    await queue.flushQueue();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/audio');
    expect(init.body).toBeInstanceOf(FormData);
    // A Content-Type set by hand would omit the multipart boundary and the
    // server would reject the body it just received.
    expect(init.headers).not.toHaveProperty('Content-Type');

    const form = init.body as FormData;
    expect(form.get('audio')).toBeInstanceOf(Blob);
    expect(form.get('eventId')).toBe('e1');
  });

  it('keeps the guest’s filename', async () => {
    const audioBlob = new Blob(['voice'], { type: 'audio/webm' });
    queueHolding({ audioBlob, audioFilename: 'greeting.webm', eventId: 'e1' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'a1' }));
    await queue.flushQueue();

    const form = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
    expect((form.get('audio') as File).name).toBe('greeting.webm');
  });

  it('falls back to a default filename', async () => {
    const audioBlob = new Blob(['voice'], { type: 'audio/webm' });
    queueHolding({ audioBlob, eventId: 'e1' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'a1' }));
    await queue.flushQueue();

    const form = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
    expect((form.get('audio') as File).name).toBe('audio-message.webm');
  });

  it('does not attach a payload that is no longer a Blob', async () => {
    // Better a request the server refuses with a clear error than a throw
    // inside the flush loop that stalls every item behind it.
    queueHolding({ audioBlob: { size: 12 }, eventId: 'e1', guestName: 'Ana' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'a1' }));
    await queue.flushQueue();

    const form = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
    expect(form.get('audio')).toBeNull();
    expect(form.get('guestName')).toBe('Ana');
  });

  it('omits absent fields rather than sending the string "null"', async () => {
    const audioBlob = new Blob(['voice'], { type: 'audio/webm' });
    queueHolding({ audioBlob, eventId: 'e1', note: null, guestId: undefined });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'a1' }));
    await queue.flushQueue();

    const form = (fetchSpy.mock.calls[0][1] as RequestInit).body as FormData;
    expect(form.has('note')).toBe(false);
    expect(form.has('guestId')).toBe(false);
  });

  it('sends the audio to /api/audio and never to /api/photos', async () => {
    queueHolding({ audioBlob: new Blob(['voice']), eventId: 'e1' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'a1' }));
    await queue.flushQueue();

    expect(fetchSpy.mock.calls[0][0]).not.toContain('/api/photos');
  });
});

describe('flushing a photo item', () => {
  it('posts JSON to /api/photos', async () => {
    setOnline(false);
    await queue.enqueue('photo', { eventId: 'e1', imageUrl: 'data:image/jpeg;base64,AAA' });
    setOnline(true);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'p1' }));
    await queue.flushQueue();

    const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/api/photos');
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    expect(JSON.parse(init.body as string)).toMatchObject({ eventId: 'e1' });
  });

  it('carries the host token when one is stored', async () => {
    localStorage.setItem('wedmoments_host_token', 'jwt-abc');
    setOnline(false);
    await queue.enqueue('photo', { eventId: 'e1' });
    setOnline(true);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'p1' }));
    await queue.flushQueue();

    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer jwt-abc');
  });

  it('sends no Authorization header for a guest', async () => {
    // Guests are the common case here and have no host token; sending the
    // header with an empty value would be a malformed credential rather than
    // an absent one.
    setOnline(false);
    await queue.enqueue('photo', { eventId: 'e1' });
    setOnline(true);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'p1' }));
    await queue.flushQueue();

    const headers = (fetchSpy.mock.calls[0][1] as RequestInit).headers as Record<string, string>;
    expect(headers).not.toHaveProperty('Authorization');
  });
});

describe('when the flush must not run', () => {
  it('sends nothing while offline', async () => {
    setOnline(false);
    await queue.enqueue('photo', { eventId: 'e1' });

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));
    await queue.flushQueue();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await queue.getQueue()).toHaveLength(1);
  });

  it('does not run a second flush on top of one already in flight', async () => {
    // Two overlapping flushes would each read the same queue and upload every
    // item twice — a duplicated photo in the feed for every guest who came
    // back into signal while a flush was running.
    setOnline(false);
    await queue.enqueue('photo', { eventId: 'e1' });
    setOnline(true);

    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached!: () => void;
    const firstRequestSent = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      reached();
      await inFlight;
      return jsonResponse({ id: 'p1' });
    });

    const first = queue.flushQueue();
    await firstRequestSent;
    await queue.flushQueue();
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('does nothing when the queue is empty', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({}));

    await queue.flushQueue();

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('a failed upload', () => {
  it('keeps the item and counts the attempt when the server refuses it', async () => {
    setOnline(false);
    await queue.enqueue('photo', { eventId: 'e1' });
    setOnline(true);

    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    await queue.flushQueue();

    const remaining = await queue.getQueue();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].retryCount).toBe(1);
  });

  it('keeps the item when the network throws outright', async () => {
    setOnline(false);
    await queue.enqueue('photo', { eventId: 'e1' });
    setOnline(true);

    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await queue.flushQueue();

    const remaining = await queue.getQueue();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].retryCount).toBe(1);
  });

  it('does not stall the rest of the queue behind one bad item', async () => {
    setOnline(false);
    await queue.enqueue('photo', { eventId: 'first' });
    await queue.enqueue('photo', { eventId: 'second' });
    setOnline(true);

    // Which item the server refuses is decided by its payload, not by the
    // order the requests arrive in. getQueue() reads an IndexedDB object store
    // keyed on the item id, and two items enqueued in the same millisecond
    // differ only by a random suffix — so the flush order between them is not
    // fixed, and a mock that failed "the first call" would fail whichever item
    // happened to sort first.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const body = JSON.parse((init as RequestInit).body as string) as { eventId: string };
      return body.eventId === 'first'
        ? jsonResponse({ error: 'boom' }, 500)
        : jsonResponse({ id: 'p2' });
    });

    await queue.flushQueue();

    const remaining = await queue.getQueue();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].payload.eventId).toBe('first');
  });
});

describe('subscribers', () => {
  it('reports the queued count and connectivity on every change', async () => {
    const listener = vi.fn();
    queue.subscribe(listener);

    setOnline(false);
    await queue.enqueue('photo', { eventId: 'e1' });

    expect(listener).toHaveBeenCalledWith(1, false);
  });

  it('stops reporting once unsubscribed', async () => {
    const listener = vi.fn();
    const unsubscribe = queue.subscribe(listener);
    unsubscribe();

    setOnline(false);
    await queue.enqueue('photo', { eventId: 'e1' });

    expect(listener).not.toHaveBeenCalled();
  });

  it('stops reporting successes once the flush listener is removed', async () => {
    const listener = vi.fn();
    const unsubscribe = queue.onFlushSuccess(listener);
    unsubscribe();

    setOnline(false);
    await queue.enqueue('photo', { eventId: 'e1' });
    setOnline(true);
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'p1' }));

    await queue.flushQueue();

    expect(listener).not.toHaveBeenCalled();
  });
});

describe('coming back into signal', () => {
  it('flushes on the browser’s online event', async () => {
    // The guest does not press anything — they walk back towards the router.
    setOnline(false);
    await queue.enqueue('photo', { eventId: 'e1' });
    setOnline(true);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ id: 'p1' }));
    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());

    await vi.waitFor(async () => expect(await queue.getQueue()).toHaveLength(0));
  });

  it('notifies subscribers when connectivity drops', async () => {
    const listener = vi.fn();
    queue.subscribe(listener);

    setOnline(false);
    window.dispatchEvent(new Event('offline'));

    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(0, false));
  });
});

describe('isOnline', () => {
  it('assumes online when the browser does not report connectivity', () => {
    // navigator.onLine is absent in some embedded webviews. Assuming offline
    // there would queue every upload forever and never flush.
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: undefined });
    expect(queue.isOnline()).toBe(true);
  });

  it('reports the browser’s own answer when it has one', () => {
    setOnline(false);
    expect(queue.isOnline()).toBe(false);
  });
});
