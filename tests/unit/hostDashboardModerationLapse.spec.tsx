import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import React from 'react';
import { HostDashboard } from '../../src/components/host/HostDashboard';
import { Photo, WeddingEvent, QRCanvasConfig } from '../../src/types';
import { i18n } from '../../src/i18n';

/**
 * N-46 — the moderation queue is the only screen that approves a photo, and
 * it locked below Celebration Pass. After any downgrade — a cancellation, or
 * a plan suspended for non-payment — the photos already waiting were stranded
 * there. Worse, switching moderation on is gated but leaving it on is not, so
 * every new upload kept landing in that same queue: guests' photos stopped
 * appearing at all, with no screen that could release them.
 *
 * The queue stays usable while there is anything to moderate. Only the switch
 * that turns moderation on remains a paid feature.
 */

afterEach(() => cleanup());

const baseEvent: WeddingEvent = {
  id: 'event-1',
  slug: 'lapsed-slug',
  title: 'Lapsed Wedding',
  hostName: 'Host',
  hostEmail: 'host@example.com',
  eventDate: '2026-09-18T16:30:00.000Z',
  venueName: 'Venue',
  coverImageUrl: '',
  themePalette: 'champagne_gold',
  welcomeMessage: 'Welcome',
  isModerationEnabled: false,
  isDisposableMode: false,
  isPublic: false,
  revealAt: null,
  maxPhotosPerGuest: 50,
  planTier: 'free',
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const qrConfig: QRCanvasConfig = {
  id: 'qr-1',
  eventId: 'event-1',
  canvasSize: 'A2',
  frameStyle: 'minimal_gold',
  headline: '',
  subtext: '',
  accentColor: '#D4AF37',
  centerIcon: 'heart',
};

function pendingPhoto(id: string): Photo {
  return {
    id,
    eventId: 'event-1',
    guestId: 'g1',
    guestName: 'Silvia',
    guestTable: 'Table 4',
    storagePath: '/uploads/x.jpg',
    thumbnailUrl: 'https://cdn.example/x-thumb.jpg',
    fullUrl: 'https://cdn.example/x.jpg',
    status: 'pending',
    filterApplied: 'original',
    likesCount: 0,
    commentsCount: 0,
    likedByGuestIds: [],
    comments: [],
    createdAt: new Date().toISOString(),
  } as Photo;
}

function openModeration(event: WeddingEvent, photos: Photo[], onSetPhotoStatus = vi.fn()) {
  render(
    <HostDashboard
      event={event}
      guests={[]}
      photos={photos}
      quests={[]}
      audioEntries={[]}
      qrConfig={qrConfig}
      onUpdateEvent={vi.fn()}
      onUpdateQRConfig={vi.fn()}
      onSetPhotoStatus={onSetPhotoStatus}
      onDeletePhoto={vi.fn()}
      onAddQuest={vi.fn()}
      onDeleteQuest={vi.fn()}
      onResetData={vi.fn()}
    />
  );
  fireEvent.click(screen.getByText(i18n.t('host.moderation')));
  return { onSetPhotoStatus };
}

describe('the moderation queue after a downgrade (N-46)', () => {
  it('lets the host approve photos already waiting, on a plan without moderation', () => {
    const { onSetPhotoStatus } = openModeration(baseEvent, [pendingPhoto('waiting-1')]);

    fireEvent.click(screen.getByText(i18n.t('host.approve')));

    expect(onSetPhotoStatus).toHaveBeenCalledWith('waiting-1', 'approved');
    expect(screen.getByText(i18n.t('moderation.plan_lapsed_notice'))).toBeInTheDocument();
  });

  it('stays open while moderation is still switched on, even with nothing waiting yet', () => {
    openModeration({ ...baseEvent, isModerationEnabled: true }, []);

    expect(screen.getByText(i18n.t('host.all_caught_up'))).toBeInTheDocument();
    expect(screen.queryByText(i18n.t('gate.photo_moderation.title'))).not.toBeInTheDocument();
  });

  it('still shows the locked card when there is nothing to moderate', () => {
    openModeration(baseEvent, []);

    expect(screen.getByText(i18n.t('gate.photo_moderation.title'))).toBeInTheDocument();
  });

  it('shows no lapse notice on a plan that includes moderation', () => {
    openModeration({ ...baseEvent, planTier: 'celebration_pass' }, [pendingPhoto('waiting-2')]);

    expect(screen.queryByText(i18n.t('moderation.plan_lapsed_notice'))).not.toBeInTheDocument();
  });
});
