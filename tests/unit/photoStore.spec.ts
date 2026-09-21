import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  clearPendingPreviews,
  forgetPendingPreview,
  persistPhotos,
  readPhotos,
  rememberPendingPreview,
} from '../../src/services/photoStore';
import { STORAGE_KEYS } from '../../src/services/storageKeys';
import { Photo } from '../../src/types';

/**
 * The photo a guest can see while it is still going up (H1).
 *
 * A capture starts life as an inline `data:` URL, which is far too big to keep
 * in localStorage — so the store sheds it to fit the quota and holds it in
 * memory instead, putting it back on every read. The record always survives;
 * what this protects is the picture on the guest's own screen between the
 * shutter and the server's URL arriving.
 *
 * Nothing tested this: a mutation sweep killed 6 of 10. The memory is capped
 * and the shedding is lossy, so the failure modes are a blank card and a tab
 * that grows until it is killed.
 */

const EVENT_ID = 'bbbbbbbb-1111-4222-8333-444455556666';
const DATA_URL = 'data:image/jpeg;base64,AAAA';

const photo = (over: Partial<Photo> = {}): Photo =>
  ({
    id: 'p1',
    eventId: EVENT_ID,
    fullUrl: DATA_URL,
    thumbnailUrl: DATA_URL,
    status: 'approved',
    createdAt: new Date().toISOString(),
    ...over,
  }) as Photo;

const raw = (): Photo[] => JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT_ID)) || '[]');

beforeEach(() => {
  localStorage.clear();
  clearPendingPreviews();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  clearPendingPreviews();
  vi.restoreAllMocks();
});

/**
 * Run `body` with localStorage refusing its first photo write, the way a full
 * quota does.
 *
 * The patch goes on the object and the original descriptor is put back
 * afterwards. Two things bite here: in jsdom `setItem` is an own property of
 * localStorage, not `Storage.prototype.setItem`, so a prototype spy never
 * fires and the test passes for the wrong reason; and `delete`-ing it to
 * restore leaves localStorage with no `setItem` at all for every test after.
 */
function withFirstWriteRefused(body: () => void): number {
  let writes = 0;
  const original = Object.getOwnPropertyDescriptor(localStorage, 'setItem');
  const realSetItem = localStorage.setItem.bind(localStorage);
  Object.defineProperty(localStorage, 'setItem', {
    configurable: true,
    writable: true,
    value: (key: string, value: string) => {
      if (key.includes('photos') && writes++ === 0) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      return realSetItem(key, value);
    },
  });

  try {
    body();
  } finally {
    if (original) Object.defineProperty(localStorage, 'setItem', original);
  }
  return writes;
}

describe('a preview held in memory', () => {
  it('is put back on read when storage no longer has it', () => {
    persistPhotos(EVENT_ID, [photo({ fullUrl: '', thumbnailUrl: '' })]);
    rememberPendingPreview('p1', { fullUrl: DATA_URL, thumbnailUrl: DATA_URL });

    expect(readPhotos(EVENT_ID)[0].fullUrl).toBe(DATA_URL);
  });

  it('never overwrites a real URL the server has since given', () => {
    // The preview is a stand-in. Once the upload lands, the stored URL is the
    // truth, and putting the stale capture back would show the wrong image.
    persistPhotos(EVENT_ID, [photo({ fullUrl: 'https://cdn.example/p1.jpg', thumbnailUrl: 'https://cdn.example/t.jpg' })]);
    rememberPendingPreview('p1', { fullUrl: DATA_URL, thumbnailUrl: DATA_URL });

    const [read] = readPhotos(EVENT_ID);
    expect(read.fullUrl).toBe('https://cdn.example/p1.jpg');
    expect(read.thumbnailUrl).toBe('https://cdn.example/t.jpg');
  });

  it('is released once it is no longer needed', () => {
    persistPhotos(EVENT_ID, [photo({ fullUrl: '', thumbnailUrl: '' })]);
    rememberPendingPreview('p1', { fullUrl: DATA_URL, thumbnailUrl: DATA_URL });
    forgetPendingPreview('p1');

    expect(readPhotos(EVENT_ID)[0].fullUrl).toBe('');
  });

  it('holds no more than thirty at once', () => {
    // Each one is a full-resolution base64 string. Unbounded, a bulk capture
    // on a phone grows the tab until the browser kills it; the oldest is the
    // one the guest is least likely to still be looking at.
    const ids = Array.from({ length: 31 }, (_, i) => `p${i}`);
    persistPhotos(EVENT_ID, ids.map((id) => photo({ id, fullUrl: '', thumbnailUrl: '' })));
    for (const id of ids) rememberPendingPreview(id, { fullUrl: DATA_URL, thumbnailUrl: DATA_URL });

    const read = readPhotos(EVENT_ID);
    expect(read.find((p) => p.id === 'p0')?.fullUrl).toBe('');
    expect(read.find((p) => p.id === 'p30')?.fullUrl).toBe(DATA_URL);
    expect(read.filter((p) => p.fullUrl === DATA_URL)).toHaveLength(30);
  });

  it('ignores a capture with no id to hold it under', () => {
    rememberPendingPreview('', { fullUrl: DATA_URL, thumbnailUrl: DATA_URL });
    persistPhotos(EVENT_ID, [photo({ id: '', fullUrl: '', thumbnailUrl: '' })]);

    expect(readPhotos(EVENT_ID)[0].fullUrl).toBe('');
  });
});

describe('reading a list that is not one', () => {
  it('returns nothing rather than throwing when storage holds an object', () => {
    // localStorage is shared with other tabs, other versions and anything
    // else on the origin. A read that throws here takes the feed down.
    localStorage.setItem(STORAGE_KEYS.PHOTOS(EVENT_ID), JSON.stringify({ not: 'a list' }));
    rememberPendingPreview('p1', { fullUrl: DATA_URL, thumbnailUrl: DATA_URL });

    expect(readPhotos(EVENT_ID)).toEqual({ not: 'a list' });
  });

  it('returns nothing for unparseable storage', () => {
    localStorage.setItem(STORAGE_KEYS.PHOTOS(EVENT_ID), '{not json');

    expect(readPhotos(EVENT_ID)).toEqual([]);
  });
});

describe('shedding previews to fit the quota', () => {
  it('drops the oldest inline capture first and keeps every record', () => {
    // The list is newest-first, so the end is the oldest. The row must
    // survive the shedding — that is the whole point of it.
    const many = Array.from({ length: 3 }, (_, i) => photo({ id: `p${i}` }));

    const writes = withFirstWriteRefused(() => persistPhotos(EVENT_ID, many));

    // One write refused, one accepted: the retry is what carries the shedding.
    expect(writes).toBe(2);
    expect(raw()).toHaveLength(3);
    expect(raw()[2].fullUrl).toBe('');
    expect(raw()[0].fullUrl).toBe(DATA_URL);
  });

  it('sheds a photo whose thumbnail is still inline though its full image is not', () => {
    // Half-reconciled rows are the normal state during an upload. Skipping
    // them leaves the largest strings in storage untouched, and the quota
    // retry then gives up whole photo records instead.
    withFirstWriteRefused(() =>
      persistPhotos(EVENT_ID, [photo({ id: 'half', fullUrl: 'https://cdn.example/p.jpg', thumbnailUrl: DATA_URL })])
    );

    expect(raw()).toHaveLength(1);
    expect(raw()[0].thumbnailUrl).toBe('');
    expect(raw()[0].fullUrl).toBe('https://cdn.example/p.jpg');
  });
});
