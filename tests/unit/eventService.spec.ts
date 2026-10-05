import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getEvent,
  updateEvent,
  upgradePlanTier,
  refreshEventFromBackend,
  refreshEventDetails,
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

  // N-62 — the server may store a different address than the one asked for
  // (taken, or reserved after a deletion). The answer used to be discarded,
  // so the QR studio, the projector and every PDF kept the requested one.
  it('adopts the address the server actually stored, and says so', async () => {
    const { ctx, notifyError, updateEventSpy } = makeContext();
    vi.spyOn(eventsApi, 'update').mockResolvedValue({ id: EVENT_ID, slug: 'anna-x7k21' } as never);

    updateEvent(ctx, { slug: 'anna' });
    await vi.waitFor(() => expect(updateEventSpy).toHaveBeenCalled());

    expect(updateEventSpy).toHaveBeenCalledWith({ slug: 'anna-x7k21' }, false);
    expect(notifyError).toHaveBeenCalledTimes(1);
    expect(String(notifyError.mock.calls[0][0])).toContain('anna-x7k21');
  });

  it('says nothing when the server stored the address as asked', async () => {
    const { ctx, notifyError, updateEventSpy } = makeContext();
    const update = vi.spyOn(eventsApi, 'update').mockResolvedValue({ id: EVENT_ID, slug: 'anna' } as never);

    updateEvent(ctx, { slug: 'anna' });
    await vi.waitFor(() => expect(update).toHaveBeenCalled());
    await Promise.resolve();

    expect(updateEventSpy).not.toHaveBeenCalled();
    expect(notifyError).not.toHaveBeenCalled();
  });

  it('rolls back a refused rename by asking for the album at its old address', async () => {
    const { ctx } = makeContext();
    vi.spyOn(eventsApi, 'update').mockRejectedValue(new Error('slug too short'));
    const getBySlug = vi.spyOn(eventsApi, 'getBySlug').mockResolvedValue(null as never);

    updateEvent(ctx, { slug: 'ab' });
    await vi.waitFor(() => expect(getBySlug).toHaveBeenCalled());

    expect(getBySlug).toHaveBeenCalledWith('ivan-and-maria');
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

/**
 * N-54 — the post-checkout banner polls the album every few seconds while a
 * purchase settles. Through loadEventBySlug that meant the app's full-screen
 * spinner and a jump to the guest feed on every poll, plus a full feed sync.
 * This refresh re-reads the album record and nothing else.
 */
describe('refreshEventDetails (N-54)', () => {
  it('updates the album record without joining the room or syncing the feed', async () => {
    const { ctx, joinEventRoom, syncFromBackend, updateEventSpy } = makeContext();
    vi.spyOn(eventsApi, 'getBySlug').mockResolvedValue({
      id: EVENT_ID, slug: 'ivan-and-maria', plan_tier: 'celebration_pass',
    } as never);

    await refreshEventDetails(ctx);

    expect(updateEventSpy).toHaveBeenCalledWith(expect.objectContaining({ id: EVENT_ID }), false);
    expect(joinEventRoom).not.toHaveBeenCalled();
    expect(syncFromBackend).not.toHaveBeenCalled();
  });

  it('swallows a failed attempt; the next poll asks again', async () => {
    const { ctx, updateEventSpy } = makeContext();
    vi.spyOn(eventsApi, 'getBySlug').mockRejectedValue(new Error('offline'));

    await expect(refreshEventDetails(ctx)).resolves.toBeUndefined();
    expect(updateEventSpy).not.toHaveBeenCalled();
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

  it('returns null and warns when the album does not exist', async () => {
    const { ctx } = makeContext();
    vi.spyOn(eventsApi, 'getBySlug').mockRejectedValue(
      Object.assign(new Error('Event not found'), { status: 404 })
    );

    expect(await loadEventBySlug(ctx, 'missing')).toBeNull();
    expect(console.warn).toHaveBeenCalled();
  });

  it('raises when the server could not be asked, rather than reporting no such album', async () => {
    // A guest at a venue with weak wifi has a perfectly good QR code.
    // Collapsing every failure into "not found" sent them to a dead end
    // telling them their wedding does not exist.
    const { ctx } = makeContext();
    vi.spyOn(eventsApi, 'getBySlug').mockRejectedValue(
      Object.assign(new Error('Failed to fetch'), { status: 503 })
    );

    await expect(loadEventBySlug(ctx, 'real-wedding')).rejects.toThrow('Failed to fetch');
  });

  it('raises for a network error that carries no status at all', async () => {
    const { ctx } = makeContext();
    vi.spyOn(eventsApi, 'getBySlug').mockRejectedValue(new TypeError('NetworkError'));

    await expect(loadEventBySlug(ctx, 'real-wedding')).rejects.toThrow('NetworkError');
  });
});
