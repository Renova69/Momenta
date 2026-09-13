import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getEvent,
  updateEvent,
  upgradePlanTier,
  refreshEventFromBackend,
  loadEventBySlug,
} from '../../src/services/eventService';
import { eventsApi } from '../../src/api/eventsApi';
import { subscriptionsApi } from '../../src/api/subscriptionsApi';
import { STORAGE_KEYS } from '../../src/services/storageKeys';
import { INITIAL_EVENT } from '../../src/services/defaultEvent';
import { ServiceContext } from '../../src/services/storageServiceContext';

/**
 * Reading and writing the active event.
 *
 * `getEvent` is the single place the app resolves "which wedding am I looking
 * at", out of localStorage that may have been written by an older build, by a
 * server response in a different casing, or corrupted. It has to return
 * something usable in every one of those cases, because everything downstream
 * assumes it did.
 *
 * The other half is the rule that a rejected server write must not leave the
 * host looking at a change that did not happen — an expired session, or a
 * tier-gated setting they are not entitled to.
 */

const EVENT_ID = 'bbbbbbbb-2222-4333-8444-555566667777';

function makeContext() {
  const notify = vi.fn();
  const notifyError = vi.fn();
  const joinEventRoom = vi.fn();
  const syncFromBackend = vi.fn().mockResolvedValue(undefined);
  const updateEventSpy = vi.fn();
  const ctx = {
    getEvent: () => getEvent(),
    getPhotos: () => [],
    getQuests: () => [],
    getAudioEntries: () => [],
    getCurrentGuest: () => null,
    updateEvent: updateEventSpy,
    notify,
    notifyError,
    syncGuestFromServer: vi.fn(),
    completeQuest: vi.fn(),
    joinEventRoom,
    syncFromBackend,
    emitReaction: vi.fn(),
  } as unknown as ServiceContext;
  return { ctx, notify, notifyError, joinEventRoom, syncFromBackend, updateEventSpy };
}

function storeEvent(raw: Record<string, unknown>) {
  localStorage.setItem(STORAGE_KEYS.ACTIVE_EVENT_ID, String(raw.id ?? EVENT_ID));
  localStorage.setItem(STORAGE_KEYS.EVENT(String(raw.id ?? EVENT_ID)), JSON.stringify(raw));
}

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('getEvent', () => {
  it('returns the bundled default when nothing is active', () => {
    expect(getEvent()).toEqual(INITIAL_EVENT);
  });

  it('returns the default when the active id points at nothing', () => {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_EVENT_ID, EVENT_ID);
    expect(getEvent()).toEqual(INITIAL_EVENT);
  });

  it('returns the default rather than throwing on corrupt JSON', () => {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_EVENT_ID, EVENT_ID);
    localStorage.setItem(STORAGE_KEYS.EVENT(EVENT_ID), '{not json');
    expect(getEvent()).toEqual(INITIAL_EVENT);
  });

  it('returns the default for a stored object with neither id nor slug', () => {
    storeEvent({ id: EVENT_ID });
    localStorage.setItem(STORAGE_KEYS.EVENT(EVENT_ID), JSON.stringify({ title: 'orphan' }));
    expect(getEvent()).toEqual(INITIAL_EVENT);
  });

  it('accepts a record carrying only a slug', () => {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_EVENT_ID, EVENT_ID);
    localStorage.setItem(STORAGE_KEYS.EVENT(EVENT_ID), JSON.stringify({ slug: 'only-slug' }));
    expect(getEvent().slug).toBe('only-slug');
  });

  it('reads snake_case written by an older build or a raw server response', () => {
    storeEvent({
      id: EVENT_ID,
      slug: 's',
      host_name: 'Snake Host',
      event_date: '2026-01-02',
      theme_palette: 'rose_quartz',
      venue_name: 'Snake Venue',
      welcome_message: 'Snake welcome',
      plan_tier: 'deluxe_keepsake',
      is_moderation_enabled: true,
      is_disposable_mode: true,
      is_public: true,
    });

    expect(getEvent()).toMatchObject({
      hostName: 'Snake Host',
      eventDate: '2026-01-02',
      themePalette: 'rose_quartz',
      venueName: 'Snake Venue',
      welcomeMessage: 'Snake welcome',
      planTier: 'deluxe_keepsake',
      isModerationEnabled: true,
      isDisposableMode: true,
      isPublic: true,
    });
  });

  it('prefers camelCase over every legacy spelling', () => {
    storeEvent({
      id: EVENT_ID, slug: 's',
      hostName: 'camel', coupleNames: 'legacy2', couple_names: 'legacy1', host_name: 'snake',
      eventDate: '2026-01-01', date: '2025-01-01', event_date: '2024-01-01',
    });

    expect(getEvent()).toMatchObject({ hostName: 'camel', eventDate: '2026-01-01' });
  });

  it('walks the hostName fallbacks in order', () => {
    storeEvent({ id: EVENT_ID, slug: 's', couple_names: 'legacy1', coupleNames: 'legacy2', host_name: 'snake' });
    expect(getEvent().hostName).toBe('legacy1');

    localStorage.clear();
    storeEvent({ id: EVENT_ID, slug: 's', coupleNames: 'legacy2', host_name: 'snake' });
    expect(getEvent().hostName).toBe('legacy2');

    localStorage.clear();
    storeEvent({ id: EVENT_ID, slug: 's', host_name: 'snake' });
    expect(getEvent().hostName).toBe('snake');
  });

  it('carries an explicit false through rather than defaulting it', () => {
    storeEvent({ id: EVENT_ID, slug: 's', isPublic: false, is_public: true });
    expect(getEvent().isPublic).toBe(false);
  });
});

describe('updateEvent', () => {
  beforeEach(() => storeEvent({ id: EVENT_ID, slug: 'ivan-and-maria', title: 'Before' }));

  it('writes through, stamps updatedAt and marks the event active', () => {
    const { ctx, notify } = makeContext();
    vi.spyOn(eventsApi, 'update').mockResolvedValue({} as never);

    const out = updateEvent(ctx, { title: 'After' });

    expect(out.title).toBe('After');
    expect(out.updatedAt).toBeTruthy();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_EVENT_ID)).toBe(EVENT_ID);
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.EVENT(EVENT_ID))!).title).toBe('After');
    expect(notify).toHaveBeenCalled();
  });

  it('syncs to the server by default', () => {
    const { ctx } = makeContext();
    const update = vi.spyOn(eventsApi, 'update').mockResolvedValue({} as never);

    updateEvent(ctx, { title: 'After' });

    expect(update).toHaveBeenCalledWith(EVENT_ID, { title: 'After' });
  });

  it('skips the server when told to, which is the broadcast-applying case', () => {
    const { ctx } = makeContext();
    const update = vi.spyOn(eventsApi, 'update');

    updateEvent(ctx, { title: 'From a broadcast' }, false);

    // Echoing a server broadcast straight back at the server is a loop.
    expect(update).not.toHaveBeenCalled();
  });

  it('reports a rejected write and re-reads the authoritative state', async () => {
    // Otherwise the host keeps looking at a setting the server refused - an
    // expired session, or a tier-gated toggle they are not entitled to.
    const { ctx, notifyError } = makeContext();
    vi.spyOn(eventsApi, 'update').mockRejectedValue(new Error('Tier required'));
    const getBySlug = vi.spyOn(eventsApi, 'getBySlug').mockResolvedValue(null as never);

    updateEvent(ctx, { isDisposableMode: true });
    await vi.waitFor(() => expect(notifyError).toHaveBeenCalledWith('Tier required'));
    await vi.waitFor(() => expect(getBySlug).toHaveBeenCalledWith('ivan-and-maria'));
  });
});

describe('upgradePlanTier', () => {
  it('asks the server, then re-reads rather than claiming the tier locally', async () => {
    storeEvent({ id: EVENT_ID, slug: 'ivan-and-maria', planTier: 'free' });
    const { ctx } = makeContext();
    const upgrade = vi.spyOn(subscriptionsApi, 'upgrade').mockResolvedValue({} as never);
    const getBySlug = vi.spyOn(eventsApi, 'getBySlug').mockResolvedValue(null as never);

    await upgradePlanTier(ctx, 'pro_planner');

    expect(upgrade).toHaveBeenCalledWith('pro_planner');
    // The server's copy is the only thing tier gating trusts.
    expect(getBySlug).toHaveBeenCalled();
  });

  it('propagates a refused upgrade instead of showing it as applied', async () => {
    storeEvent({ id: EVENT_ID, slug: 'ivan-and-maria' });
    const { ctx } = makeContext();
    vi.spyOn(subscriptionsApi, 'upgrade').mockRejectedValue(new Error('Payment required'));

    await expect(upgradePlanTier(ctx, 'pro_planner')).rejects.toThrow('Payment required');
  });
});

describe('refreshEventFromBackend', () => {
  it('uses the default event slug when nothing has been stored yet', async () => {
    // getEvent() falls back to INITIAL_EVENT, which carries a slug, so the
    // guard in refreshEventFromBackend is for a stored record that lacks one
    // rather than for a cold start.
    const { ctx } = makeContext();
    const getBySlug = vi.spyOn(eventsApi, 'getBySlug').mockResolvedValue(null as never);

    await refreshEventFromBackend(ctx);

    expect(getBySlug).toHaveBeenCalledWith(INITIAL_EVENT.slug);
  });

  it('does nothing when the stored event has no slug at all', async () => {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_EVENT_ID, EVENT_ID);
    localStorage.setItem(STORAGE_KEYS.EVENT(EVENT_ID), JSON.stringify({ id: EVENT_ID, slug: '' }));
    const { ctx } = makeContext();
    const getBySlug = vi.spyOn(eventsApi, 'getBySlug');

    await refreshEventFromBackend(ctx);

    expect(getBySlug).not.toHaveBeenCalled();
  });

  it('keeps the local copy when the network is down', async () => {
    storeEvent({ id: EVENT_ID, slug: 'ivan-and-maria' });
    const { ctx } = makeContext();
    vi.spyOn(eventsApi, 'getBySlug').mockRejectedValue(new Error('offline'));

    await expect(refreshEventFromBackend(ctx)).resolves.toBeUndefined();
  });
});

describe('loadEventBySlug', () => {
  it('returns null for an empty slug without calling the API', async () => {
    const { ctx } = makeContext();
    const getBySlug = vi.spyOn(eventsApi, 'getBySlug');

    expect(await loadEventBySlug(ctx, '')).toBeNull();
    expect(getBySlug).not.toHaveBeenCalled();
  });

  it('normalizes, stores, joins the room and syncs', async () => {
    const { ctx, joinEventRoom, syncFromBackend, updateEventSpy } = makeContext();
    vi.spyOn(eventsApi, 'getBySlug').mockResolvedValue({
      id: EVENT_ID, slug: 'ivan-and-maria', host_name: 'Snake Host',
    } as never);

    const out = await loadEventBySlug(ctx, 'ivan-and-maria');

    expect(out).toMatchObject({ id: EVENT_ID, hostName: 'Snake Host' });
    // Stored without syncing back: this came from the server.
    expect(updateEventSpy).toHaveBeenCalledWith(expect.objectContaining({ id: EVENT_ID }), false);
    expect(joinEventRoom).toHaveBeenCalledWith(EVENT_ID);
    expect(syncFromBackend).toHaveBeenCalledWith(EVENT_ID);
  });

  it('returns null when the response carries neither id nor slug', async () => {
    const { ctx, joinEventRoom } = makeContext();
    vi.spyOn(eventsApi, 'getBySlug').mockResolvedValue({ title: 'nothing useful' } as never);

    expect(await loadEventBySlug(ctx, 'x')).toBeNull();
    expect(joinEventRoom).not.toHaveBeenCalled();
  });

  it('returns null for a null response', async () => {
    const { ctx } = makeContext();
    vi.spyOn(eventsApi, 'getBySlug').mockResolvedValue(null as never);
    expect(await loadEventBySlug(ctx, 'x')).toBeNull();
  });

  it('returns null and warns when the lookup fails', async () => {
    const { ctx } = makeContext();
    vi.spyOn(eventsApi, 'getBySlug').mockRejectedValue(new Error('404'));

    expect(await loadEventBySlug(ctx, 'missing')).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });
});
