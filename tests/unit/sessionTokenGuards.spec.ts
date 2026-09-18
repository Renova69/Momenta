import { describe, it, expect, vi, afterEach } from 'vitest';
import { isSessionTokenPayload, isSessionTokenCurrent } from '../../server/middleware/auth';
import type { AuthUserPayload } from '../../server/middleware/auth';
import { pool } from '../../server/lib/db';

/**
 * The two checks that stand between a signed token and a host session.
 *
 * One `JWT_SECRET` signs four kinds of token: session, guest, export-zip and
 * photo-preview. A valid signature therefore proves only that this server
 * issued *something*. `isSessionTokenPayload` is what decides it issued a
 * session — and before SEC-01 it did not exist, so a five-minute export-zip
 * download token, which carries a real userId in a URL query string where it
 * lands in proxy logs and browser history, decoded cleanly and replayed as a
 * full host session for its lifetime.
 *
 * `isSessionTokenCurrent` is the revocation half: it refuses a token minted
 * before the user's `token_version` was bumped. Its own comment promises it
 * fails closed, because a database blip must not become a window in which
 * revoked tokens are honoured.
 *
 * Neither had a direct test. Both are reached only through routes, and
 * mutation testing found the gaps: making `isSessionTokenPayload` return true
 * for a non-object, and making the revocation lookup answer "current" when the
 * query throws, both left all 53 spec files that reach this module green.
 */

const SESSION: AuthUserPayload = {
  userId: '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01',
  email: 'host@test.com',
  role: 'host',
  tokenVersion: 0,
} as AuthUserPayload;

afterEach(() => {
  vi.restoreAllMocks();
});

describe('what counts as a session token', () => {
  it('accepts a real session payload', () => {
    expect(isSessionTokenPayload(SESSION)).toBe(true);
  });

  it('refuses anything that is not an object', () => {
    // `jwt.verify` returns a string when the token's payload was a string, so
    // this is reachable and not merely defensive. Returning true here is an
    // authentication bypass, and nothing was asserting it.
    for (const value of [null, undefined, 'a-string', 42, true, Symbol('x')]) {
      expect(isSessionTokenPayload(value), String(value?.toString())).toBe(false);
    }
  });

  it('refuses a token minted for any other purpose', () => {
    // The whole of SEC-01. Each of these is signed with the same secret and
    // verifies perfectly; the `purpose` claim is the only thing telling them
    // apart.
    for (const purpose of ['export-zip', 'guest', 'photo-preview']) {
      expect(isSessionTokenPayload({ ...SESSION, purpose })).toBe(false);
    }
  });

  it('refuses a payload missing either identifying claim', () => {
    expect(isSessionTokenPayload({ userId: SESSION.userId })).toBe(false);
    expect(isSessionTokenPayload({ email: SESSION.email })).toBe(false);
    expect(isSessionTokenPayload({})).toBe(false);
  });

  it('refuses claims of the wrong type', () => {
    // A number where a string belongs is what a hand-built payload looks like.
    expect(isSessionTokenPayload({ ...SESSION, email: 42 })).toBe(false);
    expect(isSessionTokenPayload({ ...SESSION, userId: null })).toBe(false);
  });
});

describe('whether a session token is still current', () => {
  it('accepts a token minted at the current version', async () => {
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ token_version: 0 }] } as never);

    await expect(isSessionTokenCurrent(SESSION)).resolves.toBe(true);
  });

  it('refuses a token minted before the user signed out everywhere', async () => {
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [{ token_version: 3 }] } as never);

    await expect(isSessionTokenCurrent(SESSION)).resolves.toBe(false);
  });

  it('refuses a token for an account that no longer exists', async () => {
    vi.spyOn(pool, 'query').mockResolvedValue({ rows: [] } as never);

    await expect(isSessionTokenCurrent(SESSION)).resolves.toBe(false);
  });

  it('fails closed when the lookup throws', async () => {
    // The function's own comment promises this, and nothing checked it.
    // Answering "current" on a database error turns every blip into a window
    // where revoked tokens are honoured — precisely when you are least able to
    // notice.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(pool, 'query').mockRejectedValue(new Error('ECONNREFUSED'));

    await expect(isSessionTokenCurrent(SESSION)).resolves.toBe(false);
  });

  it('does not leak the driver error to the caller', async () => {
    // It logs, it does not throw: a thrown error here would surface as a 500
    // on a request that should simply be rejected as unauthenticated.
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(pool, 'query').mockRejectedValue(new Error('connect ECONNREFUSED 10.0.0.4:5432'));

    await expect(isSessionTokenCurrent(SESSION)).resolves.toBe(false);
    expect(logged).toHaveBeenCalled();
  });
});
