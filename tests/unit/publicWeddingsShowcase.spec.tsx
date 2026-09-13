import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import React from 'react';
import { PublicWeddingsShowcase } from '../../src/components/home/PublicWeddingsShowcase';
import { eventsApi } from '../../src/api/eventsApi';

/**
 * The public showcase on the landing page.
 *
 * It is the first thing a prospective customer sees, and it is built almost
 * entirely out of fallbacks: the API returns rows in mixed casing with fields
 * that may be missing, and every one of them falls back to a bundled demo
 * wedding so the page is never empty or half-rendered. That is a lot of
 * branches, none of which were covered — the component had 0% branch coverage,
 * so any of those fallbacks could have been inverted without a test noticing.
 *
 * The failure mode that matters: a feed request that fails, or returns
 * something unexpected, must leave the demo content in place rather than
 * blanking the landing page of a product that is trying to sell itself.
 */

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

  it('substitutes demo values for individual fields the row omits', async () => {
    // A row missing its title must not render "undefined" at a prospective
    // customer; it borrows from the bundled wedding at the same index.
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([
      serverRow({ title: undefined, host_name: undefined, venue_name: undefined }),
    ] as never);

    const { container } = renderShowcase();

    await waitFor(() => expect(eventsApi.getShowcaseFeed).toHaveBeenCalled());
    expect(container.textContent).not.toContain('undefined');
    expect(container.textContent).not.toContain('NaN');
  });

  it('falls back to demo preview photos when a row carries none', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([
      serverRow({ previewPhotos: [] }),
    ] as never);

    const { container } = renderShowcase();

    expect(await screen.findByText('Server Wedding')).toBeTruthy();
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
  });

  it('falls back when previewPhotos is missing entirely', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([
      serverRow({ previewPhotos: undefined }),
    ] as never);

    const { container } = renderShowcase();

    expect(await screen.findByText('Server Wedding')).toBeTruthy();
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
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

  it('renders a photo with no urls at all without breaking', async () => {
    vi.spyOn(eventsApi, 'getShowcaseFeed').mockResolvedValue([
      serverRow({ previewPhotos: [{ id: 'bare' }] }),
    ] as never);

    const { container } = renderShowcase();

    await screen.findByText('Server Wedding');
    expect(container.querySelectorAll('img').length).toBeGreaterThan(0);
  });

  it('cycles the demo fallbacks when the feed is longer than the bundled set', async () => {
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
