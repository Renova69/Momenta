import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { persistPhotos, readPhotos, rememberPendingPreview, clearPendingPreviews } from '../../src/services/photoStore';
import { STORAGE_KEYS } from '../../src/services/storageKeys';
import { installQuotaLimitedStorage, fakeDataUrl } from '../helpers/quotaStorage';
import { Photo } from '../../src/types';

/**
 * H1 — a captured photo must never disappear from the feed because
 * localStorage ran out of room.
 *
 * `fullUrl` on a freshly captured photo is a base64 `data:` URL of the
 * compressed 1600px copy — 300KB-1MB each. The origin's whole localStorage
 * quota is ~5MB, so a bulk capture blows through it. The old code caught the
 * quota error, and if the list happened to be under 50 entries it gave up and
 * wrote nothing at all. `notify()` then re-read from localStorage, so the
 * photo the guest had just taken vanished from their feed — while the upload
 * itself was succeeding in the background.
 *
 * The record is the thing that must survive. The inline preview is the thing
 * that can be shed: oldest first, and only as far as the quota actually
 * demands.
 */

const EVENT_ID = 'ab12cd34-5678-49ab-8cde-f01234567890';

function photo(id: string, preview: string, createdAt: string): Photo {
  return {
    id,
    eventId: EVENT_ID,
    guestId: 'guest-1',
    guestName: 'Guest',
    storagePath: `events/${EVENT_ID}/${id}.jpg`,
    thumbnailUrl: preview,
    fullUrl: preview,
    status: 'approved',
    filterApplied: 'original',
    likesCount: 0,
    commentsCount: 0,
    createdAt,
  };
}

describe('quota-safe photo persistence (H1)', () => {
  let restoreStorage: (() => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    clearPendingPreviews();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    restoreStorage?.();
    restoreStorage = null;
    clearPendingPreviews();
  });

  it('keeps every photo record when the previews do not fit', () => {
    // Six ~400KB previews against a 1MB ceiling: most previews cannot be kept.
    restoreStorage = installQuotaLimitedStorage(1024 * 1024);

    const list: Photo[] = [];
    for (let i = 0; i < 6; i++) {
      list.push(photo(`photo-${i}`, fakeDataUrl(400), new Date(Date.UTC(2026, 0, 10 - i)).toISOString()));
    }

    persistPhotos(EVENT_ID, list);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT_ID)) || '[]') as Photo[];
    expect(stored).toHaveLength(6);
    expect(stored.map((p) => p.id)).toEqual(list.map((p) => p.id));
  });

  it('sheds the oldest inline preview first, keeping the newest capture visible', () => {
    restoreStorage = installQuotaLimitedStorage(1024 * 1024);

    const list: Photo[] = [
      photo('photo-newest', fakeDataUrl(400), '2026-01-10T12:00:00.000Z'),
      photo('photo-middle', fakeDataUrl(400), '2026-01-10T11:00:00.000Z'),
      photo('photo-oldest', fakeDataUrl(400), '2026-01-10T10:00:00.000Z'),
    ];

    persistPhotos(EVENT_ID, list);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT_ID)) || '[]') as Photo[];
    expect(stored).toHaveLength(3);
    expect(stored[0].fullUrl.startsWith('data:')).toBe(true);
    expect(stored[2].fullUrl.startsWith('data:')).toBe(false);
  });

  it('never writes a photo whose record was silently dropped (the old bug)', () => {
    // Under 50 entries, the old saveWithRetry gave up entirely and wrote
    // nothing, so the just-captured photo was absent from the next read.
    restoreStorage = installQuotaLimitedStorage(200 * 1024);

    const list = [photo('photo-just-captured', fakeDataUrl(500), '2026-01-10T12:00:00.000Z')];
    persistPhotos(EVENT_ID, list);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT_ID)) || '[]') as Photo[];
    expect(stored.map((p) => p.id)).toContain('photo-just-captured');
  });

  it('restores a shed preview from memory for the rest of the session', () => {
    restoreStorage = installQuotaLimitedStorage(200 * 1024);

    const preview = fakeDataUrl(500);
    rememberPendingPreview('photo-just-captured', { fullUrl: preview, thumbnailUrl: preview });
    persistPhotos(EVENT_ID, [photo('photo-just-captured', preview, '2026-01-10T12:00:00.000Z')]);

    const [readBack] = readPhotos(EVENT_ID);
    expect(readBack.id).toBe('photo-just-captured');
    expect(readBack.fullUrl).toBe(preview);
  });

  it('leaves already-uploaded remote URLs untouched', () => {
    restoreStorage = installQuotaLimitedStorage(1024 * 1024);

    const remote = 'https://cdn.example.com/events/x/photo.jpg';
    persistPhotos(EVENT_ID, [
      photo('server-uuid', remote, '2026-01-10T12:00:00.000Z'),
      photo('photo-local', fakeDataUrl(900), '2026-01-10T11:00:00.000Z'),
    ]);

    const stored = JSON.parse(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT_ID)) || '[]') as Photo[];
    expect(stored.find((p) => p.id === 'server-uuid')?.fullUrl).toBe(remote);
  });
});
