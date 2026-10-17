import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import React from 'react';

import { AlbumClosedNotice } from '../../src/components/common/AlbumClosedNotice';
import { CameraCaptureModal } from '../../src/components/camera/CameraCaptureModal';
import { AudioGuestbook } from '../../src/components/audio/AudioGuestbook';
import { isAlbumClosed } from '../../src/utils/albumStatus';
import { normalizeEvent } from '../../src/services/eventNormalization';
import { Guest } from '../../src/types';
import { i18n } from '../../src/i18n';

/**
 * N-159 — what a phone shows once an album has closed to new photos. The
 * server refuses on its own; these keep a guest from trying and failing.
 */

const CLOSED_AT = '2026-10-23T12:00:00.000Z';
const GUEST: Guest = { id: 'g1', eventId: 'e1', name: 'Ana', createdAt: '2026-10-01T00:00:00.000Z' };

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('isAlbumClosed', () => {
  it('is closed once the deadline has passed, and never without one', () => {
    const now = Date.parse('2026-10-24T00:00:00.000Z');
    expect(isAlbumClosed(CLOSED_AT, now)).toBe(true);
    expect(isAlbumClosed('2026-10-25T00:00:00.000Z', now)).toBe(false);
    expect(isAlbumClosed(null, now)).toBe(false);
    expect(isAlbumClosed(undefined, now)).toBe(false);
  });

  it('reads the deadline from the server’s album, in either casing', () => {
    expect(normalizeEvent({ id: 'e', slug: 's', expires_at: CLOSED_AT }).expiresAt).toBe(CLOSED_AT);
    expect(normalizeEvent({ id: 'e', slug: 's' }).expiresAt).toBeNull();
  });
});

describe('AlbumClosedNotice', () => {
  it('tells a guest the album closed and that looking and downloading stay', () => {
    render(<AlbumClosedNotice closedAt={CLOSED_AT} />);

    expect(screen.getByText(i18n.t('album.closed_guest', { date: '23.10.2026' }))).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('offers the host a plan that opens it again', () => {
    const onOpenPricing = vi.fn();
    render(<AlbumClosedNotice closedAt={CLOSED_AT} onOpenPricing={onOpenPricing} />);

    expect(screen.getByText(i18n.t('album.closed_host', { date: '23.10.2026' }))).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('album.reopen') }));
    expect(onOpenPricing).toHaveBeenCalled();
  });
});

describe('on a closed album', () => {
  it('the camera says so instead of opening', () => {
    const getUserMedia = vi.fn();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
    const onClose = vi.fn();

    render(
      <CameraCaptureModal
        isOpen
        onClose={onClose}
        currentGuest={GUEST}
        quests={[]}
        onPhotoUploaded={vi.fn()}
        closedAt={CLOSED_AT}
      />
    );

    expect(screen.getByText(i18n.t('album.closed_guest', { date: '23.10.2026' }))).toBeInTheDocument();
    expect(screen.queryByLabelText(i18n.t('camera.gallery'))).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: i18n.t('common.close') }));
    expect(onClose).toHaveBeenCalled();
  });

  it('the voice guestbook offers no recorder, but keeps the messages', () => {
    render(<AudioGuestbook entries={[]} onAddAudioEntry={vi.fn()} closedAt={CLOSED_AT} />);

    expect(screen.getByText(i18n.t('album.closed_guest', { date: '23.10.2026' }))).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: i18n.t('audio.record_btn') })).not.toBeInTheDocument();
  });
});
