import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  syncFromBackend,
  initializeDefaults,
  resetToDefaults,
} from '../../src/services/storageSyncService';
import { photosApi } from '../../src/api/photosApi';
import { questsApi } from '../../src/api/questsApi';
import { audioApi } from '../../src/api/audioApi';
import { eventsApi } from '../../src/api/eventsApi';
import { STORAGE_KEYS } from '../../src/services/storageKeys';
import { ServiceContext } from '../../src/services/storageServiceContext';
import { Photo } from '../../src/types';

/**
 * Pulling an album down from the server.
 *
 * Three things here have already gone wrong once, and all three are invisible
 * from the outside — the app looks like it is working, it is just showing less
 * than it should:
 *
 *   **H3 — an album larger than one page.** This asked for 100 photos and
 *   stopped. A wedding with 400 showed 100 and never more; nothing errored,
 *   nothing logged, the feed simply ended. The server has supported a composite
 *   keyset cursor all along and nothing passed it.
 *
 *   **The offline merge.** A photo taken with no signal lives under a temporary
 *   `photo-…` id until it reaches the server. A sync that replaced the local
 *   list wholesale would take it out of the guest's own feed while it was still
 *   queued — their photo visibly disappearing.
 *
 *   **Demo seeding.** Fixtures used to be written unconditionally, so every
 *   first-time visitor to the bare domain browsed a fictional wedding with fake
 *   guests, indistinguishable from real data.
 */

const EVENT = 'event-1';

function photo(id: string, over: Partial<Photo> = {}): Photo {
  return {
    id,
    eventId: EVENT,
    guestId: 'g1',
    guestName: 'Ana',
    createdAt: '2026-01-01T00:00:00.000Z',
    priority: 0,
    status: 'approved',
    ...over,
  } as Photo;
}

/** A page of exactly PHOTO_PAGE_SIZE photos, so the walk continues. */
function fullPage(prefix: string): Photo[] {
  return Array.from({ length: 100 }, (_, i) =>
    photo(`${prefix}-${i}`, { createdAt: new Date(1_760_000_000_000 + i * 1000).toISOString() })
  );
}

let localPhotos: Photo[] = [];

function context(over: Partial<ServiceContext> = {}): ServiceContext {
  return {
    getEvent: () => ({ id: EVENT }) as never,
    getPhotos: () => localPhotos,
    notify: vi.fn(),
    ...over,
  } as unknown as ServiceContext;
}

beforeEach(() => {
  localStorage.clear();
  localPhotos = [];
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(questsApi, 'list').mockResolvedValue([]);
  vi.spyOn(audioApi, 'list').mockResolvedValue([]);
  vi.spyOn(eventsApi, 'getQRConfig').mockResolvedValue(null as never);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('fetching an album larger than one page (H3)', () => {
  it('walks past the first page instead of stopping at 100', async () => {
    const list = vi
      .spyOn(photosApi, 'list')
      .mockResolvedValueOnce(fullPage('a'))
      .mockResolvedValueOnce([photo('b-0')]);

    await syncFromBackend(context(), EVENT);

    expect(list).toHaveBeenCalledTimes(2);
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT)) || '[]');
    expect(stored).toHaveLength(101);
  });

  it('passes a composite priority:timestamp cursor, not a bare timestamp', async () => {
    // A plain timestamp cursor silently skips photographer-priority rows,
    // which is the whole reason the server's ordering is composite.
    const page = fullPage('a');
    page[page.length - 1] = photo('last', {
      priority: 10,
      createdAt: '2026-02-03T04:05:06.000Z',
    });
    const list = vi
      .spyOn(photosApi, 'list')
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([]);

    await syncFromBackend(context(), EVENT);

    expect(list.mock.calls[1][2]).toBe('10:2026-02-03T04:05:06.000Z');
  });

  it('treats a missing priority as zero in the cursor', async () => {
    const page = fullPage('a');
    page[page.length - 1] = photo('last', {
      priority: undefined,
      createdAt: '2026-02-03T04:05:06.000Z',
    });
    const list = vi.spyOn(photosApi, 'list').mockResolvedValueOnce(page).mockResolvedValueOnce([]);

    await syncFromBackend(context(), EVENT);

    expect(list.mock.calls[1][2]).toBe('0:2026-02-03T04:05:06.000Z');
  });

  it('stops on a short page', async () => {
    const list = vi.spyOn(photosApi, 'list').mockResolvedValue([photo('only')]);

    await syncFromBackend(context(), EVENT);

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('stops on an empty page', async () => {
    const list = vi.spyOn(photosApi, 'list').mockResolvedValueOnce(fullPage('a')).mockResolvedValueOnce([]);

    await syncFromBackend(context(), EVENT);

    expect(list).toHaveBeenCalledTimes(2);
  });

  it('stops rather than looping forever against a server that never ends', async () => {
    // A response that is always exactly a full page would otherwise spin until
    // the tab dies. 20 pages is 2000 photos, comfortably past a real wedding.
    let n = 0;
    const list = vi.spyOn(photosApi, 'list').mockImplementation(async () => fullPage(`p${n++}`));

    await syncFromBackend(context(), EVENT);

    expect(list).toHaveBeenCalledTimes(20);
  });

  it('stops when the last row carries no usable timestamp to page from', async () => {
    const page = fullPage('a');
    page[page.length - 1] = photo('last', { createdAt: 'not-a-date' });
    const list = vi.spyOn(photosApi, 'list').mockResolvedValueOnce(page).mockResolvedValue([]);

    await syncFromBackend(context(), EVENT);

    expect(list).toHaveBeenCalledTimes(1);
  });

  it('deduplicates a row that appears on two pages', async () => {
    // The cursor timestamp is millisecond-precision JSON while Postgres stores
    // microseconds, so a page boundary between two rows sharing a priority and
    // a millisecond can repeat one. Cheaper to dedupe than to reason about.
    const first = fullPage('a');
    vi.spyOn(photosApi, 'list')
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce([first[first.length - 1], photo('new')]);

    await syncFromBackend(context(), EVENT);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT)) || '[]');
    expect(stored).toHaveLength(101);
    expect(new Set(stored.map((p: Photo) => p.id)).size).toBe(101);
  });
});

describe('when the network drops mid-album', () => {
  it('keeps the pages it already has rather than losing the lot', async () => {
    // 100 photos beats zero when the venue Wi-Fi goes.
    vi.spyOn(photosApi, 'list')
      .mockResolvedValueOnce(fullPage('a'))
      .mockRejectedValueOnce(new Error('network down'));

    await syncFromBackend(context(), EVENT);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT)) || '[]');
    expect(stored).toHaveLength(100);
  });

  it('falls back to the local cache when even the first page fails', async () => {
    vi.spyOn(photosApi, 'list').mockRejectedValue(new Error('network down'));

    await expect(syncFromBackend(context(), EVENT)).resolves.toBeUndefined();

    expect(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT))).toBeNull();
  });
});

describe('merging with photos that have not reached the server', () => {
  it('keeps a queued offline photo in the feed', async () => {
    // Its id is still the temporary `photo-…` one. Replacing the local list
    // wholesale would take the guest's own photo out of their own feed while
    // it was still waiting to upload.
    localPhotos = [photo('photo-local-1'), photo('server-1')];
    vi.spyOn(photosApi, 'list').mockResolvedValue([photo('server-1')]);

    await syncFromBackend(context(), EVENT);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT)) || '[]');
    expect(stored.map((p: Photo) => p.id)).toContain('photo-local-1');
  });

  it('drops the temporary copy once the server has the photo under that id', async () => {
    // Otherwise the same picture sits in the feed twice, forever.
    localPhotos = [photo('photo-local-1')];
    vi.spyOn(photosApi, 'list').mockResolvedValue([photo('photo-local-1')]);

    await syncFromBackend(context(), EVENT);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT)) || '[]');
    expect(stored).toHaveLength(1);
  });

  it('does not resurrect a server photo the host has since deleted', async () => {
    // A local row with a real server id is the server's to remove: only the
    // temp-id ones are carried over.
    localPhotos = [photo('server-deleted')];
    vi.spyOn(photosApi, 'list').mockResolvedValue([photo('server-1')]);

    await syncFromBackend(context(), EVENT);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT)) || '[]');
    expect(stored.map((p: Photo) => p.id)).toEqual(['server-1']);
  });
});

describe('the rest of the sync', () => {
  beforeEach(() => {
    vi.spyOn(photosApi, 'list').mockResolvedValue([]);
  });

  it('does nothing without an event to sync', async () => {
    const ctx = context({ getEvent: () => null as never });

    await syncFromBackend(ctx);

    expect(photosApi.list).not.toHaveBeenCalled();
  });

  it('falls back to the context event when no override is given', async () => {
    await syncFromBackend(context());

    expect(photosApi.list).toHaveBeenCalledWith(EVENT, 100, undefined);
  });

  it('stores quests, audio and the QR layout under event-scoped keys', async () => {
    vi.spyOn(questsApi, 'list').mockResolvedValue([{ id: 'q1' }] as never);
    vi.spyOn(audioApi, 'list').mockResolvedValue([{ id: 'a1' }] as never);
    vi.spyOn(eventsApi, 'getQRConfig').mockResolvedValue({ canvasSize: 'A3' } as never);

    await syncFromBackend(context(), EVENT);

    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.QUESTS(EVENT))!)).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.AUDIO(EVENT))!)).toHaveLength(1);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.QR_CANVAS(EVENT))!)).toMatchObject({
      canvasSize: 'A3',
    });
  });

  it('writes nothing for a QR layout the album does not have', async () => {
    vi.spyOn(eventsApi, 'getQRConfig').mockResolvedValue(null as never);

    await syncFromBackend(context(), EVENT);

    expect(localStorage.getItem(STORAGE_KEYS.QR_CANVAS(EVENT))).toBeNull();
  });

  it('serves the local cache when a later step fails', async () => {
    // The photos already landed; a quests failure must not discard them.
    vi.spyOn(photosApi, 'list').mockResolvedValue([photo('server-1')]);
    vi.spyOn(questsApi, 'list').mockRejectedValue(new Error('boom'));

    await expect(syncFromBackend(context(), EVENT)).resolves.toBeUndefined();

    expect(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT))).not.toBeNull();
  });
});

describe('demo fixtures', () => {
  /**
   * `initializeDefaults` fires the seed and does not await it, so "nothing was
   * seeded" needs the seeding to have had a real chance to run — otherwise the
   * assertion just wins a race and passes whether the guard exists or not.
   * Pre-loading the fixture module puts it in the registry, which makes the
   * dynamic import inside resolve as a microtask; two macrotask boundaries are
   * then enough for the writes to have landed if they were going to.
   */
  beforeEach(async () => {
    await import('../../src/services/mockData');
  });

  const flushSeeding = async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

  function setSearch(search: string) {
    const url = new URL(`http://localhost/${search}`);
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, search: url.search, href: url.href },
    });
  }

  afterEach(() => setSearch(''));

  it('seeds nothing on a plain visit', async () => {
    // The regression: every first-time visitor to the bare domain was browsing
    // a fictional wedding, with fake guests indistinguishable from real data.
    setSearch('');
    const ctx = context();

    initializeDefaults(ctx);
    await flushSeeding();

    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_EVENT_ID)).toBeNull();
    expect(localStorage.length).toBe(0);
    expect(ctx.notify).not.toHaveBeenCalled();
  });

  it('seeds the sample wedding when the demo is explicitly asked for', async () => {
    setSearch('?demo=1');
    const ctx = context();

    initializeDefaults(ctx);

    await vi.waitFor(() =>
      expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_EVENT_ID)).not.toBeNull()
    );
    await vi.waitFor(() => expect(ctx.notify).toHaveBeenCalled());
  });

  it('leaves real data alone when the demo flag is present', async () => {
    // Someone appending ?demo=1 to a live album's URL must not have their own
    // photos overwritten by fixtures.
    setSearch('?demo=1');
    localStorage.setItem(STORAGE_KEYS.ACTIVE_EVENT_ID, 'real-event');
    const ctx = context();

    initializeDefaults(ctx);
    await vi.waitFor(() => expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_EVENT_ID)).toBe('real-event'));
  });
});

describe('resetToDefaults', () => {
  it('clears the album but keeps the host signed in', async () => {
    // Losing the session on a reset would log a host out of their own
    // dashboard for clearing local state.
    localStorage.setItem('wedmoments_host_user', '{"id":"u1"}');
    localStorage.setItem('wedmoments_host_token', 'jwt-abc');
    localStorage.setItem(STORAGE_KEYS.PHOTOS(EVENT), '[{"id":"p1"}]');

    resetToDefaults(context());

    expect(localStorage.getItem('wedmoments_host_user')).toBe('{"id":"u1"}');
    expect(localStorage.getItem('wedmoments_host_token')).toBe('jwt-abc');
    expect(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT))).toBeNull();
  });

  it('keeps the device id, so the guest is still the same guest', async () => {
    // The fingerprint is what attributes a guest's existing photos and their
    // per-device upload budget to them. A new one is a new person.
    localStorage.setItem(STORAGE_KEYS.DEVICE_ID, 'device-7');

    resetToDefaults(context());

    expect(localStorage.getItem(STORAGE_KEYS.DEVICE_ID)).toBe('device-7');
  });

  it('notifies subscribers so the view re-renders', async () => {
    const ctx = context();

    resetToDefaults(ctx);

    expect(ctx.notify).toHaveBeenCalled();
  });
});
