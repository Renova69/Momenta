import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import React from 'react';
import { HostDashboard } from '../../src/components/host/HostDashboard';
import { WeddingEvent, QRCanvasConfig } from '../../src/types';

/**
 * FE-05 — adjusting the ceremony date/time in the host dashboard used to
 * silently regenerate the wedding slug (the public URL), breaking any
 * already-shared link or printed QR code. The slug must stay untouched
 * unless the host explicitly edits the slug field itself.
 */

afterEach(() => cleanup());

const mockEvent: WeddingEvent = {
  id: 'event-1',
  slug: 'original-slug',
  title: 'Spec Wedding',
  hostName: 'Spec Host',
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
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const mockQrConfig: QRCanvasConfig = {
  id: 'qr-1',
  eventId: 'event-1',
  canvasSize: 'A2',
  frameStyle: 'minimal_gold',
  headline: '',
  subtext: '',
  accentColor: '#D4AF37',
  centerIcon: 'heart',
};

function renderDashboard(onUpdateEvent = vi.fn()) {
  return {
    onUpdateEvent,
    ...render(
      <HostDashboard
        event={mockEvent}
        guests={[]}
        photos={[]}
        quests={[]}
        audioEntries={[]}
        qrConfig={mockQrConfig}
        onUpdateEvent={onUpdateEvent}
        onUpdateQRConfig={vi.fn()}
        onSetPhotoStatus={vi.fn()}
        onDeletePhoto={vi.fn()}
        onAddQuest={vi.fn()}
        onResetData={vi.fn()}
      />
    ),
  };
}

describe('HostDashboard date picker does not mutate the slug (FE-05)', () => {
  it('updates only eventDate when the ceremony date/time changes', () => {
    const { onUpdateEvent } = renderDashboard();

    // Plain DD.MM.YYYY / 24h text inputs (not a native datetime-local — that
    // widget renders in whatever format the device's OS locale dictates,
    // regardless of this app's own language setting).
    const dateInput = screen.getByPlaceholderText('ДД.ММ.ГГГГ');
    const timeInput = screen.getByPlaceholderText('ЧЧ:ММ');

    fireEvent.change(dateInput, { target: { value: '20.10.2026' } });
    fireEvent.blur(dateInput);

    expect(onUpdateEvent).toHaveBeenCalledTimes(1);
    const call = onUpdateEvent.mock.calls[0][0];
    expect(call).toHaveProperty('eventDate');
    expect(call).not.toHaveProperty('slug');
    expect(new Date(call.eventDate).getDate()).toBe(20);
    expect(new Date(call.eventDate).getMonth()).toBe(9); // October, 0-indexed

    // Changing only the time commits too, using the already-typed date.
    fireEvent.change(timeInput, { target: { value: '18:45' } });
    fireEvent.blur(timeInput);
    expect(onUpdateEvent).toHaveBeenCalledTimes(2);
    const secondCall = onUpdateEvent.mock.calls[1][0];
    expect(new Date(secondCall.eventDate).getHours()).toBe(18);
    expect(new Date(secondCall.eventDate).getMinutes()).toBe(45);
  });
});
