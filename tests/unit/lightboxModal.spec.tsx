import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, screen, fireEvent } from '@testing-library/react';
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

afterEach(() => cleanup());

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
  it('allows a real server-hosted URL through', () => {
    let clickedHref: string | null = null;
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      clickedHref = this.href;
    });

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
    expect(clickedHref).toContain('/uploads/events/event-1/photo-1.jpg');
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
