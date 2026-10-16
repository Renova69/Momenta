import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { PublicWeddingsShowcase } from '../../src/components/home/PublicWeddingsShowcase';
import { eventsApi } from '../../src/api/eventsApi';
import { i18n } from '../../src/i18n';

/**
 * The public showcase on the landing page.
 *
 * It is the first thing a prospective customer sees. A feed request that
 * fails, or returns something unexpected, leaves the bundled demo weddings in
 * place rather than blanking the landing page.
 *
 * N-77 — a real album is shown as it is. Each field a real row lacked used to
 * be filled from the demo wedding at the same index: a new album with no
 * photos appeared with someone else's stock photos, a demo venue, and 54
 * photos and 88 guests in place of its real zeros.
 */

/**
 * The bundled demo weddings' images are all served from here. They were
 * hotlinked from images.unsplash.com, which the production CSP refuses, so on
 * the live site every demo card was an empty box (N-112).
 */
const DEMO_IMAGE_HOST = '/demo/';
const imageSources = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('img')).map((i) => i.getAttribute('src') ?? '');

const handlers = () => ({
  onSelectWedding: vi.fn(),
  onOpenCreateEvent: vi.fn(),
  onOpenPricing: vi.fn(),
});

function renderShowcase(over: Partial<ReturnType<typeof handlers>> = {}) {
  const props = { ...handlers(), ...over };
  const utils = render(<PublicWeddingsShowcase {...props} />);
  return { ...utils, props };
}

/** A feed row as the server actually sends it: snake_case, partially present. */
const serverRow = (over: Record<string, unknown> = {}) => ({
  id: 'srv-1',
  slug: 'server-wedding',
  title: 'Server Wedding',
  host_name: 'Ivan & Maria',
  event_date: '2026-09-20T15:00:00.000Z',
  venue_name: 'Server Venue',
  cover_image_url: 'https://cdn.example.com/cover.jpg',
  photos_count: 321,
  guests_count: 45,
  previewPhotos: [
    { id: 'ph-1', thumbnail_url: 'https://cdn.example.com/t1.jpg', full_url: 'https://cdn.example.com/f1.jpg', caption: 'A real moment' },
  ],
  ...over,
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('falling back to the bundled demo weddings', () => {
  it('renders demo content immediately, before the feed resolves', () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockReturnValue(new Promise(() => {}));

    const { container } = renderShowcase();

    // Never an empty landing page while a request is in flight.
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
  });

  it('serves every demo image from the app itself, which the CSP allows', () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockReturnValue(new Promise(() => {}));

    const { container } = renderShowcase();

    const sources = imageSources(container);
    expect(sources.length).toBeGreaterThan(0);
    expect(sources.every((src) => src.startsWith(DEMO_IMAGE_HOST))).toBe(true);
  });

  it('keeps the demo content when the feed request fails', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockRejectedValue(new Error('offline'));

    const { container } = renderShowcase();

    await waitFor(() => expect(console.warn).toHaveBeenCalled());
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
    expect(screen.queryByText('Server Wedding')).toBeNull();
  });

  it('keeps the demo content when the feed is empty', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([]);

    const { container } = renderShowcase();

    await waitFor(() => expect(eventsApi.getShowcaseFeed).toHaveBeenCalled());
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
  });

  it('keeps the demo content when the feed is not an array', async () => {
    // A proxy returning an HTML error page, or an envelope shape change.
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue({ error: 'nope' } as never);

    const { container } = renderShowcase();

    await waitFor(() => expect(eventsApi.getShowcaseFeed).toHaveBeenCalled());
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
  });
});

describe('mapping a live feed', () => {
  it('renders the server rows once they arrive', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([serverRow()] as never);

    renderShowcase();

    expect(await screen.findByText('Server Wedding')).toBeTruthy();
    // hostName is mapped but not rendered by this component; the venue is.
    expect(screen.getByText(/Server Venue/)).toBeTruthy();
  });

  it('reads snake_case fields the server actually sends', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([serverRow()] as never);

    renderShowcase();

    expect(await screen.findByText('Server Wedding')).toBeTruthy();
    expect(screen.getByText(/Server Venue/)).toBeTruthy();
  });

  it('prefers camelCase when the server sends that instead', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([
      serverRow({ hostName: 'Camel Host', venueName: 'Camel Venue', host_name: undefined, venue_name: undefined }),
    ] as never);

    renderShowcase();

    expect(await screen.findByText(/Camel Venue/)).toBeTruthy();
  });

  it('leaves out a field the row omits instead of borrowing a demo one (N-77)', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([
      serverRow({ venue_name: undefined, event_date: undefined }),
    ] as never);

    const { container } = renderShowcase();

    expect(await screen.findByText('Server Wedding')).toBeTruthy();
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('NaN');
    expect(container.textContent).not.toContain('Резиденция Бояна');
  });

  it('names an untitled album after its hosts', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([serverRow({ title: undefined })] as never);

    renderShowcase();

    expect(await screen.findByText('Ivan & Maria')).toBeTruthy();
  });

  it('shows no demo photos for an album that has none yet (N-77)', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([serverRow({ previewPhotos: [] })] as never);

    const { container } = renderShowcase();

    expect(await screen.findByText('Server Wedding')).toBeTruthy();
    expect(imageSources(container).some((src) => src.includes(DEMO_IMAGE_HOST))).toBe(false);
    // Its own cover is still shown.
    expect(imageSources(container)).toContain('https://cdn.example.com/cover.jpg');
  });

  it('shows no demo photos when the row carries no preview list at all', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([serverRow({ previewPhotos: undefined })] as never);

    const { container } = renderShowcase();

    expect(await screen.findByText('Server Wedding')).toBeTruthy();
    expect(imageSources(container).some((src) => src.includes(DEMO_IMAGE_HOST))).toBe(false);
  });

  it('shows no demo cover for an album without one', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([
      serverRow({ cover_image_url: undefined, previewPhotos: [] }),
    ] as never);

    const { container } = renderShowcase();

    expect(await screen.findByText('Server Wedding')).toBeTruthy();
    expect(imageSources(container)).toEqual([]);
  });

  it('reports a real count of zero as zero, not the demo wedding counts (N-77)', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([
      serverRow({ photos_count: 0, guests_count: 0, previewPhotos: [] }),
    ] as never);

    renderShowcase();

    expect(await screen.findByText(i18n.t('showcase.photos_count', { n: 0 }))).toBeTruthy();
    expect(screen.getByText(i18n.t('showcase.guests_count', { n: 0 }))).toBeTruthy();
    expect(screen.queryByText(i18n.t('showcase.photos_count', { n: 54 }))).toBeNull();
  });

  it('leaves out a row with no address, which nothing could open', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([
      serverRow({ id: 'no-slug', slug: undefined, title: 'Unreachable' }),
      serverRow(),
    ] as never);

    renderShowcase();

    expect(await screen.findByText('Server Wedding')).toBeTruthy();
    expect(screen.queryByText('Unreachable')).toBeNull();
  });

  it('accepts either casing on a preview photo, and fills a missing caption', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([
      serverRow({
        previewPhotos: [
          { id: 'a', thumbnailUrl: 'https://cdn.example.com/camel-t.jpg', fullUrl: 'https://cdn.example.com/camel-f.jpg' },
        ],
      }),
    ] as never);

    const { container } = renderShowcase();

    await screen.findByText('Server Wedding');
    const srcs = Array.from(container.querySelectorAll('img')).map((i) => i.getAttribute('src'));
    expect(srcs.some((s) => s?.includes('camel-t.jpg'))).toBe(true);
    expect(container.textContent).not.toContain('undefined');
  });

  it('skips a preview photo with no urls rather than showing a demo one in its place', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([
      serverRow({ previewPhotos: [{ id: 'bare' }] }),
    ] as never);

    const { container } = renderShowcase();

    await screen.findByText('Server Wedding');
    expect(imageSources(container)).toEqual(['https://cdn.example.com/cover.jpg']);
  });

  it('maps a feed longer than the bundled demo set', async () => {
    const rows = Array.from({ length: 7 }, (_, i) =>
      serverRow({ id: `srv-${i}`, slug: `w-${i}`, title: `Wedding ${i}` })
    );
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue(rows as never);

    const { container } = renderShowcase();

    expect(await screen.findByText('Wedding 6')).toBeTruthy();
    expect(container.textContent).not.toContain('undefined');
  });
});

describe('the calls to action', () => {
  it('selects a wedding by slug', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([serverRow()] as never);
    const { props } = renderShowcase();

    fireEvent.click(await screen.findByText('Server Wedding'));

    expect(props.onSelectWedding).toHaveBeenCalledWith('server-wedding');
  });

  it('opens create-event and pricing from the footer', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([] as never);
    const { container, props } = renderShowcase();

    const buttons = Array.from(container.querySelectorAll('button'));
    // The two calls to action are the last controls in the section.
    fireEvent.click(buttons[buttons.length - 2]);
    fireEvent.click(buttons[buttons.length - 1]);

    expect(props.onOpenCreateEvent).toHaveBeenCalledTimes(1);
    expect(props.onOpenPricing).toHaveBeenCalledTimes(1);
  });
});

describe('unmounting mid-request', () => {
  it('does not set state after the component has gone', async () => {
    let resolve!: (v: unknown) => void;
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockReturnValue(
      new Promise((r) => { resolve = r; }) as never
    );
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const { unmount } = renderShowcase();
    unmount();
    resolve([serverRow()]);
    await Promise.resolve();

    // React warns on a state update after unmount; the isMounted guard is
    // what keeps that out of a customer-facing page's console.
    expect(errors).not.toHaveBeenCalled();
  });
});
