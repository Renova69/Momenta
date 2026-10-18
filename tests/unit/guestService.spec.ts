import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { i18n } from '../../src/i18n';
import {
  getCurrentGuest,
  getGuests,
  registerGuest,
  setCurrentGuest,
  syncGuestFromServer,
  clearCurrentGuest,
} from '../../src/services/guestService';
import { guestsApi } from '../../src/api/guestsApi';
import { ApiError } from '../../src/api/apiClient';
import { STORAGE_KEYS } from '../../src/services/storageKeys';
import { ServiceContext } from '../../src/services/storageServiceContext';
import { Guest, WeddingEvent } from '../../src/types';

/**
 * Who this phone is, at this wedding.
 *
 * Everything a guest does is attributed through this one record: every photo
 * they take, every like, every comment. Get it wrong and the failures are
 * quiet ones — a like that does not stick, a photo credited to nobody, a
 * second guest row for someone who only changed their name.
 *
 * A mutation sweep of this module killed 3 of 19: almost nothing here was
 * pinned by a test. The cases below are the ones a guest would actually feel.
 */

const EVENT_ID = 'eeeeeeee-5555-4666-8777-888899990000';
const OTHER_EVENT = 'ffffffff-6666-4777-8888-99990000aaaa';

function harness() {
  const notify = vi.fn();
  const ctx = {
    getEvent: () => ({ id: EVENT_ID }) as WeddingEvent,
    getPhotos: () => [],
    getQuests: () => [],
    getAudioEntries: () => [],
    getCurrentGuest: () => null,
    updateEvent: vi.fn(),
    notify,
    notifyError: vi.fn(),
    notifyEventGone: vi.fn(),
    syncGuestFromServer: vi.fn(),
    forgetGuestIdentity: vi.fn(),
    completeQuest: vi.fn(),
    joinEventRoom: vi.fn(),
    syncFromBackend: vi.fn().mockResolvedValue(undefined),
    emitReaction: vi.fn(),
  } as unknown as ServiceContext;
  return { ctx, notify };
}

const guest = (over: Partial<Guest> = {}): Guest =>
  ({
    id: 'g-local',
    eventId: EVENT_ID,
    name: 'Ana',
    createdAt: '2026-09-01T10:00:00.000Z',
    ...over,
  }) as Guest;

const storedCurrent = (eventId = EVENT_ID): Guest | null => {
  const raw = localStorage.getItem(STORAGE_KEYS.CURRENT_GUEST(eventId));
  return raw ? JSON.parse(raw) : null;
};

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => vi.restoreAllMocks());

describe('reading the guest of an event', () => {
  it('reads the event asked for, not the active one', () => {
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'here' }));
    setCurrentGuest(ctx, guest({ id: 'there', eventId: OTHER_EVENT }));

    expect(getCurrentGuest(ctx, OTHER_EVENT)?.id).toBe('there');
    expect(getCurrentGuest(ctx)?.id).toBe('here');
  });

  it('refuses a stored guest that belongs to another wedding', () => {
    // Two albums open on one phone. Attributing a photo to the guest record
    // of the other wedding is how a name ends up on a stranger's album.
    localStorage.setItem(
      STORAGE_KEYS.CURRENT_GUEST(EVENT_ID),
      JSON.stringify(guest({ id: 'g1', eventId: OTHER_EVENT }))
    );
    const { ctx } = harness();

    expect(getCurrentGuest(ctx, EVENT_ID)).toBeNull();
  });

  it('survives a corrupted record rather than taking the app down', () => {
    localStorage.setItem(STORAGE_KEYS.CURRENT_GUEST(EVENT_ID), '{not json');
    localStorage.setItem(STORAGE_KEYS.GUESTS(EVENT_ID), '{not json');
    const { ctx } = harness();

    expect(getCurrentGuest(ctx)).toBeNull();
    expect(getGuests(ctx)).toEqual([]);
  });

  it('reads the guest list of the event asked for', () => {
    localStorage.setItem(STORAGE_KEYS.GUESTS(OTHER_EVENT), JSON.stringify([guest({ id: 'other-1' })]));
    localStorage.setItem(STORAGE_KEYS.GUESTS(EVENT_ID), JSON.stringify([guest({ id: 'active-1' })]));
    const { ctx } = harness();

    expect(getGuests(ctx, OTHER_EVENT).map((g) => g.id)).toEqual(['other-1']);
    expect(getGuests(ctx).map((g) => g.id)).toEqual(['active-1']);
  });
});

describe('adopting the identity the server actually used', () => {
  it('adopts a different id and its token together', () => {
    // A stale token falls back to a fresh guest server-side. Adopting the id
    // without the token, or the other way round, leaves this phone sending a
    // pair that will be bounced from then on.
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'old', guestToken: 'old-token' }));

    syncGuestFromServer(ctx, EVENT_ID, 'new', 'new-token');

    expect(storedCurrent()).toMatchObject({ id: 'new', guestToken: 'new-token', eventId: EVENT_ID });
  });

  it('keeps the name and join time the guest already had', () => {
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'old', name: 'Ana Petrova', createdAt: '2026-09-01T10:00:00.000Z' }));

    syncGuestFromServer(ctx, EVENT_ID, 'new', 'new-token');

    expect(storedCurrent()?.name).toBe('Ana Petrova');
    expect(storedCurrent()?.createdAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('writes nothing when the pair already matches', () => {
    const { ctx, notify } = harness();
    setCurrentGuest(ctx, guest({ id: 'same', guestToken: 'same-token' }));
    notify.mockClear();

    syncGuestFromServer(ctx, EVENT_ID, 'same', 'same-token');

    expect(notify).not.toHaveBeenCalled();
  });

  it('writes when the id matches but the token has changed', () => {
    // The server reissued the credential. Keeping the old one means every
    // later action is rejected.
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'same', guestToken: 'old-token' }));

    syncGuestFromServer(ctx, EVENT_ID, 'same', 'fresh-token');

    expect(storedCurrent()?.guestToken).toBe('fresh-token');
  });

  it('ignores a response that carries an id but no token', () => {
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'old', guestToken: 'old-token' }));

    syncGuestFromServer(ctx, EVENT_ID, 'new', undefined);

    expect(storedCurrent()?.id).toBe('old');
  });

  it('starts a record from nothing when this phone has no guest yet', () => {
    const { ctx } = harness();

    syncGuestFromServer(ctx, EVENT_ID, 'new', 'new-token');

    expect(storedCurrent()).toMatchObject({ id: 'new', guestToken: 'new-token' });
    expect(storedCurrent()?.name).toBeTruthy();
  });
});

describe('registering', () => {
  const offline = () => vi.spyOn(guestsApi, 'register').mockRejectedValue(new Error('offline'));

  it('keeps the same local id when the same guest edits their name', async () => {
    // A new id here is a second guest row for one person, and their earlier
    // photos stay attributed to the old one.
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'g-existing', avatarUrl: 'data:image/png;base64,AAA' }));
    offline();

    const result = await registerGuest(ctx, 'Ana Petrova');

    expect(result.id).toBe('g-existing');
  });

  it('keeps the avatar the guest already chose when none is given', async () => {
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'g-existing', avatarUrl: 'data:image/png;base64,MINE' }));
    offline();

    const result = await registerGuest(ctx, 'Ana');

    expect(result.avatarUrl).toBe('data:image/png;base64,MINE');
  });

  it('keeps the time they first joined', async () => {
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'g-existing', createdAt: '2026-09-01T10:00:00.000Z' }));
    offline();

    const result = await registerGuest(ctx, 'Ana');

    expect(result.createdAt).toBe('2026-09-01T10:00:00.000Z');
  });

  it('names an unnamed guest rather than leaving a blank byline on every photo', async () => {
    const { ctx } = harness();
    offline();

    const result = await registerGuest(ctx, '   ');

    expect(result.name).toBe('Anonymous Guest');
  });

  it('drops a table number that is only whitespace', async () => {
    const { ctx } = harness();
    offline();

    const result = await registerGuest(ctx, 'Ana', '   ');

    expect(result.tableNumber).toBeUndefined();
  });

  it('replaces this guest in the list instead of adding a duplicate', async () => {
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'g-existing', name: 'Ana' }));
    localStorage.setItem(
      STORAGE_KEYS.GUESTS(EVENT_ID),
      JSON.stringify([guest({ id: 'g-existing', name: 'Ana' }), guest({ id: 'someone-else', name: 'Ivan' })])
    );
    offline();

    await registerGuest(ctx, 'Ana Petrova');

    const list = getGuests(ctx);
    expect(list.filter((g) => g.id === 'g-existing')).toHaveLength(1);
    expect(list.find((g) => g.id === 'g-existing')?.name).toBe('Ana Petrova');
    expect(list.find((g) => g.id === 'someone-else')?.name).toBe('Ivan');
  });

  it('falls back to the local identity when the server cannot be reached', async () => {
    const { ctx } = harness();
    offline();

    const result = await registerGuest(ctx, 'Ana');

    expect(result.id.startsWith('guest-')).toBe(true);
    expect(storedCurrent()?.name).toBe('Ana');
  });

  it('keeps the local identity when the server answers without an id', async () => {
    const { ctx } = harness();
    vi.spyOn(guestsApi, 'register').mockResolvedValue({} as Guest);

    const result = await registerGuest(ctx, 'Ana');

    expect(result.id.startsWith('guest-')).toBe(true);
  });

  it('does not carry a token across to a different guest id', async () => {
    // A token is bound to one guestId and proves nothing about another. The
    // server gave this phone a new identity; the old credential goes with the
    // old one.
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'g-old', guestToken: 'old-token' }));
    vi.spyOn(guestsApi, 'register').mockResolvedValue({
      id: 'g-new',
      eventId: EVENT_ID,
      name: 'Ana',
      createdAt: new Date().toISOString(),
    } as Guest);

    const result = await registerGuest(ctx, 'Ana');

    expect(result.id).toBe('g-new');
    expect(result.guestToken).toBeUndefined();
  });
});

describe('forgetting an identity the server no longer accepts', () => {
  it('removes it so the guest is sent back through onboarding', () => {
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'g1', guestToken: 'dead' }));

    clearCurrentGuest(ctx, EVENT_ID);

    expect(storedCurrent()).toBeNull();
  });

  it('leaves the other wedding on this phone alone', () => {
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'here' }));
    setCurrentGuest(ctx, guest({ id: 'there', eventId: OTHER_EVENT }));

    clearCurrentGuest(ctx, EVENT_ID);

    expect(storedCurrent(OTHER_EVENT)?.id).toBe('there');
  });

  it('does nothing without an event to forget', () => {
    const { ctx, notify } = harness();
    setCurrentGuest(ctx, guest({ id: 'g1' }));
    notify.mockClear();

    clearCurrentGuest(ctx, '');

    expect(storedCurrent()?.id).toBe('g1');
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('a selfie (N-107)', () => {
  const SELFIE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ';
  const STORED = `http://localhost:6501/uploads/events/${EVENT_ID}/avatar-1-ana.jpg`;

  const registered = (over: Partial<Guest> = {}) =>
    vi.spyOn(guestsApi, 'register').mockResolvedValue({
      id: 'g-new',
      eventId: EVENT_ID,
      name: 'Ana',
      createdAt: new Date().toISOString(),
      guestToken: 'tok',
      ...over,
    } as Guest);

  it('joins without the picture, then stores the picture as the guest it just became', async () => {
    // The picture used to travel inside the registration as a data: URL. The
    // server's cap refused the whole request, so the guest never existed and
    // every like, comment and photo after it was refused too.
    const { ctx } = harness();
    const register = registered();
    const setAvatar = vi.spyOn(guestsApi, 'setAvatar').mockResolvedValue({ avatarUrl: STORED });

    const result = await registerGuest(ctx, 'Ana', undefined, SELFIE);

    expect(register.mock.calls[0][0].avatarUrl).toBeUndefined();
    expect(setAvatar).toHaveBeenCalledWith('g-new', { eventId: EVENT_ID, guestToken: 'tok', image: SELFIE });
    expect(result.avatarUrl).toBe(STORED);
    expect(storedCurrent()?.avatarUrl).toBe(STORED);
    expect(storedCurrent()?.guestToken).toBe('tok');
  });

  it('stays joined and says so when the picture cannot be stored', async () => {
    const { ctx } = harness();
    registered();
    vi.spyOn(guestsApi, 'setAvatar').mockRejectedValue(new Error('500'));

    const result = await registerGuest(ctx, 'Ana', undefined, SELFIE);

    expect(result.id).toBe('g-new');
    expect(result.guestToken).toBe('tok');
    expect(result.avatarUrl).toBeUndefined();
    expect(ctx.notifyError).toHaveBeenCalledTimes(1);
  });

  it('keeps a picture already stored, without sending it again', async () => {
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'g-new', guestToken: 'tok', avatarUrl: STORED }));
    const register = registered({ avatarUrl: STORED });
    const setAvatar = vi.spyOn(guestsApi, 'setAvatar');

    const result = await registerGuest(ctx, 'Ana Petrova');

    expect(register.mock.calls[0][0].avatarUrl).toBeUndefined();
    expect(setAvatar).not.toHaveBeenCalled();
    expect(result.avatarUrl).toBe(STORED);
  });

  it('stores a picture taken offline once the server first gives this phone an identity', async () => {
    // Joined with no connection: the guest exists only here, holding the
    // picture. Their first upload is what creates them on the server, and the
    // picture should follow then rather than never.
    const { ctx } = harness();
    setCurrentGuest(ctx, guest({ id: 'guest-123', avatarUrl: SELFIE }));
    const setAvatar = vi.spyOn(guestsApi, 'setAvatar').mockResolvedValue({ avatarUrl: STORED });

    syncGuestFromServer(ctx, EVENT_ID, 'g-srv', 'tok');

    await vi.waitFor(() => expect(storedCurrent()?.avatarUrl).toBe(STORED));
    expect(setAvatar).toHaveBeenCalledWith('g-srv', { eventId: EVENT_ID, guestToken: 'tok', image: SELFIE });
  });
});

describe('a guest the server named before this phone did (N-125)', () => {
  it("is called by the app's word for a guest, not the English one", () => {
    const { ctx } = harness();

    syncGuestFromServer(ctx, EVENT_ID, 'g-srv', 'tok');

    expect(storedCurrent()?.name).toBe(i18n.t('guest.fallback_name'));
  });
});

// N-183 — a guest joining a closed album with a selfie was told to try the
// selfie again from their profile, which a closed album can never accept.
describe('a selfie refused by a closed album (N-183)', () => {
  const SELFIE = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQ';

  it('says the album has closed, not to try again', async () => {
    const { ctx } = harness();
    vi.spyOn(guestsApi, 'register').mockResolvedValue({
      id: 'g-new',
      eventId: EVENT_ID,
      name: 'Ana',
      createdAt: new Date().toISOString(),
      guestToken: 'tok',
    } as Guest);
    vi.spyOn(guestsApi, 'setAvatar').mockRejectedValue(new ApiError('closed', 403, undefined, 'ALBUM_CLOSED'));

    await registerGuest(ctx, 'Ana', undefined, SELFIE);

    expect(ctx.notifyError).toHaveBeenCalledWith(i18n.t('error.album_closed'));
  });
});
