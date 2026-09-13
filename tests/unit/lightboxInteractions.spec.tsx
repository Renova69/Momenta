import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import { LightboxModal } from '../../src/components/gallery/LightboxModal';
import { Photo, Guest } from '../../src/types';

/**
 * The photo viewer's interactive parts.
 *
 * `lightboxModal.spec.tsx` covers the SEC-W1/FE-11 download guard and the
 * reaction bar. This covers commenting, liking, copying the link and closing —
 * the rest of what a guest can actually do in the one view where they look at
 * somebody else's photo full screen.
 */

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const guest: Guest = {
  id: 'guest-1',
  eventId: 'event-1',
  name: 'Spec Guest',
  createdAt: new Date().toISOString(),
};

function makePhoto(over: Partial<Photo> = {}): Photo {
  return {
    id: 'photo-1',
    eventId: 'event-1',
    guestId: 'guest-2',
    guestName: 'Someone Else',
    storagePath: '/uploads/photo-1.jpg',
    thumbnailUrl: 'https://cdn.example.com/photo-1.jpg',
    fullUrl: 'https://cdn.example.com/photo-1.jpg',
    status: 'approved',
    filterApplied: 'original',
    likesCount: 0,
    commentsCount: 0,
    likedByGuestIds: [],
    reactions: [],
    comments: [],
    createdAt: new Date().toISOString(),
    ...over,
  } as Photo;
}

function renderLightbox(over: Partial<React.ComponentProps<typeof LightboxModal>> = {}) {
  const props = {
    photo: makePhoto(),
    onClose: vi.fn(),
    currentGuest: guest,
    onLike: vi.fn(),
    onReact: vi.fn(),
    onAddComment: vi.fn(),
    ...over,
  };
  const utils = render(<LightboxModal {...props} />);
  return { ...utils, props };
}

describe('LightboxModal visibility', () => {
  it('renders nothing when there is no photo selected', () => {
    const { container } = render(
      <LightboxModal
        photo={null}
        onClose={vi.fn()}
        currentGuest={guest}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onAddComment={vi.fn()}
      />
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the photo and its author once one is selected', () => {
    renderLightbox();
    expect(screen.getByText('Someone Else')).toBeTruthy();
  });
});

describe('LightboxModal commenting', () => {
  function commentBox(container: HTMLElement): HTMLInputElement | HTMLTextAreaElement {
    const field = container.querySelector('input[type="text"], textarea');
    if (!field) throw new Error('comment field not found');
    return field as HTMLInputElement | HTMLTextAreaElement;
  }

  it('submits a comment against the right photo and clears the box', () => {
    const { container, props } = renderLightbox();
    const field = commentBox(container);

    fireEvent.change(field, { target: { value: 'Gorgeous shot' } });
    fireEvent.submit(field.closest('form')!);

    expect(props.onAddComment).toHaveBeenCalledWith('photo-1', 'Gorgeous shot');
    expect(field.value).toBe('');
  });

  it('ignores a whitespace-only comment', () => {
    const { container, props } = renderLightbox();
    const field = commentBox(container);

    fireEvent.change(field, { target: { value: '   ' } });
    fireEvent.submit(field.closest('form')!);

    expect(props.onAddComment).not.toHaveBeenCalled();
  });

  it('ignores an empty comment', () => {
    const { container, props } = renderLightbox();
    fireEvent.submit(commentBox(container).closest('form')!);
    expect(props.onAddComment).not.toHaveBeenCalled();
  });

  it('renders comments already on the photo', () => {
    renderLightbox({
      photo: makePhoto({
        comments: [
          {
            id: 'c1',
            photoId: 'photo-1',
            guestId: 'g9',
            guestName: 'Ana',
            commentText: 'Lovely',
            createdAt: new Date().toISOString(),
          },
        ],
        commentsCount: 1,
      } as Partial<Photo>),
    });

    expect(screen.getByText('Lovely')).toBeTruthy();
  });
});

describe('LightboxModal copy link', () => {
  function clickCopy(container: HTMLElement) {
    const button = Array.from(container.querySelectorAll('button')).find(
      (b) => b.querySelector('svg.lucide-share-2')
    );
    if (!button) throw new Error('copy button not found');
    fireEvent.click(button);
  }

  it('writes the photo URL to the clipboard', () => {
    const writeText = vi.fn();
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });

    const { container } = renderLightbox();
    clickCopy(container);

    expect(writeText).toHaveBeenCalledWith('https://cdn.example.com/photo-1.jpg');
  });

  it('does not throw when the browser exposes no clipboard', () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });

    const { container } = renderLightbox();
    expect(() => clickCopy(container)).not.toThrow();
  });
});

describe('LightboxModal like', () => {
  it('passes the photo id to onLike', () => {
    const { container, props } = renderLightbox();
    const likeButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.querySelector('svg.lucide-heart')
    );
    if (!likeButton) throw new Error('like button not found');

    fireEvent.click(likeButton);

    expect(props.onLike).toHaveBeenCalledWith('photo-1');
  });
});

describe('LightboxModal close', () => {
  it('closes on the dismiss control', () => {
    const { container, props } = renderLightbox();
    const closeButton = Array.from(container.querySelectorAll('button')).find((b) =>
      b.querySelector('svg.lucide-x')
    );
    if (!closeButton) throw new Error('close button not found');

    fireEvent.click(closeButton);

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});
