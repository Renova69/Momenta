import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';
import { CLOSED_ALBUM_REFRESH_MS, useClosedAlbumRefresh } from '../../src/hooks/useClosedAlbumRefresh';
import { PhotoCard } from '../../src/components/gallery/PhotoCard';
import { i18n } from '../../src/i18n';
import { Guest, Photo } from '../../src/types';

/**
 * N-183 — the rest of what a guest met on a closed album. The like and
 * reaction buttons did nothing and said nothing; and a purchase that reopened
 * the album reached no page already open, which kept the closed notice until
 * a reload.
 */

function Probe({ closedAt, refresh }: { closedAt: string | null; refresh: () => void }) {
  useClosedAlbumRefresh(closedAt, refresh);
  return null;
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('a closed album page', () => {
  it('re-reads the album every minute while it is closed, and not once it opens', () => {
    vi.useFakeTimers();
    const refresh = vi.fn();
    const { rerender } = render(<Probe closedAt="2026-10-01T00:00:00.000Z" refresh={refresh} />);

    vi.advanceTimersByTime(CLOSED_ALBUM_REFRESH_MS);
    expect(refresh).toHaveBeenCalledTimes(1);

    rerender(<Probe closedAt={null} refresh={refresh} />);
    vi.advanceTimersByTime(CLOSED_ALBUM_REFRESH_MS * 3);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('re-reads it when the page comes back into view', () => {
    const refresh = vi.fn();
    render(<Probe closedAt="2026-10-01T00:00:00.000Z" refresh={refresh} />);

    document.dispatchEvent(new Event('visibilitychange'));

    expect(refresh).toHaveBeenCalled();
  });

  it("disables a photo's like and reaction buttons and says why", () => {
    const guest = { id: 'g1', eventId: 'e1', name: 'Ana', createdAt: '' } as Guest;
    const photo = {
      id: 'p1', eventId: 'e1', guestId: 'g2', guestName: 'Ivo', storagePath: '', thumbnailUrl: 'https://x/t.jpg',
      fullUrl: 'https://x/f.jpg', status: 'approved', filterApplied: 'original', likesCount: 2, commentsCount: 0,
      createdAt: '2026-10-01T00:00:00.000Z',
    } as Photo;
    render(
      <PhotoCard photo={photo} currentGuest={guest} onLike={vi.fn()} onReact={vi.fn()} onOpenComments={vi.fn()} onOpenLightbox={vi.fn()} isClosed />
    );

    const like = screen.getByRole('button', { name: i18n.t('feed.like_photo', { n: 2 }) });
    expect(like).toBeDisabled();
    expect(like.title).toBe(i18n.t('error.album_closed'));
    expect(screen.getByRole('button', { name: i18n.t('reaction.heart') })).toBeDisabled();
  });
});
