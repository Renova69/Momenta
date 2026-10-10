import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, fireEvent, cleanup, screen, act } from '@testing-library/react';
import React from 'react';
import { HostDashboard } from '../../src/components/host/HostDashboard';
import { WeddingEvent, QRCanvasConfig } from '../../src/types';
import { i18n } from '../../src/i18n';
import { router } from '../../src/router';

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
        onDeleteQuest={vi.fn()}
        onResetData={vi.fn()}
      />
    ),
  };
}

/**
 * N-62 — every pause while typing a new address committed it, and each commit
 * is a permanent rename: typing "anna-and-boris" slowly renamed the album to
 * "anna", "anna-and" and so on, and every intermediate address was printed
 * on nothing but taken from the next host to want it. The address is now
 * saved when the host leaves the field.
 */
describe('the album address field (N-62)', () => {
  it('moves the address bar to the address the server stored', () => {
    // The bar followed the field to the requested address; the server stored
    // a variant. A reload by the requested one would open someone else's album.
    vi.spyOn(router, 'getRoute').mockReturnValue({ view: 'host', slug: 'what-was-asked-for' });
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(() => undefined);

    renderDashboard();

    expect(navigate).toHaveBeenCalledWith('host', 'original-slug', undefined, { replace: true });
  });

  it('saves once, when the host leaves the field, not on every pause', () => {
    vi.useFakeTimers();
    try {
      const { onUpdateEvent } = renderDashboard();
      const slugInput = screen.getByDisplayValue('original-slug');

      fireEvent.change(slugInput, { target: { value: 'anna' } });
      act(() => vi.advanceTimersByTime(2000));
      fireEvent.change(slugInput, { target: { value: 'anna-and-boris' } });
      act(() => vi.advanceTimersByTime(2000));
      expect(onUpdateEvent).not.toHaveBeenCalledWith(expect.objectContaining({ slug: expect.anything() }));

      fireEvent.blur(slugInput);

      const slugCalls = onUpdateEvent.mock.calls.filter(([u]) => 'slug' in u);
      expect(slugCalls).toEqual([[{ slug: 'anna-and-boris' }]]);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * N-104 — the address bar followed every keystroke while the address was
   * saved only on leaving the field, so a reload in between opened an address
   * that did not exist; and a cleared field was never saved, leaving the
   * field and the bar empty.
   */
  it('leaves the address bar alone while the host types (N-104)', () => {
    vi.spyOn(router, 'getRoute').mockReturnValue({ view: 'host', slug: 'original-slug' });
    const navigate = vi.spyOn(router, 'navigate').mockImplementation(() => undefined);
    renderDashboard();
    const slugInput = screen.getByDisplayValue('original-slug');

    fireEvent.change(slugInput, { target: { value: 'anna-and-boris' } });

    expect(navigate).not.toHaveBeenCalledWith('host', 'anna-and-boris', undefined, { replace: true });
  });

  it('puts the saved address back when the field is left empty (N-104)', () => {
    const { onUpdateEvent } = renderDashboard();
    const slugInput = screen.getByDisplayValue('original-slug');

    fireEvent.change(slugInput, { target: { value: '' } });
    fireEvent.blur(slugInput);

    expect(onUpdateEvent.mock.calls.filter(([u]) => 'slug' in u)).toEqual([]);
    expect(screen.getByDisplayValue('original-slug')).toBeInTheDocument();
  });

  it('puts the saved address back when what is left is too short to be one (N-104)', () => {
    const { onUpdateEvent } = renderDashboard();
    const slugInput = screen.getByDisplayValue('original-slug');

    fireEvent.change(slugInput, { target: { value: 'ab-' } });
    fireEvent.blur(slugInput);

    expect(onUpdateEvent.mock.calls.filter(([u]) => 'slug' in u)).toEqual([]);
    expect(screen.getByDisplayValue('original-slug')).toBeInTheDocument();
  });

  it('saves an address typed with a trailing hyphen without it (N-104)', () => {
    const { onUpdateEvent } = renderDashboard();
    const slugInput = screen.getByDisplayValue('original-slug');

    fireEvent.change(slugInput, { target: { value: 'anna-and-boris-' } });
    fireEvent.blur(slugInput);

    expect(onUpdateEvent.mock.calls.filter(([u]) => 'slug' in u)).toEqual([[{ slug: 'anna-and-boris' }]]);
  });
});

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

/**
 * Renaming the hosts, without overwriting a title they wrote themselves.
 *
 * The album title defaults to "Сватбата на <hosts>", derived from the names.
 * So correcting a misspelt name should correct the title too — but only while
 * the title is still that derived one. A host who has since written their own
 * title must not lose it because they fixed a typo in a different field, and
 * the two cases are indistinguishable from the outside once it has happened.
 */
describe('HostDashboard host-name edit and the derived title', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /**
   * The name field is debounced (`useDebouncedField`, 500ms) so that typing a
   * name does not fire one PUT per keystroke. Blur does not commit it — only
   * the timer does — so the clock has to be advanced for the commit to happen
   * at all.
   */
  function editHostName(value: string) {
    const input = screen.getByPlaceholderText(i18n.t('host.hosts_example'));
    fireEvent.change(input, { target: { value } });
    act(() => {
      vi.advanceTimersByTime(600);
    });
  }

  it('updates the derived title when the title is still the default one', () => {
    const onUpdateEvent = vi.fn();
    render(
      <HostDashboard
        event={{ ...mockEvent, title: i18n.t('host.wedding_of_name', { name: 'Spec Host' }) }}
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
        onDeleteQuest={vi.fn()}
        onResetData={vi.fn()}
      />
    );

    editHostName('Monika & Alexander');

    const call = onUpdateEvent.mock.calls[0][0];
    expect(call.hostName).toBe('Monika & Alexander');
    expect(call.title).toBe(i18n.t('host.wedding_of_name', { name: 'Monika & Alexander' }));
  });

  it('leaves a title the host wrote themselves alone', () => {
    const onUpdateEvent = vi.fn();
    render(
      <HostDashboard
        event={{ ...mockEvent, title: 'Нашата сватба' }}
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
        onDeleteQuest={vi.fn()}
        onResetData={vi.fn()}
      />
    );

    editHostName('Monika & Alexander');

    const call = onUpdateEvent.mock.calls[0][0];
    expect(call.hostName).toBe('Monika & Alexander');
    expect(call.title).toBe('Нашата сватба');
  });

  it('derives a title for an album that has none', () => {
    const onUpdateEvent = vi.fn();
    render(
      <HostDashboard
        event={{ ...mockEvent, title: '' }}
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
        onDeleteQuest={vi.fn()}
        onResetData={vi.fn()}
      />
    );

    editHostName('Monika & Alexander');

    expect(onUpdateEvent.mock.calls[0][0].title).toBe(
      i18n.t('host.wedding_of_name', { name: 'Monika & Alexander' })
    );
  });
});
