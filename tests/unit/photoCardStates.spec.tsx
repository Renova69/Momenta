import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';
import { PhotoCard } from '../../src/components/gallery/PhotoCard';
import { Guest, Photo } from '../../src/types';
import { i18n } from '../../src/i18n';

/**
 * The states a feed card can be in.
 *
 * `photoCardPreviewFallback.spec.tsx` covers the shed-preview case (H1) and
 * `feedComponents.spec.tsx` the reaction call. What was left uncovered is most
 * of what the card actually draws — and one of those states is a privacy
 * control rather than decoration: a disposable-mode album is locked until the
 * couple's reveal moment, and this overlay is what stands between a guest and
 * a photo they are not meant to see yet. The server strips the URLs from the
 * broadcast as well, so this is the second of two independent guards, which is
 * exactly the kind that rots unnoticed because removing it breaks nothing
 * visible in the common case.
 */

const EVENT_ID = 'ab12cd34-5678-49ab-8cde-f01234567890';

const GUEST: Guest = {
  id: 'guest-1',
  eventId: EVENT_ID,
  name: 'Silvia',
  createdAt: '2026-01-10T12:00:00.000Z',
};

const ANONYMOUS: Guest = { ...GUEST, id: 'anonymous', name: 'Anonymous' };

function photo(over: Partial<Photo> = {}): Photo {
  return {
    id: 'photo-1',
    eventId: EVENT_ID,
    guestId: 'guest-1',
    guestName: 'Silvia',
    storagePath: `events/${EVENT_ID}/photo-1.jpg`,
    thumbnailUrl: 'https://cdn.example.com/thumb.jpg',
    fullUrl: 'https://cdn.example.com/full.jpg',
    status: 'approved',
    filterApplied: 'original',
    likesCount: 0,
    commentsCount: 0,
    createdAt: '2026-01-10T12:00:00.000Z',
    ...over,
  } as Photo;
}

function renderCard(over: Partial<Photo> = {}, guest: Guest | null = GUEST) {
  const onLike = vi.fn();
  const onReact = vi.fn();
  const onOpenComments = vi.fn();
  const onOpenLightbox = vi.fn();
  const utils = render(
    <PhotoCard
      photo={photo(over)}
      currentGuest={guest as Guest}
      onLike={onLike}
      onReact={onReact}
      onOpenComments={onOpenComments}
      onOpenLightbox={onOpenLightbox}
    />
  );
  return { ...utils, onLike, onReact, onOpenComments, onOpenLightbox };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a photo locked until the reveal', () => {
  it('covers it, rather than showing the picture early', () => {
    const { container } = renderCard({ isLocked: true });

    expect(screen.getByText(i18n.t('feed.disposable_title'))).toBeInTheDocument();
    // The overlay is opaque and sits over the whole tile.
    expect(container.querySelector('.absolute.inset-0')).toBeTruthy();
  });

  it('shows the photo once it is not locked', () => {
    renderCard({ isLocked: false });

    expect(screen.queryByText(i18n.t('feed.disposable_title'))).not.toBeInTheDocument();
  });
});

describe('who took it', () => {
  it('marks a photographer frame so guests can tell it apart', () => {
    renderCard({ source: 'photographer' });

    expect(screen.getByText(/Official Photographer/i)).toBeInTheDocument();
  });

  it('does not mark an ordinary guest photo', () => {
    renderCard({ source: 'guest' });

    expect(screen.queryByText(/Official Photographer/i)).not.toBeInTheDocument();
  });

  it('shows the guest’s avatar when they have one', () => {
    const { container } = renderCard({ guestAvatar: 'https://cdn.example.com/ana.jpg' });

    const avatar = container.querySelector('img[src="https://cdn.example.com/ana.jpg"]');
    expect(avatar).toBeTruthy();
    expect(avatar!.getAttribute('alt')).toBe('Silvia');
  });

  it('falls back to something drawable when they have none', () => {
    // A missing avatar must not render an <img> with no src, which is the
    // browser's broken-image icon next to a real person's name.
    const { container } = renderCard({ guestAvatar: undefined });

    expect(container.querySelector('img[src=""]')).toBeNull();
  });

  it('shows the table number when the guest gave one', () => {
    renderCard({ guestTable: 'Table 4' });

    expect(screen.getByText(/Table 4/)).toBeInTheDocument();
  });
});

describe('what was written on it', () => {
  it('shows a caption', () => {
    renderCard({ caption: 'First dance' });

    expect(screen.getByText(/First dance/)).toBeInTheDocument();
  });

  it('renders nothing for a photo with no caption', () => {
    const { container } = renderCard({ caption: undefined });

    expect(container.querySelector('.italic')).toBeNull();
  });

  it('names the filter that was applied, in the reader’s language', () => {
    renderCard({ filterApplied: 'vintage_warmth' });

    expect(screen.getByText(i18n.t('filter.vintage_warmth'))).toBeInTheDocument();
  });

  it('shows the raw key for a filter it has no label for', () => {
    // Cast because `PhotoFilter` is a closed union, which is the whole reason
    // the `|| photo.filterApplied` fallback exists: `photos.filter_applied` is
    // a varchar on the server, so a value the client's union has never heard of
    // is a real thing to receive — from an older or newer deploy — and it
    // should still say something rather than render an empty badge.
    renderCard({ filterApplied: 'tilt_shift' as Photo['filterApplied'] });

    expect(screen.getByText('tilt_shift')).toBeInTheDocument();
  });

  it('says nothing for an unfiltered photo', () => {
    // 'original' is the absence of a filter, not a filter — a watermark there
    // would label every ordinary photo.
    const { container } = renderCard({ filterApplied: 'original' });

    expect(container.textContent).not.toMatch(/original/i);
  });
});

describe('liking', () => {
  it('reports the like for an identified guest', () => {
    const { container, onLike } = renderCard({ likesCount: 3 });

    const likeButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.querySelector('svg.lucide-heart')
    )!;
    fireEvent.click(likeButton);

    expect(onLike).toHaveBeenCalledWith('photo-1');
  });

  it('still reports the like for a guest who has not identified themselves', () => {
    // The anonymous path skips the confetti and the animation, because both
    // read positions off the click event — but the like itself must still
    // reach the server, or the counter silently does nothing for them.
    const { container, onLike } = renderCard({}, ANONYMOUS);

    const likeButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.querySelector('svg.lucide-heart')
    )!;
    fireEvent.click(likeButton);

    expect(onLike).toHaveBeenCalledWith('photo-1');
  });

  it('does not open the lightbox when the like button is clicked', () => {
    // The button sits on top of the tile, which opens the photo. Without
    // stopPropagation a like would also open the lightbox every time.
    const { container, onOpenLightbox } = renderCard();

    const likeButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.querySelector('svg.lucide-heart')
    )!;
    fireEvent.click(likeButton);

    expect(onOpenLightbox).not.toHaveBeenCalled();
  });

  it('shows the like count', () => {
    renderCard({ likesCount: 12 });

    expect(screen.getByText('12')).toBeInTheDocument();
  });
});
