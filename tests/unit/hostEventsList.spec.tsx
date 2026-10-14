import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import React from 'react';

import { HostEventsList } from '../../src/components/host/HostEventsList';
import { eventsApi } from '../../src/api/eventsApi';
import { WeddingEvent } from '../../src/types';
import { i18n } from '../../src/i18n';

function makeEvent(overrides: Partial<WeddingEvent> = {}): WeddingEvent {
  return {
    id: 'e1',
    slug: 'monika-and-alexander-2026',
    title: 'Our Wedding Day',
    hostName: 'Monika & Alexander',
    hostEmail: 'host@example.com',
    eventDate: '2026-09-18T16:30:00.000Z',
    venueName: 'Villa',
    coverImageUrl: 'https://cdn.example/cover.jpg',
    themePalette: 'champagne_gold',
    welcomeMessage: 'Welcome!',
    planTier: 'free',
    isModerationEnabled: false,
    isDisposableMode: false,
    isPublic: false,
    revealAt: null,
    maxPhotosPerGuest: 50,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

const CURRENT = makeEvent();

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('HostEventsList', () => {
  it('renders nothing when closed', () => {
    vi.spyOn(eventsApi, 'listMine').mockResolvedValue([]);
    const { container } = render(
      <HostEventsList isOpen={false} onClose={vi.fn()} currentEvent={CURRENT} onSelectEvent={vi.fn()} onCreateEvent={vi.fn()} onOpenPricing={vi.fn()} />
    );
    expect(container).toBeEmptyDOMElement();
  });

  // N-116 — this used to assert that the album open in this browser was
  // always added to the list. That album can be one the host does not own (the
  // demo wedding, or another host's after a shared device), and it was shown
  // as theirs and "Активна". The list is the host's albums, as the server has them.
  it("lists only the albums the server says are the host's", async () => {
    const other = makeEvent({ id: 'e2', hostName: 'Elena & Dimitar' });
    vi.spyOn(eventsApi, 'listMine').mockResolvedValue([other]);

    render(
      <HostEventsList isOpen onClose={vi.fn()} currentEvent={CURRENT} onSelectEvent={vi.fn()} onCreateEvent={vi.fn()} onOpenPricing={vi.fn()} />
    );

    await waitFor(() => expect(screen.getByText('Elena & Dimitar')).toBeInTheDocument());
    expect(screen.queryByText('Monika & Alexander')).toBeNull();
  });

  it("shows each album's couple, date and venue as the server sends them (N-116)", async () => {
    // GET /api/events answers with raw rows. Read as-is, every album in the
    // Pro Planner switcher showed its title and nothing else.
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify([
          {
            id: 'e3',
            slug: 'iva-i-petar',
            title: 'Сватбата на Ива и Петър',
            host_name: 'Ива и Петър',
            event_date: '2027-06-12T16:30:00.000Z',
            venue_name: 'Хотел Тест',
          },
        ]),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    render(
      <HostEventsList isOpen onClose={vi.fn()} currentEvent={CURRENT} onSelectEvent={vi.fn()} onCreateEvent={vi.fn()} onOpenPricing={vi.fn()} />
    );

    await waitFor(() => expect(screen.getByText('Ива и Петър')).toBeInTheDocument());
    expect(screen.getByText('Хотел Тест')).toBeInTheDocument();
    expect(screen.getByText('12.06.2027')).toBeInTheDocument();
  });

  it('shows a load error instead of silently showing an empty list', async () => {
    vi.spyOn(eventsApi, 'listMine').mockRejectedValue(new Error('Network down'));

    render(
      <HostEventsList isOpen onClose={vi.fn()} currentEvent={CURRENT} onSelectEvent={vi.fn()} onCreateEvent={vi.fn()} onOpenPricing={vi.fn()} />
    );

    await waitFor(() => expect(screen.getByText(/Network down/)).toBeInTheDocument());
  });

  it('selects an event and closes the modal', async () => {
    vi.spyOn(eventsApi, 'listMine').mockResolvedValue([CURRENT]);
    const onSelectEvent = vi.fn();
    const onClose = vi.fn();

    render(
      <HostEventsList isOpen onClose={onClose} currentEvent={CURRENT} onSelectEvent={onSelectEvent} onCreateEvent={vi.fn()} onOpenPricing={vi.fn()} />
    );

    await waitFor(() => expect(screen.getByText('Monika & Alexander')).toBeInTheDocument());
    fireEvent.click(screen.getByText('Monika & Alexander'));

    expect(onSelectEvent).toHaveBeenCalledWith(CURRENT);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('creates a new event from the form and closes on success', async () => {
    vi.spyOn(eventsApi, 'listMine').mockResolvedValue([CURRENT]);
    const onCreateEvent = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();

    render(
      <HostEventsList isOpen onClose={onClose} currentEvent={CURRENT} onSelectEvent={vi.fn()} onCreateEvent={onCreateEvent} onOpenPricing={vi.fn()} />
    );

    fireEvent.click(screen.getByText(i18n.t('host.new_event')));
    fireEvent.change(screen.getByPlaceholderText(i18n.t('events.hosts_example')), { target: { value: 'Gergana & Ivan' } });
    fireEvent.change(screen.getByPlaceholderText(i18n.t('events.venue_example')), { target: { value: 'Boyana Residence' } });

    await act(async () => {
      fireEvent.click(screen.getByText(i18n.t('events.create_new')));
      await Promise.resolve();
    });

    expect(onCreateEvent).toHaveBeenCalledWith(
      expect.objectContaining({ hostName: 'Gergana & Ivan', venueName: 'Boyana Residence', slug: expect.any(String) })
    );
    // N-131 — a new album stored an images.unsplash.com cover.
    expect(onCreateEvent.mock.calls[0][0].coverImageUrl).toBeUndefined();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  /**
   * N-90 — the form suggested 18 September 2026 for every new album, a date
   * already past; and clearing the field made submitting throw, because an
   * empty date has no ISO form.
   */
  it('suggests a date still ahead, not a fixed one already past (N-90)', () => {
    vi.spyOn(eventsApi, 'listMine').mockResolvedValue([]);
    render(
      <HostEventsList isOpen onClose={vi.fn()} currentEvent={CURRENT} onSelectEvent={vi.fn()} onCreateEvent={vi.fn()} onOpenPricing={vi.fn()} />
    );

    fireEvent.click(screen.getByText(i18n.t('host.new_event')));
    const date = screen.getByLabelText(i18n.t('ui.host_events_list.2')) as HTMLInputElement;

    expect(new Date(date.value).getTime()).toBeGreaterThan(Date.now());
  });

  it('asks for a date when the field was cleared, instead of throwing (N-90)', async () => {
    vi.spyOn(eventsApi, 'listMine').mockResolvedValue([]);
    const onCreateEvent = vi.fn();
    render(
      <HostEventsList isOpen onClose={vi.fn()} currentEvent={CURRENT} onSelectEvent={vi.fn()} onCreateEvent={onCreateEvent} onOpenPricing={vi.fn()} />
    );

    fireEvent.click(screen.getByText(i18n.t('host.new_event')));
    fireEvent.change(screen.getByPlaceholderText(i18n.t('events.hosts_example')), { target: { value: 'Gergana & Ivan' } });
    fireEvent.change(screen.getByLabelText(i18n.t('ui.host_events_list.2')), { target: { value: '' } });

    await act(async () => {
      fireEvent.submit(screen.getByText(i18n.t('events.create_new')).closest('form')!);
      await Promise.resolve();
    });

    expect(onCreateEvent).not.toHaveBeenCalled();
    expect(screen.getByText(i18n.t('events.date_required'))).toBeInTheDocument();
  });

  it('refuses to submit the create form without a host name', () => {
    vi.spyOn(eventsApi, 'listMine').mockResolvedValue([]);
    const onCreateEvent = vi.fn();

    render(
      <HostEventsList isOpen onClose={vi.fn()} currentEvent={CURRENT} onSelectEvent={vi.fn()} onCreateEvent={onCreateEvent} onOpenPricing={vi.fn()} />
    );

    fireEvent.click(screen.getByText(i18n.t('host.new_event')));
    fireEvent.click(screen.getByText(i18n.t('events.create_new')));

    expect(onCreateEvent).not.toHaveBeenCalled();
  });

  it('shows the create error and keeps the form open when creation fails', async () => {
    vi.spyOn(eventsApi, 'listMine').mockResolvedValue([]);
    const onCreateEvent = vi.fn().mockRejectedValue(new Error('Event limit reached'));
    const onClose = vi.fn();

    render(
      <HostEventsList isOpen onClose={onClose} currentEvent={CURRENT} onSelectEvent={vi.fn()} onCreateEvent={onCreateEvent} onOpenPricing={vi.fn()} />
    );

    fireEvent.click(screen.getByText(i18n.t('host.new_event')));
    fireEvent.change(screen.getByPlaceholderText(i18n.t('events.hosts_example')), { target: { value: 'Gergana & Ivan' } });

    await act(async () => {
      fireEvent.click(screen.getByText(i18n.t('events.create_new')));
      await Promise.resolve();
    });

    expect(screen.getByText('Event limit reached')).toBeInTheDocument();
    expect(onClose).not.toHaveBeenCalled();
  });
});
