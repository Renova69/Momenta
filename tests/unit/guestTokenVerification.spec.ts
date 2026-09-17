import { describe, it, expect } from 'vitest';
import jwt from 'jsonwebtoken';
import { issueGuestToken, verifyGuestToken } from '../../server/lib/guestAuth';
import { issueDownloadToken } from '../../server/lib/downloadToken';
import { CONFIG } from '../../server/lib/config';

/**
 * The one function that decides whether a guest is who they say they are.
 *
 * A guestId is public. It travels in URLs, it sits in every other guest's copy
 * of the feed, and it is submitted by the client on every like, comment, quest
 * completion, upload and voice message. So the id alone can never be enough:
 * `verifyGuestToken` is what stands between a public identifier and a stranger
 * signing someone else's name to a message played out loud at a reception
 * (SEC-A2).
 *
 * It had no direct test. Thirty-three spec files reach it, all of them through
 * routes that happen to use it, and none of them ever handed it a *valid* token
 * belonging to somebody else — which is the only attack it exists to stop.
 * Mutation testing is what surfaced that: flipping the first `||` in its
 * identity check, so that a token with the right purpose but the wrong guestId
 * is accepted, left every one of those thirty-three files green. So did
 * replacing the whole identity check's `return false` with `return true`.
 *
 * These tests are written against the mutants that survived.
 */

const EVENT = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';
const OTHER_EVENT = 'b1ffcd88-8d1a-4fe7-aa5c-5aa8ac279b22';
const ANA = '10eebc99-9c0b-4ef8-bb6d-6bb9bd380a01';
const BORIS = '20eebc99-9c0b-4ef8-bb6d-6bb9bd380a02';

describe('a token proves one guest, in one album', () => {
  it('accepts the guest and album it was issued for', () => {
    expect(verifyGuestToken(issueGuestToken(ANA, EVENT), ANA, EVENT)).toBe(true);
  });

  it('refuses Ana’s token presented as Boris', () => {
    // The attack. Both guests are at the same wedding, so the album matches and
    // the signature is genuine — everything checks out except the one thing
    // that matters. A public guestId plus any valid token would otherwise let
    // anyone post as anyone.
    const anas = issueGuestToken(ANA, EVENT);

    expect(verifyGuestToken(anas, BORIS, EVENT)).toBe(false);
  });

  it('refuses a token minted for a different album', () => {
    // Cross-tenant: a guest at one wedding must not be able to act at another,
    // even as themselves.
    const elsewhere = issueGuestToken(ANA, OTHER_EVENT);

    expect(verifyGuestToken(elsewhere, ANA, EVENT)).toBe(false);
  });

  it('refuses a token that is right about the album and wrong about the guest', () => {
    // Stated separately from the case above because the check is a chain of
    // three conditions joined by `||`, and a single wrong operator in it
    // collapses the whole chain to whichever condition happens to be last.
    for (const [token, claimedGuest, claimedEvent] of [
      [issueGuestToken(ANA, EVENT), BORIS, EVENT],
      [issueGuestToken(ANA, EVENT), ANA, OTHER_EVENT],
      [issueGuestToken(ANA, EVENT), BORIS, OTHER_EVENT],
    ] as const) {
      expect(verifyGuestToken(token, claimedGuest, claimedEvent)).toBe(false);
    }
  });
});

describe('a token proves it is a guest token', () => {
  it('refuses a token issued for another purpose', () => {
    // One secret signs four kinds of token. Purpose-pinning is what stops an
    // export ticket being replayed as an identity.
    const exportTicket = issueDownloadToken(EVENT, ANA);

    expect(verifyGuestToken(exportTicket, ANA, EVENT)).toBe(false);
  });

  it('refuses a token that carries no purpose at all', () => {
    const unstamped = jwt.sign({ guestId: ANA, eventId: EVENT, v: 0 }, CONFIG.JWT_SECRET);

    expect(verifyGuestToken(unstamped, ANA, EVENT)).toBe(false);
  });

  it('refuses a token signed with the wrong secret', () => {
    const forged = jwt.sign(
      { purpose: 'guest', guestId: ANA, eventId: EVENT, v: 0 },
      'not-the-servers-secret-but-long-enough-to-sign'
    );

    expect(verifyGuestToken(forged, ANA, EVENT)).toBe(false);
  });

  it('refuses an unsigned token', () => {
    // `alg: none` is the classic JWT bypass; the verifier pins HS256.
    const unsigned = jwt.sign({ purpose: 'guest', guestId: ANA, eventId: EVENT, v: 0 }, '', {
      algorithm: 'none',
    });

    expect(verifyGuestToken(unsigned, ANA, EVENT)).toBe(false);
  });
});

describe('a host can end every guest session (M10)', () => {
  it('refuses a token minted before the reset', () => {
    const beforeReset = issueGuestToken(ANA, EVENT, 0);

    expect(verifyGuestToken(beforeReset, ANA, EVENT, 1)).toBe(false);
  });

  it('accepts a token minted after it', () => {
    // The half that makes revocation usable rather than permanent: nothing
    // tested that a token could be issued at a non-zero version at all, so a
    // reset could have locked every guest out of the album for good and the
    // suite would not have said a word.
    const afterReset = issueGuestToken(ANA, EVENT, 1);

    expect(verifyGuestToken(afterReset, ANA, EVENT, 1)).toBe(true);
  });

  it('survives a second reset', () => {
    expect(verifyGuestToken(issueGuestToken(ANA, EVENT, 2), ANA, EVENT, 2)).toBe(true);
    expect(verifyGuestToken(issueGuestToken(ANA, EVENT, 1), ANA, EVENT, 2)).toBe(false);
  });

  it('treats an absent version as version zero, in both directions', () => {
    // Guest rows predating migration 023 default to 0, and callers that have no
    // version to pass omit the argument. Those two have to agree or every
    // existing guest is logged out by the deploy.
    const legacy = jwt.sign({ purpose: 'guest', guestId: ANA, eventId: EVENT }, CONFIG.JWT_SECRET);

    expect(verifyGuestToken(legacy, ANA, EVENT)).toBe(true);
    expect(verifyGuestToken(legacy, ANA, EVENT, 0)).toBe(true);
    expect(verifyGuestToken(legacy, ANA, EVENT, 1)).toBe(false);
  });
});

describe('anything that is not a token', () => {
  it('refuses empty, absent and non-string values without throwing', () => {
    // Every one of these arrives from a client-supplied JSON body.
    for (const value of [undefined, null, '', 0, false, {}, [], 'not.a.jwt', 'a.b.c']) {
      expect(verifyGuestToken(value, ANA, EVENT)).toBe(false);
    }
  });

  it('refuses an expired token', () => {
    const expired = jwt.sign({ purpose: 'guest', guestId: ANA, eventId: EVENT, v: 0 }, CONFIG.JWT_SECRET, {
      expiresIn: '-1s',
    });

    expect(verifyGuestToken(expired, ANA, EVENT)).toBe(false);
  });
});
