import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getEvent,
  updateEvent,
  upgradePlanTier,
  refreshEventFromBackend,
  refreshEventDetails,
  setCover,
  removeCover,
  loadEventBySlug,
  openSignedInAlbum,
  forgetEvent,
  ensureOwnAlbum,
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

  // N-109 — switching disposable mode on is when the server sets the reveal,
  // so the answer carries it and the studio has to take it from there.
  it('adopts the reveal time the server set when disposable mode is switched on', async () => {
    const { ctx, updateEventSpy } = makeContext();
    vi.spyOn(eventsApi, 'update').mockResolvedValue({
      id: EVENT_ID,
      slug: 'ivan-and-maria',
      reveal_at: '2027-06-13T06:00:00.000Z',
    } as never);

    updateEvent(ctx, { isDisposableMode: true });
    await vi.waitFor(() => expect(updateEventSpy).toHaveBeenCalled());

    expect(updateEventSpy).toHaveBeenCalledWith({ revealAt: '2027-06-13T06:00:00.000Z' }, false);
  });

  it('adopts a cleared reveal when disposable mode is switched off', async () => {
    const { ctx, updateEventSpy } = makeContext();
    vi.spyOn(eventsApi, 'update').mockResolvedValue({ id: EVENT_ID, slug: 'ivan-and-maria', reveal_at: null } as never);

    updateEvent(ctx, { isDisposableMode: false });
    await vi.waitFor(() => expect(updateEventSpy).toHaveBeenCalled());

    expect(updateEventSpy).toHaveBeenCalledWith({ revealAt: null }, false);
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

    // With the open album, which a one-time pass is bought for (N-169).
    expect(upgrade).toHaveBeenCalledWith('pro_planner', 'ivan-and-maria');
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

  // N-139 — the cover is set through its own route, which stores the picture;
  // the album is then updated here without a save of its own.
  it('sets a cover through the cover route, and shows it without another save', async () => {
    const { ctx, updateEventSpy } = makeContext();
    storeEvent({ id: EVENT_ID, slug: 'album-a' });
    const setCoverSpy = vi.spyOn(eventsApi, 'setCover').mockResolvedValue({ coverImageUrl: 'https://cdn.example/cover-1-abc.jpg' });
    const updateSpy = vi.spyOn(eventsApi, 'update');

    await setCover(ctx, { photoId: 'p1' });

    expect(setCoverSpy).toHaveBeenCalledWith(EVENT_ID, { photoId: 'p1' });
    expect(updateEventSpy).toHaveBeenCalledWith({ coverImageUrl: 'https://cdn.example/cover-1-abc.jpg' }, false);
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('removes a cover the same way', async () => {
    const { ctx, updateEventSpy } = makeContext();
    storeEvent({ id: EVENT_ID, slug: 'album-a' });
    const removeSpy = vi.spyOn(eventsApi, 'removeCover').mockResolvedValue({ coverImageUrl: null });

    await removeCover(ctx);

    expect(removeSpy).toHaveBeenCalledWith(EVENT_ID);
    expect(updateEventSpy).toHaveBeenCalledWith({ coverImageUrl: '' }, false);
  });

  // N-148 — it now also runs as the app starts, while a link to another album
  // may be opening. An answer for the album that was open when it asked must
  // not be written over the one open when it arrives.
  it('drops the answer if another album was opened while it was on its way', async () => {
    const { ctx, updateEventSpy } = makeContext();
    storeEvent({ id: EVENT_ID, slug: 'album-a' });
    vi.spyOn(eventsApi, 'getBySlug').mockImplementation(async () => {
      storeEvent({ id: 'cccccccc-3333-4444-8555-666677778888', slug: 'album-b' });
      return { id: EVENT_ID, slug: 'album-a', title: 'A' } as never;
    });

    await refreshEventDetails(ctx);

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

/**
 * N-110 — after signing in, the studio showed the demo wedding's data.
 *
 * The sign-in answer's raw row (snake_case) was merged over whatever album
 * this browser had cached, so the camelCase fields the studio reads kept the
 * cached values — on a fresh browser, the demo couple, a past date and their
 * venue — and the merge was then PUT back to the server on every sign-in.
 */
describe('opening the album a host just signed in to (N-110)', () => {
  const signedIn = {
    id: 'cccccccc-3333-4444-8555-666677778888',
    slug: 'iva-i-petar-2026',
    title: "Ива и Петър's Wedding",
    host_name: 'Ива и Петър',
    event_date: '2026-11-13T05:20:48.173Z',
    venue_name: 'Голяма зала',
  };

  beforeEach(() => storeEvent({ ...INITIAL_EVENT }));

  it('reads the album from the server, without writing anything back', async () => {
    const { ctx, updateEventSpy, joinEventRoom } = makeContext();
    const getBySlug = vi.spyOn(eventsApi, 'getBySlug').mockResolvedValue({
      ...signedIn,
      is_moderation_enabled: true,
      is_public: true,
    } as never);
    const update = vi.spyOn(eventsApi, 'update');

    await openSignedInAlbum(ctx, signedIn);

    expect(getBySlug).toHaveBeenCalledWith('iva-i-petar-2026');
    const adopted = updateEventSpy.mock.calls[0][0];
    expect(adopted.hostName).toBe('Ива и Петър');
    expect(adopted.eventDate).toBe('2026-11-13T05:20:48.173Z');
    expect(adopted.isModerationEnabled).toBe(true);
    expect(adopted.isPublic).toBe(true);
    expect(updateEventSpy.mock.calls[0][1]).toBe(false);
    expect(joinEventRoom).toHaveBeenCalledWith(signedIn.id);
    expect(update).not.toHaveBeenCalled();
  });

  it('falls back to the sign-in answer, read properly, when the album cannot be fetched', async () => {
    const { ctx, updateEventSpy } = makeContext();
    vi.spyOn(eventsApi, 'getBySlug').mockRejectedValue(new Error('offline'));
    const update = vi.spyOn(eventsApi, 'update');

    await openSignedInAlbum(ctx, signedIn);

    const adopted = updateEventSpy.mock.calls[0][0];
    expect(adopted.id).toBe(signedIn.id);
    expect(adopted.hostName).toBe('Ива и Петър');
    expect(adopted.venueName).toBe('Голяма зала');
    expect(updateEventSpy.mock.calls[0][1]).toBe(false);
    expect(update).not.toHaveBeenCalled();
  });
});

/**
 * N-119 and N-120 — the studio showed whatever album this browser had cached:
 * the demo wedding after "reset local data", and an album the host had just
 * deleted. Edits to either were refused with an English "Forbidden".
 */
describe('the album the studio opens (N-119, N-120)', () => {
  const HOST = 'host-1111';
  const own = (over: Record<string, unknown> = {}) => ({
    id: 'dddddddd-4444-4555-8666-777788889999',
    slug: 'own-album',
    title: 'Own',
    host_name: 'Own Couple',
    host_user_id: HOST,
    ...over,
  });

  it('keeps an album the host owns', async () => {
    storeEvent({ id: EVENT_ID, slug: 'mine', hostUserId: HOST });
    const { ctx } = makeContext();
    const listMine = vi.spyOn(eventsApi, 'listMine');

    expect(await ensureOwnAlbum(ctx, HOST)).toBe('kept');
    expect(listMine).not.toHaveBeenCalled();
  });

  it("opens the host's latest album instead of one they do not own", async () => {
    storeEvent({ ...INITIAL_EVENT });
    const { ctx, updateEventSpy } = makeContext();
    vi.spyOn(eventsApi, 'listMine').mockResolvedValue([{ id: own().id, slug: 'own-album', hostUserId: HOST } as never]);
    vi.spyOn(eventsApi, 'getBySlug').mockResolvedValue(own() as never);

    expect(await ensureOwnAlbum(ctx, HOST)).toBe('opened');
    expect(updateEventSpy.mock.calls[0][0].hostName).toBe('Own Couple');
  });

  it('keeps the album shown when the server lists it as the host\'s, even without an owner cached', async () => {
    storeEvent({ id: EVENT_ID, slug: 'mine-old-cache' });
    const { ctx } = makeContext();
    vi.spyOn(eventsApi, 'listMine').mockResolvedValue([
      { id: 'newer', slug: 'newer' } as never,
      { id: EVENT_ID, slug: 'mine-old-cache' } as never,
    ]);
    const getBySlug = vi.spyOn(eventsApi, 'getBySlug').mockResolvedValue({ id: EVENT_ID, slug: 'mine-old-cache' } as never);

    await ensureOwnAlbum(ctx, HOST);

    expect(getBySlug).toHaveBeenCalledWith('mine-old-cache');
  });

  it('says so when the host has no album at all', async () => {
    storeEvent({ ...INITIAL_EVENT });
    const { ctx } = makeContext();
    vi.spyOn(eventsApi, 'listMine').mockResolvedValue([]);

    expect(await ensureOwnAlbum(ctx, HOST)).toBe('none');
  });

  it('forgets a deleted album, so nothing opens it from the cache', () => {
    storeEvent({ id: EVENT_ID, slug: 'gone' });
    localStorage.setItem(STORAGE_KEYS.PHOTOS(EVENT_ID), '[]');
    localStorage.setItem(STORAGE_KEYS.QR_CANVAS(EVENT_ID), '{}');

    forgetEvent(EVENT_ID);

    expect(localStorage.getItem(STORAGE_KEYS.EVENT(EVENT_ID))).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.PHOTOS(EVENT_ID))).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.QR_CANVAS(EVENT_ID))).toBeNull();
    expect(localStorage.getItem(STORAGE_KEYS.ACTIVE_EVENT_ID)).toBeNull();
  });
});
