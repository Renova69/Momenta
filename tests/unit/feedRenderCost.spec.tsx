import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { LiveFeed } from '../../src/components/gallery/LiveFeed';
import { Guest, Photo } from '../../src/types';

vi.mock('../../src/utils/date', async () => {
  const actual = await vi.importActual<typeof import('../../src/utils/date')>('../../src/utils/date');
  return { ...actual, formatTimeAgo: vi.fn(actual.formatTimeAgo) };
});

import { formatTimeAgo } from '../../src/utils/date';

/**
 * M3 — how much of the tree a single realtime message repaints.
 *
 * Every `storageService.notify()` pushes a freshly-parsed `photos` array into
 * AppContext, so the whole tree re-renders on every incoming WebSocket
 * message — a like, a comment, a reaction, someone else's upload. A feed page
 * renders up to 20 PhotoCards, so one like used to repaint all twenty.
 *
 * `applyRealtimeMessage` only ever replaces the object for the photo that
 * actually changed; the rest keep their identity. That makes the fix
 * available but not automatic, because it only works while the callback props
 * are stable too — LiveFeed used to pass `onLike={() => onLike(photo.id)}`, a
 * new function identity per render, which defeats memo comparison on every
 * card regardless of whether its photo changed.
 *
 * `formatTimeAgo` runs once per PhotoCard render, so counting its calls is a
 * direct measure of how many cards actually rendered.
 */

const EVENT_ID = 'aa11bb22-3344-4c55-8d66-77ee88ff9900';

const GUEST: Guest = {
  id: 'guest-1',
  eventId: EVENT_ID,
  name: 'Guest',
  createdAt: '2026-01-10T12:00:00.000Z',
};

function photo(n: number): Photo {
  return {
    id: `photo-${n}`,
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
    likedByGuestIds: [],
    createdAt: new Date(Date.UTC(2026, 0, 10, 12, 0, n)).toISOString(),
  };
}

const noop = () => {};

function renderFeed(photos: Photo[]) {
  return render(
    <LiveFeed
      photos={photos}
      currentGuest={GUEST}
      onLike={noop}
      onReact={noop}
      onOpenComments={noop}
      onOpenLightbox={noop}
      onOpenCapture={noop}
    />
  );
}

describe('feed render cost (M3)', () => {
  beforeEach(() => {
    vi.mocked(formatTimeAgo).mockClear();
  });

  it('repaints only the card whose photo actually changed', () => {
    const photos = Array.from({ length: 10 }, (_, i) => photo(i));
    const { rerender } = renderFeed(photos);

    expect(vi.mocked(formatTimeAgo)).toHaveBeenCalledTimes(10);
    vi.mocked(formatTimeAgo).mockClear();

    // Exactly what applyRealtimeMessage does for an incoming PHOTO_LIKED: a new
    // array, one replaced object, nine identities preserved.
    const updated = photos.map((p) =>
      p.id === 'photo-4' ? { ...p, likesCount: 1, likedByGuestIds: ['guest-2'] } : p
    );

    rerender(
      <LiveFeed
        photos={updated}
        currentGuest={GUEST}
        onLike={noop}
        onReact={noop}
        onOpenComments={noop}
        onOpenLightbox={noop}
        onOpenCapture={noop}
      />
    );

    expect(vi.mocked(formatTimeAgo)).toHaveBeenCalledTimes(1);
  });

  it('repaints nothing when a re-render changes no photo at all', () => {
    // The common case: a message arrives for a photo that is not on this page,
    // or the array is simply re-parsed with identical contents.
    const photos = Array.from({ length: 6 }, (_, i) => photo(i));
    const { rerender } = renderFeed(photos);
    vi.mocked(formatTimeAgo).mockClear();

    rerender(
      <LiveFeed
        photos={[...photos]}
        currentGuest={GUEST}
        onLike={noop}
        onReact={noop}
        onOpenComments={noop}
        onOpenLightbox={noop}
        onOpenCapture={noop}
      />
    );

    expect(vi.mocked(formatTimeAgo)).not.toHaveBeenCalled();
  });

  it('still repaints every card when the handler identities change', () => {
    // The failure mode this guards: fresh arrow props per render make the memo
    // comparison fail on every card, whatever the photos did.
    const photos = Array.from({ length: 5 }, (_, i) => photo(i));
    const { rerender } = renderFeed(photos);
    vi.mocked(formatTimeAgo).mockClear();

    rerender(
      <LiveFeed
        photos={photos}
        currentGuest={GUEST}
        onLike={() => undefined}
        onReact={() => undefined}
        onOpenComments={() => undefined}
        onOpenLightbox={() => undefined}
        onOpenCapture={() => undefined}
      />
    );

    expect(vi.mocked(formatTimeAgo)).toHaveBeenCalledTimes(5);
  });
});
