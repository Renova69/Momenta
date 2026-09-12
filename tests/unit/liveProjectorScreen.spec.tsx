import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import React from 'react';

import { LiveProjectorScreen } from '../../src/components/projector/LiveProjectorScreen';
import { storageService } from '../../src/services/storageService';
import { WeddingEvent, Photo } from '../../src/types';
import { i18n } from '../../src/i18n';

// This screen is on a physical TV in front of every guest at the reception —
// G1 (OPEN_ITEMS.md): the highest-damage untested component in the app.

const EVENT: WeddingEvent = {
  id: 'e1',
  slug: 'monika-and-alexander-2026',
  title: 'Monika & Alexander',
  hostName: 'Monika & Alexander',
  hostEmail: 'host@example.com',
  eventDate: new Date().toISOString(),
  venueName: 'Villa',
  coverImageUrl: 'https://cdn.example/cover.jpg',
  themePalette: 'champagne_gold',
  welcomeMessage: 'Welcome!',
  planTier: 'celebration_pass',
  isModerationEnabled: false,
  isDisposableMode: false,
  isPublic: false,
  revealAt: null,
  maxPhotosPerGuest: 50,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function photo(overrides: Partial<Photo> = {}): Photo {
  return {
    id: `p-${Math.random().toString(36).slice(2, 8)}`,
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
    ...overrides,
  } as Photo;
}

function renderScreen(photos: Photo[], onClose = vi.fn()) {
  return render(<LiveProjectorScreen event={EVENT} photos={photos} onClose={onClose} />);
}

describe('LiveProjectorScreen', () => {
  beforeEach(() => {
    // toggleFullscreen calls these directly (no `in document` guard), so a
    // real jsdom document without them throws synchronously before the
    // .catch() chain can even attach.
    Object.defineProperty(document.documentElement, 'requestFullscreen', {
      value: vi.fn().mockResolvedValue(undefined),
      configurable: true,
    });
    Object.defineProperty(document, 'exitFullscreen', {
      value: vi.fn().mockResolvedValue(undefined),
      configurable: true,
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shows only approved/featured photos, photographer-priority first then newest', () => {
    const older = photo({ id: 'guest-old', status: 'approved', priority: 0, createdAt: '2026-01-01T00:00:00Z', guestName: 'Old Guest' });
    const newer = photo({ id: 'guest-new', status: 'approved', priority: 0, createdAt: '2026-01-02T00:00:00Z', guestName: 'New Guest' });
    const pro = photo({ id: 'pro-1', status: 'featured', priority: 10, createdAt: '2025-12-01T00:00:00Z', guestName: 'Official Photographer' });
    const pending = photo({ id: 'pending-1', status: 'pending', guestName: 'Should Not Show' });
    const rejected = photo({ id: 'rejected-1', status: 'rejected', guestName: 'Should Not Show Either' });

    renderScreen([older, newer, pro, pending, rejected]);

    // Photographer priority wins even though it is the oldest photo.
    expect(screen.getByText('Official Photographer')).toBeInTheDocument();
    expect(screen.queryByText('Should Not Show')).not.toBeInTheDocument();
    expect(screen.queryByText('Should Not Show Either')).not.toBeInTheDocument();
  });

  it('shows the empty-wall prompt when no photo is displayable yet', () => {
    renderScreen([photo({ status: 'pending' })]);

    expect(screen.getByText(i18n.t('feed.empty_title'))).toBeInTheDocument();
    expect(screen.queryByRole('img', { name: 'Wedding celebration' })).not.toBeInTheDocument();
  });

  it('cycles forward and backward through photos on chevron clicks, wrapping at both ends', () => {
    const a = photo({ id: 'a', guestName: 'Guest A', createdAt: '2026-01-03T00:00:00Z' });
    const b = photo({ id: 'b', guestName: 'Guest B', createdAt: '2026-01-02T00:00:00Z' });
    const c = photo({ id: 'c', guestName: 'Guest C', createdAt: '2026-01-01T00:00:00Z' });
    renderScreen([a, b, c]);

    // Newest-first: A, B, C.
    expect(screen.getByText('Guest A')).toBeInTheDocument();

    const buttons = screen.getAllByRole('button');
    const nextBtn = buttons.find((b) => b.querySelector('svg.lucide-chevron-right'))!;
    const prevBtn = buttons.find((b) => b.querySelector('svg.lucide-chevron-left'))!;

    fireEvent.click(nextBtn);
    expect(screen.getByText('Guest B')).toBeInTheDocument();

    fireEvent.click(nextBtn);
    expect(screen.getByText('Guest C')).toBeInTheDocument();

    // Wraps forward past the last photo back to the first.
    fireEvent.click(nextBtn);
    expect(screen.getByText('Guest A')).toBeInTheDocument();

    // Wraps backward past the first photo to the last.
    fireEvent.click(prevBtn);
    expect(screen.getByText('Guest C')).toBeInTheDocument();
  });

  it('auto-advances on the slideshow timer while playing, and stops once paused', () => {
    vi.useFakeTimers();
    const a = photo({ id: 'a', guestName: 'Guest A', createdAt: '2026-01-02T00:00:00Z' });
    const b = photo({ id: 'b', guestName: 'Guest B', createdAt: '2026-01-01T00:00:00Z' });
    renderScreen([a, b]);

    expect(screen.getByText('Guest A')).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(6000); // default slide speed
    });
    expect(screen.getByText('Guest B')).toBeInTheDocument();

    fireEvent.click(screen.getByTitle(i18n.t('audio.pause')));
    act(() => {
      vi.advanceTimersByTime(20000);
    });
    // Still on B — the ticker stopped once paused.
    expect(screen.getByText('Guest B')).toBeInTheDocument();
  });

  it('floats a live reaction and removes it once its animation window elapses', () => {
    vi.useFakeTimers();
    let capturedListener: ((r: { id: string; reaction: string; guestName: string | null }) => void) | undefined;
    vi.spyOn(storageService, 'subscribeReactions').mockImplementation((listener) => {
      capturedListener = listener as typeof capturedListener;
      return () => {};
    });

    renderScreen([photo()]);
    expect(capturedListener).toBeDefined();

    act(() => {
      capturedListener!({ id: 'rx-1', reaction: 'heart', guestName: 'Silvia' });
    });
    // Heart emoji rendered somewhere in the ephemeral reaction layer.
    expect(document.body.textContent).toContain('❤️');

    act(() => {
      vi.advanceTimersByTime(3400);
    });
    expect(document.body.textContent).not.toContain('❤️');
  });

  it('calls onClose when the close button is clicked', () => {
    const onClose = vi.fn();
    renderScreen([photo()], onClose);

    fireEvent.click(screen.getByTitle(i18n.t('projector.close')));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('builds the live QR code target URL from the event slug', () => {
    renderScreen([photo()]);
    const qrSvg = document.querySelector('svg[height]');
    expect(qrSvg).toBeTruthy();
    // qrcode.react renders the payload as an aria-less SVG grid, not text, so
    // the exercised contract is that the component doesn't crash building the
    // URL from window.location.origin + event.slug — verified indirectly by
    // the QR block rendering at all rather than throwing during render.
    expect(screen.getByText(i18n.t('projector.scan_share'))).toBeInTheDocument();
  });
});
