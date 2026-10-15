import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { AppProvider, useApp } from '../../src/context/AppContext';
import { storageService } from '../../src/services/storageService';
import { router } from '../../src/router';
import type { WeddingEvent } from '../../src/types';

/**
 * Opening an album link, as a guest's phone does.
 *
 * N-136 — the loading screen stayed up until the album's photos, quests,
 * voice messages and poster layout had all arrived, though the album's own
 * record (all the page's top needs) was in a round trip earlier.
 *
 * N-137 — before the loading screen, the first render showed the built-in
 * demo album: another couple's names for a frame, and its cover requested
 * from a third party.
 */

const DEMO = { id: 'demo', slug: 'demo-wedding', title: 'Demo' } as WeddingEvent;
const ALBUM = { id: 'e1', slug: 'mira-i-daniel', title: 'Мира и Даниел' } as WeddingEvent;

type Seen = { slug: string; isLoadingEvent: boolean; isSyncingAlbum: boolean };

function Probe({ seen }: { seen: Seen[] }) {
  const { event, isLoadingEvent, isSyncingAlbum } = useApp();
  seen.push({ slug: event.slug, isLoadingEvent, isSyncingAlbum });
  return null;
}

/** Open `/e/mira-i-daniel` on a phone that has only the demo album cached. */
function openAlbumLink() {
  let current = DEMO;
  let notify: () => void = () => undefined;
  let finishSync: () => void = () => undefined;

  vi.spyOn(router, 'getRoute').mockReturnValue({ view: 'guest', slug: ALBUM.slug, subTab: 'feed' });
  vi.spyOn(storageService, 'getEvent').mockImplementation(() => current);
  vi.spyOn(storageService, 'subscribe').mockImplementation((listener: () => void) => {
    notify = listener;
    return () => undefined;
  });
  vi.spyOn(storageService, 'loadEventBySlug').mockImplementation(
    () => new Promise((resolve) => (finishSync = () => resolve(ALBUM)))
  );

  const seen: Seen[] = [];
  render(
    <AppProvider>
      <Probe seen={seen} />
    </AppProvider>
  );

  return {
    seen,
    /** The album's record arrives; its photos and the rest are still on the way. */
    recordArrives: () =>
      act(() => {
        current = ALBUM;
        notify();
      }),
    syncFinishes: () =>
      act(async () => {
        finishSync();
      }),
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('opening an album link', () => {
  it('never shows the demo album, not even for the first frame (N-137)', () => {
    const { seen } = openAlbumLink();

    expect(seen[0]).toMatchObject({ slug: DEMO.slug, isLoadingEvent: true });
  });

  it('shows the album as soon as its record arrives (N-136)', () => {
    const { seen, recordArrives } = openAlbumLink();

    recordArrives();

    expect(seen.at(-1)).toEqual({ slug: ALBUM.slug, isLoadingEvent: false, isSyncingAlbum: true });
  });

  it('says when the rest of the album has arrived too', async () => {
    const { seen, recordArrives, syncFinishes } = openAlbumLink();

    recordArrives();
    await syncFinishes();

    expect(seen.at(-1)).toEqual({ slug: ALBUM.slug, isLoadingEvent: false, isSyncingAlbum: false });
  });
});
