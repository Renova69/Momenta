import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import { deviceKey } from '../../server/middleware/rateLimit';

/**
 * Which budget an upload is counted against.
 *
 * The upload limiter allows a guest twenty photos a minute. `deviceKey` decides
 * whose twenty: the phone that sent the request, or — when no fingerprint is
 * found — the IP address it came from. At a wedding those are wildly different
 * things. Two hundred guests behind one venue NAT share a single IP, so every
 * branch that fails to find a fingerprint hands the whole reception twenty
 * uploads between them and then starts returning 429s.
 *
 * Mutation testing found that none of it was asserted. Breaking the body
 * branch, so a fingerprint sent in the request body is ignored and every guest
 * falls back to the shared IP bucket, left all 54 spec files that reach this
 * module green — the specs that do exercise the limiter all send the header
 * form, and nothing covered the other two.
 */

function request(over: Partial<Request>): Request {
  return { body: undefined, query: {}, headers: {}, ip: '203.0.113.7', ...over } as Request;
}

describe('the fingerprint a guest supplies', () => {
  it('uses one sent in the request body', () => {
    // How the photo and audio uploads send it.
    expect(deviceKey(request({ body: { deviceFingerprint: 'phone-a' } }))).toBe('fp:phone-a');
  });

  it('uses one sent in the query string', () => {
    expect(deviceKey(request({ query: { deviceFingerprint: 'phone-b' } }))).toBe('fp:phone-b');
  });

  it('uses one sent as a header', () => {
    // How the limiter sees it on multipart requests, where it runs before
    // multer and the body is still an unparsed stream.
    expect(deviceKey(request({ headers: { 'x-device-fingerprint': 'phone-c' } }))).toBe('fp:phone-c');
  });

  it('prefers the body, then the query, then the header', () => {
    const all = request({
      body: { deviceFingerprint: 'from-body' },
      query: { deviceFingerprint: 'from-query' },
      headers: { 'x-device-fingerprint': 'from-header' },
    });

    expect(deviceKey(all)).toBe('fp:from-body');
    expect(
      deviceKey(
        request({ query: { deviceFingerprint: 'from-query' }, headers: { 'x-device-fingerprint': 'from-header' } })
      )
    ).toBe('fp:from-query');
  });
});

describe('when no fingerprint is supplied', () => {
  it('falls back to the address, and says so in the key', () => {
    // The prefix matters: `fp:` and `ip:` must never collide, or one guest's
    // fingerprint could be made to consume an address's budget.
    const key = deviceKey(request({}));

    expect(key.startsWith('ip:')).toBe(true);
    expect(key).not.toContain('fp:');
  });

  it('ignores a fingerprint that is not a string', () => {
    // These arrive from client-supplied JSON, so the type is not a given. An
    // object here would otherwise key on "[object Object]" — one bucket shared
    // by every caller who sends one.
    for (const value of [42, true, null, {}, ['a']]) {
      expect(deviceKey(request({ body: { deviceFingerprint: value } })).startsWith('ip:')).toBe(true);
    }
  });

  it('ignores an empty-string fingerprint rather than keying on it', () => {
    // Empty is not an identity. Keying on `fp:` would put every caller who
    // sends a blank fingerprint into one shared bucket.
    expect(deviceKey(request({ body: { deviceFingerprint: '' } })).startsWith('ip:')).toBe(true);
  });

  it('produces a key even with no address at all', () => {
    // `req.ip` is undefined when the socket is already gone. Throwing here
    // would turn a disconnect into a 500 inside the rate limiter.
    expect(() => deviceKey(request({ ip: undefined }))).not.toThrow();
    expect(deviceKey(request({ ip: undefined })).startsWith('ip:')).toBe(true);
  });
});
