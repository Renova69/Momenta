import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import React from 'react';
import { LightboxModal } from '../../src/components/gallery/LightboxModal';
import { Photo, Guest } from '../../src/types';
import { i18n } from '../../src/i18n';

/**
 * SEC-W1 — a photo.fullUrl the server didn't generate (impossible today
 * since SEC-A1 closed that path server-side, but this is the client-side
 * defense-in-depth layer) should never be handed to a download link as-is.
 * FE-11 — the SEC-W1 guard was written too narrowly and blocked the
 * legitimate data:/blob: URLs fullUrl holds during the optimistic-upload
 * window (a guest's own just-captured photo, before the server URL replaces
 * it) — a real regression from the SEC-W1 fix itself.
 */

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const mockGuest: Guest = {
  id: 'guest-1',
  eventId: 'event-1',
  name: 'Spec Guest',
  createdAt: new Date().toISOString(),
};

function makePhoto(fullUrl: string): Photo {
  return {
    id: 'photo-1',
    eventId: 'event-1',
    guestId: 'guest-1',
    guestName: 'Spec Guest',
    storagePath: '/uploads/photo-1.jpg',
    thumbnailUrl: fullUrl,
    fullUrl,
    status: 'approved',
    filterApplied: 'original',
    likesCount: 0,
    commentsCount: 0,
    createdAt: new Date().toISOString(),
  };
}

function clickDownloadButton(container: HTMLElement): void {
  const buttons = Array.from(container.querySelectorAll('button'));
  const downloadButton = buttons.find((b) => b.querySelector('svg.lucide-download'));
  if (!downloadButton) throw new Error('download button not found');
  downloadButton.click();
}

describe('LightboxModal download guard (SEC-W1, FE-11)', () => {
  // N-114 — the link used to be an <a download> straight to the image. The
  // image is on another origin (the API in development, R2 in production),
  // where browsers ignore `download`: the guest's tab navigated away from the
  // album to the bare JPEG. It is fetched and saved from a local copy now.
  it('saves a server-hosted photo without leaving the album', async () => {
    let clicked: { href: string; download: string } | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clicked = { href: this.href, download: this.download };
    });
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(new Blob(['jpeg'])));
    const createUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:http://localhost/local-copy');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);

    const { container } = render(
      <LightboxModal
        photo={makePhoto('/uploads/events/event-1/photo-1.jpg')}
        onClose={vi.fn()}
        currentGuest={mockGuest}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onAddComment={vi.fn()}
      />
    );

    clickDownloadButton(container);

    await waitFor(() => expect(clicked).not.toBeNull());
    expect(fetchSpy.mock.calls[0][0]).toBe('/uploads/events/event-1/photo-1.jpg');
    expect(createUrl).toHaveBeenCalled();
    expect(clicked!.href).toBe('blob:http://localhost/local-copy');
    expect(clicked!.download).toBe('wedmoments-photo-1.jpg');
  });

  it('opens the photo in a new tab when its host will not hand it over', async () => {
    const anchorClick = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);

    const { container } = render(
      <LightboxModal
        photo={makePhoto('https://pub-example.r2.dev/events/event-1/photo-1.jpg')}
        onClose={vi.fn()}
        currentGuest={mockGuest}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onAddComment={vi.fn()}
      />
    );

    clickDownloadButton(container);

    await waitFor(() => expect(openSpy).toHaveBeenCalled());
    expect(openSpy).toHaveBeenCalledWith(
      'https://pub-example.r2.dev/events/event-1/photo-1.jpg',
      '_blank',
      'noopener,noreferrer'
    );
    expect(anchorClick).not.toHaveBeenCalled();
  });

  it('allows a data: URL through (FE-11) - the optimistic-upload window', () => {
    let clicked = false;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      clicked = true;
    });

    const { container } = render(
      <LightboxModal
        photo={makePhoto('data:image/jpeg;base64,/9j/4AAQSkZJRg==')}
        onClose={vi.fn()}
        currentGuest={mockGuest}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onAddComment={vi.fn()}
      />
    );

    clickDownloadButton(container);
    expect(clicked).toBe(true);
  });

  it('allows a blob: URL through (FE-11)', () => {
    let clicked = false;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      clicked = true;
    });

    const { container } = render(
      <LightboxModal
        photo={makePhoto('blob:http://localhost/00000000-0000-0000-0000-000000000000')}
        onClose={vi.fn()}
        currentGuest={mockGuest}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onAddComment={vi.fn()}
      />
    );

    clickDownloadButton(container);
    expect(clicked).toBe(true);
  });

  it('still refuses a non-http(s)/data/blob scheme (SEC-W1 defense stays intact)', () => {
    let clicked = false;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {
      clicked = true;
    });

    const { container } = render(
      <LightboxModal
        photo={makePhoto('javascript:alert(1)')}
        onClose={vi.fn()}
        currentGuest={mockGuest}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onAddComment={vi.fn()}
      />
    );

    clickDownloadButton(container);
    expect(clicked).toBe(false);
  });
});

describe('LightboxModal emoji reactions', () => {
  it('reacting with a fresh emoji calls onReact with the photo id and kind', () => {
    const onReact = vi.fn();
    render(
      <LightboxModal
        photo={makePhoto('/uploads/events/event-1/photo-1.jpg')}
        onClose={vi.fn()}
        currentGuest={mockGuest}
        onLike={vi.fn()}
        onReact={onReact}
        onAddComment={vi.fn()}
      />
    );

    fireEvent.click(screen.getByTitle(i18n.t('reaction.clap')));
    expect(onReact).toHaveBeenCalledWith('photo-1', 'clap');
  });

  it('shows an existing reaction as a counted, highlighted pill', () => {
    const photo = { ...makePhoto('/uploads/events/event-1/photo-1.jpg'), reactions: [{ reaction: 'heart' as const, guestId: mockGuest.id }] };
    render(
      <LightboxModal
        photo={photo}
        onClose={vi.fn()}
        currentGuest={mockGuest}
        onLike={vi.fn()}
        onReact={vi.fn()}
        onAddComment={vi.fn()}
      />
    );

    const pill = screen.getByTitle(i18n.t('reaction.heart'));
    expect(pill.textContent).toContain('1');
  });
});
