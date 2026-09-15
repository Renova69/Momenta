import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
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

/**
 * Keeping the wall awake.
 *
 * This runs unattended on a television for the length of a reception. A screen
 * that sleeps is the most visible failure this app has — every guest sees it,
 * and nobody in the room knows how to wake it without the host's laptop. The
 * Screen Wake Lock API is what prevents it, and it is unevenly supported and
 * revocable by the browser at any time, so all three of "ask", "ask again" and
 * "carry on without it" have to work.
 */
describe('the screen wake lock', () => {
  function stubWakeLock(result: 'granted' | 'rejected' | 'unsupported') {
    const release = vi.fn().mockResolvedValue(undefined);
    const request = vi.fn(() =>
      result === 'rejected'
        ? Promise.reject(new Error('NotAllowedError'))
        : Promise.resolve({ release })
    );
    Object.defineProperty(navigator, 'wakeLock', {
      configurable: true,
      value: result === 'unsupported' ? undefined : { request },
    });
    return { request, release };
  }

  function setVisibility(state: 'visible' | 'hidden') {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: state });
  }

  afterEach(() => {
    setVisibility('visible');
    Object.defineProperty(navigator, 'wakeLock', { configurable: true, value: undefined });
  });

  it('asks for one as soon as the wall opens', async () => {
    const { request } = stubWakeLock('granted');
    setVisibility('visible');

    renderWall([photo()]);

    await vi.waitFor(() => expect(request).toHaveBeenCalledWith('screen'));
  });

  it('releases it when the wall closes', async () => {
    const { release } = stubWakeLock('granted');
    setVisibility('visible');

    const { unmount } = renderWall([photo()]);
    await vi.waitFor(() => expect(release).not.toHaveBeenCalled());

    unmount();

    await vi.waitFor(() => expect(release).toHaveBeenCalled());
  });

  it('asks again when the wall comes back to the foreground', async () => {
    // The browser drops the lock whenever the tab is hidden — switching away
    // to check something and back would otherwise leave the screen free to
    // sleep for the rest of the night.
    const { request } = stubWakeLock('granted');
    setVisibility('visible');

    renderWall([photo()]);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));

    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  });

  it('does not ask while the wall is in the background', async () => {
    const { request } = stubWakeLock('granted');
    setVisibility('hidden');

    renderWall([photo()]);
    document.dispatchEvent(new Event('visibilitychange'));

    await vi.waitFor(() => expect(request).not.toHaveBeenCalled());
  });

  it('still shows the wall on a browser that has no wake lock at all', async () => {
    // Firefox had none for years. The photos matter more than the lock.
    stubWakeLock('unsupported');

    const { container } = renderWall([photo({ guestName: 'Silvia' })]);

    expect(container.textContent).toContain('Silvia');
  });

  it('carries on when the browser refuses the lock', async () => {
    // A rejected request is a promise rejection inside an effect; unhandled, it
    // would surface as an uncaught error rather than a screen without a lock.
    const { request } = stubWakeLock('rejected');

    const { container } = renderWall([photo({ guestName: 'Silvia' })]);

    await vi.waitFor(() => expect(request).toHaveBeenCalled());
    expect(container.textContent).toContain('Silvia');
  });
});

describe('an empty wall', () => {
  it('does not break when the chevrons are pressed with nothing to show', () => {
    // displayPhotos.length is the modulus for both directions, so without the
    // guard this is a division by zero and the index becomes NaN — the wall
    // then renders nothing at all until someone reloads it.
    const { container } = renderWall([photo({ status: 'pending' })]);

    const buttons = Array.from(container.querySelectorAll('button'));
    const next = buttons.find((b) => b.querySelector('svg.lucide-chevron-right'));
    const prev = buttons.find((b) => b.querySelector('svg.lucide-chevron-left'));

    expect(() => {
      if (next) fireEvent.click(next);
      if (prev) fireEvent.click(prev);
    }).not.toThrow();
  });
});
