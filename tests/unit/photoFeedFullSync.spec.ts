import { describe, it, expect, beforeEach, vi } from 'vitest';
import { storageService } from '../../src/services/storageService';
import { photosApi } from '../../src/api/photosApi';
import { questsApi } from '../../src/api/questsApi';
import { audioApi } from '../../src/api/audioApi';
import { eventsApi } from '../../src/api/eventsApi';
import { Photo } from '../../src/types';

/**
 * H3 — an album larger than one page must sync in full.
 *
 * GET /api/photos is keyset-paginated on a composite `priority:isoTimestamp`
 * cursor, and photosApi.list already accepts one. syncFromBackend asked for
 * exactly 100 rows and never followed the cursor, so a wedding with 400
 * photos showed 100 of them — permanently. LiveFeed's "load more" only pages
 * through what is already cached locally, so nothing else recovered the rest.
 */

const EVENT_ID = 'c0ffee00-1111-4222-8333-444455556666';
const PAGE_SIZE = 100;

function page(startIndex: number, count: number): Photo[] {
  return Array.from({ length: count }, (_, i) => {
    const n = startIndex + i;
    return {
      id: `photo-${String(n).padStart(4, '0')}`,
      eventId: EVENT_ID,
      guestId: 'guest-1',
      guestName: 'Guest',
      storagePath: `events/${EVENT_ID}/${n}.jpg`,
      thumbnailUrl: `https://cdn.example.com/${n}-thumb.jpg`,
      fullUrl: `https://cdn.example.com/${n}.jpg`,
      status: 'approved',
      filterApplied: 'original',
      likesCount: 0,
      commentsCount: 0,
      priority: 0,
      // Strictly descending, matching the server's ORDER BY.
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0) - n * 1000).toISOString(),
    } as Photo;
  });
}

describe('full-album sync across pages (H3)', () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    storageService.updateEvent({ id: EVENT_ID, slug: 'full-sync' }, false);

    vi.spyOn(questsApi, 'list').mockResolvedValue([]);
    vi.spyOn(audioApi, 'list').mockResolvedValue([]);
    vi.spyOn(eventsApi, 'getQRConfig').mockResolvedValue(null as never);
  });

  it('follows the cursor until the server returns a short page', async () => {
    const listSpy = vi
      .spyOn(photosApi, 'list')
      .mockResolvedValueOnce(page(0, PAGE_SIZE))
      .mockResolvedValueOnce(page(PAGE_SIZE, PAGE_SIZE))
      .mockResolvedValueOnce(page(PAGE_SIZE * 2, 40));

    await storageService.syncFromBackend(EVENT_ID);

    expect(listSpy).toHaveBeenCalledTimes(3);
    expect(storageService.getPhotos(EVENT_ID)).toHaveLength(240);

    // Page 1 asks for no cursor; every later page carries the previous page's
    // last row as "priority:isoTimestamp".
    expect(listSpy.mock.calls[0][2]).toBeUndefined();
    const secondCursor = listSpy.mock.calls[1][2];
    expect(secondCursor).toMatch(/^-?\d+:.+$/);
    expect(secondCursor).toBe(`0:${page(PAGE_SIZE - 1, 1)[0].createdAt}`);
  });

  it('stops after one request when the album fits in a single page', async () => {
    const listSpy = vi.spyOn(photosApi, 'list').mockResolvedValueOnce(page(0, 12));

    await storageService.syncFromBackend(EVENT_ID);

    expect(listSpy).toHaveBeenCalledTimes(1);
    expect(storageService.getPhotos(EVENT_ID)).toHaveLength(12);
  });

  it('does not duplicate a row that appears on two pages', async () => {
    // A row exactly on a page boundary can repeat when two photos share a
    // priority and a millisecond. Dedupe by id rather than trusting the cursor.
    vi.spyOn(photosApi, 'list')
      .mockResolvedValueOnce(page(0, PAGE_SIZE))
      .mockResolvedValueOnce([...page(PAGE_SIZE - 1, 1), ...page(PAGE_SIZE, 20)]);

    await storageService.syncFromBackend(EVENT_ID);

    const ids = storageService.getPhotos(EVENT_ID).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(120);
  });

  it('keeps what it already fetched when a later page fails', async () => {
    vi.spyOn(photosApi, 'list')
      .mockResolvedValueOnce(page(0, PAGE_SIZE))
      .mockRejectedValueOnce(new Error('network died mid-album'));

    await storageService.syncFromBackend(EVENT_ID);

    expect(storageService.getPhotos(EVENT_ID)).toHaveLength(PAGE_SIZE);
  });
});
