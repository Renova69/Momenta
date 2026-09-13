import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import React from 'react';
import { LiveProjectorScreen } from '../../src/components/projector/LiveProjectorScreen';
import { storageService } from '../../src/services/storageService';
import { WeddingEvent, Photo } from '../../src/types';

/**
 * Two things the projector wall has to get right over hours, not seconds.
 *
 * `liveProjectorScreen.spec.tsx` covers what the wall shows and how it
 * advances. This covers what happens to it while it is left running: the
 * reaction subscription must not survive an unmount, and the Ken Burns pan
 * must not run for someone who has asked their display for reduced motion.
 */

const EVENT = {
  id: 'e1',
  slug: 'monika-and-alexander-2026',
  title: 'Monika & Alexander',
} as unknown as WeddingEvent;

function photo(over: Partial<Photo> = {}): Photo {
  return {
    id: 'p1',
    eventId: 'e1',
    guestId: 'g1',
    guestName: 'Silvia',
    storagePath: '/uploads/x.jpg',
    thumbnailUrl: 'https://cdn.example/x-thumb.jpg',
    fullUrl: 'https://cdn.example/x.jpg',
    status: 'approved',
    filterApplied: 'original',
    likesCount: 0,
    commentsCount: 0,
    likedByGuestIds: [],
    comments: [],
    createdAt: new Date().toISOString(),
    ...over,
  } as Photo;
}

function renderWall(photos: Photo[]) {
  return render(<LiveProjectorScreen event={EVENT} photos={photos} onClose={vi.fn()} />);
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('reaction subscription lifecycle', () => {
  it('unsubscribes on unmount', () => {
    // The wall is mounted and unmounted as the host moves between views, and
    // it runs for the length of a reception. A subscription left behind per
    // mount is a leak that only shows up hours in.
    const unsubscribe = vi.fn();
    vi.spyOn(storageService, 'subscribeReactions').mockReturnValue(unsubscribe);

    const { unmount } = renderWall([photo()]);
    expect(storageService.subscribeReactions).toHaveBeenCalledTimes(1);

    unmount();

    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

describe('reduced motion', () => {
  function stubMatchMedia(matches: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn().mockReturnValue({
        matches,
        media: '(prefers-reduced-motion: reduce)',
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })
    );
  }

  it('drops the Ken Burns pan when the display asks for reduced motion', () => {
    // A slow pan is atmosphere on a wall; for someone who has asked not to be
    // shown motion it is the opposite, and this screen is unavoidable — it is
    // the television in the room.
    stubMatchMedia(true);

    const { container } = renderWall([photo()]);

    expect(container.innerHTML).not.toContain('animate-ken-burns');
  });

  it('uses the pan when motion is welcome', () => {
    stubMatchMedia(false);

    const { container } = renderWall([photo()]);

    expect(container.innerHTML).toContain('animate-ken-burns');
  });

  it('falls back to motion when the browser has no matchMedia at all', () => {
    vi.stubGlobal('matchMedia', undefined);

    const { container } = renderWall([photo()]);

    // No preference expressed is not the same as a preference against.
    expect(container.innerHTML).toContain('animate-ken-burns');
  });
});

describe('sort robustness', () => {
  it('treats a missing priority as zero rather than NaN', () => {
    // A photo row written before the priority column existed would otherwise
    // sort unpredictably and could displace the photographer's frames.
    const { container } = renderWall([
      photo({ id: 'nopri', priority: undefined, guestName: 'No Priority' }),
      photo({ id: 'pro', priority: 10, guestName: 'Official Photographer' }),
    ]);

    expect(container.textContent).toContain('Official Photographer');
  });
});
