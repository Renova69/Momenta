import { describe, it, expect, afterEach } from 'vitest';
import { installQuotaLimitedStorage, fakeDataUrl } from '../helpers/quotaStorage';

/**
 * The test harness's own localStorage guarantees.
 *
 * These matter because their absence hid a real bug. The shared stub in
 * `tests/setup.ts` used to accept a write of any size, so every quota-handling
 * branch in the app was unreachable from the suite — and H1 lived in exactly
 * one of those branches: a freshly captured photo whose inline `data:` URL did
 * not fit was silently dropped from the feed, while no test could observe it
 * because the stub never refused anything.
 *
 * A stub that is wrong in the permissive direction fails open and quietly, so
 * it is worth pinning rather than assuming.
 */
describe('localStorage test harness', () => {
  let restore: (() => void) | null = null;

  afterEach(() => {
    restore?.();
    restore = null;
    localStorage.clear();
  });

  describe('the shared 5MB stub (tests/setup.ts)', () => {
    it('accepts an ordinary write', () => {
      expect(() => localStorage.setItem('small', 'x'.repeat(1024))).not.toThrow();
      expect(localStorage.getItem('small')).toHaveLength(1024);
    });

    it('refuses a write past what a real browser would allow', () => {
      expect(() => localStorage.setItem('huge', 'x'.repeat(6 * 1024 * 1024))).toThrow(/quota/i);
    });

    it('counts what is already stored, not just the incoming value', () => {
      localStorage.setItem('a', 'x'.repeat(3 * 1024 * 1024));
      // Comfortably under the ceiling alone; over it alongside 'a'.
      expect(() => localStorage.setItem('b', 'x'.repeat(3 * 1024 * 1024))).toThrow(/quota/i);
    });

    it('lets a key be overwritten in place without counting itself twice', () => {
      // An overwrite replaces rather than adds. Counting the old value toward
      // the new one's budget would make re-saving the same list fail.
      localStorage.setItem('c', 'x'.repeat(3 * 1024 * 1024));
      expect(() => localStorage.setItem('c', 'y'.repeat(3 * 1024 * 1024))).not.toThrow();
    });
  });

  describe('installQuotaLimitedStorage', () => {
    it('enforces the tight ceiling it was given', () => {
      restore = installQuotaLimitedStorage(100 * 1024);

      expect(() => localStorage.setItem('fits', fakeDataUrl(50))).not.toThrow();
      expect(() => localStorage.setItem('does-not', fakeDataUrl(200))).toThrow(/quota/i);
    });

    it('puts the shared stub back afterwards', () => {
      restore = installQuotaLimitedStorage(1024);
      expect(() => localStorage.setItem('tiny-ceiling', fakeDataUrl(50))).toThrow(/quota/i);

      restore();
      restore = null;

      // Back to the 5MB stub, where the same write is unremarkable.
      expect(() => localStorage.setItem('tiny-ceiling', fakeDataUrl(50))).not.toThrow();
    });

    it('isolates its contents from the shared stub', () => {
      localStorage.setItem('outside', 'before');
      restore = installQuotaLimitedStorage(100 * 1024);

      expect(localStorage.getItem('outside')).toBeNull();
      localStorage.setItem('inside', 'only here');

      restore();
      restore = null;

      expect(localStorage.getItem('outside')).toBe('before');
      expect(localStorage.getItem('inside')).toBeNull();
    });
  });
});
