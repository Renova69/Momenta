import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLightboxPhoto } from '../../src/hooks/useLightboxPhoto';
import { Photo } from '../../src/types';

/**
 * N-113 — the lightbox kept a copy of the photo taken when it opened.
 *
 * A like, a reaction or a comment made inside it reached the server and the
 * feed, but never the open dialog: a posted comment appeared only after the
 * dialog was closed and opened again, which is how a guest ends up posting the
 * same wish twice. The open photo is now looked up in the live list.
 */

const photo = (over: Partial<Photo> = {}): Photo =>
  ({ id: 'p1', eventId: 'e1', guestId: 'g1', guestName: 'Ana', fullUrl: '/a.jpg', comments: [], likesCount: 0, ...over }) as Photo;

describe('the photo open in the lightbox (N-113)', () => {
  it('shows a comment posted while it is open', () => {
    const { result, rerender } = renderHook(({ photos }) => useLightboxPhoto(photos), {
      initialProps: { photos: [photo()] },
    });
    act(() => result.current.open(photo()));

    rerender({ photos: [photo({ comments: [{ id: 'c1', photoId: 'p1', guestId: 'g1', commentText: 'Честито!' } as never] })] });

    expect(result.current.photo?.comments).toHaveLength(1);
  });

  it('shows a like made while it is open', () => {
    const { result, rerender } = renderHook(({ photos }) => useLightboxPhoto(photos), {
      initialProps: { photos: [photo()] },
    });
    act(() => result.current.open(photo()));

    rerender({ photos: [photo({ likesCount: 1, likedByGuestIds: ['g1'] })] });

    expect(result.current.photo?.likesCount).toBe(1);
  });

  it('closes when the photo is no longer in the album', () => {
    const { result, rerender } = renderHook(({ photos }) => useLightboxPhoto(photos), {
      initialProps: { photos: [photo()] },
    });
    act(() => result.current.open(photo()));

    rerender({ photos: [] });

    expect(result.current.photo).toBeNull();
  });

  it('closes on request', () => {
    const { result } = renderHook(() => useLightboxPhoto([photo()]));
    act(() => result.current.open(photo()));
    act(() => result.current.close());
    expect(result.current.photo).toBeNull();
  });
});
