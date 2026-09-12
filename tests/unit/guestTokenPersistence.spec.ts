import { describe, it, expect, beforeEach, vi } from 'vitest';
import { storageService } from '../../src/services/storageService';
import { guestsApi } from '../../src/api/guestsApi';
import { STORAGE_KEYS } from '../../src/services/storageKeys';
import { Guest } from '../../src/types';

/**
 * H2 — the guest token must survive a repeat registration.
 *
 * POST /api/guests only returns a `guestToken` when the caller actually
 * proved the identity is theirs — a genuinely new row (`xmax = 0`). That is
 * deliberate (SEC-03): matching a leaked, client-generated device
 * fingerprint must not hand out a durable credential for someone else.
 *
 * The consequence on this side is that the *second* registration for the
 * same device — a guest reopening the profile modal to change their name —
 * legitimately comes back with no token. Overwriting the stored guest with
 * that response drops the token the browser already held, and from then on
 * every like/comment/reaction is rejected with GUEST_TOKEN_REQUIRED. The
 * client swallows those, so the failure is invisible: the optimistic UI
 * shows the like and it silently never persists.
 */
describe('guest token persistence across re-registration (H2)', () => {
  const EVENT_ID = '4c1f0e6a-2f3b-4b7e-9a1d-2b6c8e0f1a22';
  const GUEST_ID = '7b2e1c44-9d3a-4f0e-8c5b-1a2d3e4f5a66';

  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
    storageService.updateEvent({ id: EVENT_ID, slug: 'token-persistence' }, false);
  });

  function storedGuest(): Guest | null {
    const raw = localStorage.getItem(STORAGE_KEYS.CURRENT_GUEST(EVENT_ID));
    return raw ? (JSON.parse(raw) as Guest) : null;
  }

  it('keeps the token from the first registration when the second returns none', async () => {
    vi.spyOn(guestsApi, 'register').mockResolvedValueOnce({
      id: GUEST_ID,
      eventId: EVENT_ID,
      name: 'Ivan',
      createdAt: new Date().toISOString(),
      guestToken: 'guest-token-first',
    } as Guest);

    await storageService.registerGuest('Ivan');
    expect(storedGuest()?.guestToken).toBe('guest-token-first');

    // Same device registering again: the server upserts onto the existing row,
    // so identity was never re-proven and no token comes back.
    vi.spyOn(guestsApi, 'register').mockResolvedValueOnce({
      id: GUEST_ID,
      eventId: EVENT_ID,
      name: 'Ivan Petrov',
      createdAt: new Date().toISOString(),
    } as Guest);

    const result = await storageService.registerGuest('Ivan Petrov');

    expect(storedGuest()?.name).toBe('Ivan Petrov');
    expect(storedGuest()?.guestToken).toBe('guest-token-first');
    expect(result.guestToken).toBe('guest-token-first');
  });

  it('adopts a fresh token when the server issues one', async () => {
    vi.spyOn(guestsApi, 'register').mockResolvedValueOnce({
      id: GUEST_ID,
      eventId: EVENT_ID,
      name: 'Ivan',
      createdAt: new Date().toISOString(),
      guestToken: 'guest-token-first',
    } as Guest);
    await storageService.registerGuest('Ivan');

    vi.spyOn(guestsApi, 'register').mockResolvedValueOnce({
      id: GUEST_ID,
      eventId: EVENT_ID,
      name: 'Ivan',
      createdAt: new Date().toISOString(),
      guestToken: 'guest-token-rotated',
    } as Guest);
    await storageService.registerGuest('Ivan');

    expect(storedGuest()?.guestToken).toBe('guest-token-rotated');
  });

  it('does not carry a token across onto a different guest id', async () => {
    vi.spyOn(guestsApi, 'register').mockResolvedValueOnce({
      id: GUEST_ID,
      eventId: EVENT_ID,
      name: 'Ivan',
      createdAt: new Date().toISOString(),
      guestToken: 'guest-token-first',
    } as Guest);
    await storageService.registerGuest('Ivan');

    // The server decided this is a different guest. The old token is bound to
    // the old guestId and proves nothing about this one — it must not follow.
    const OTHER_ID = '9f8e7d6c-5b4a-4392-8180-7f6e5d4c3b2a';
    vi.spyOn(guestsApi, 'register').mockResolvedValueOnce({
      id: OTHER_ID,
      eventId: EVENT_ID,
      name: 'Ivan',
      createdAt: new Date().toISOString(),
    } as Guest);
    await storageService.registerGuest('Ivan');

    expect(storedGuest()?.id).toBe(OTHER_ID);
    expect(storedGuest()?.guestToken).toBeUndefined();
  });
});
