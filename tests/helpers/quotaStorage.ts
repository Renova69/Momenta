/**
 * Install a tightly quota-limited `localStorage` for the duration of a test.
 *
 * `tests/setup.ts` gives the suite a 5MB ceiling, matching a real browser.
 * That is the right default, but it is far too generous to reach deliberately:
 * a spec that wants to prove what happens when a write does not fit would have
 * to manufacture megabytes of fixture data to get there.
 *
 * So quota-branch tests install their own ceiling instead, sized to the
 * fixtures at hand. This is the shape they all need, extracted so it is
 * written once rather than copied — the accounting (whether the key being
 * overwritten counts toward the total) is easy to get subtly wrong, and a
 * stub that is wrong in that direction silently never throws, which is
 * precisely the failure it exists to catch.
 *
 * Returns a restore function. Call it in `afterEach`, unconditionally:
 *
 *     let restore: (() => void) | null = null;
 *     afterEach(() => { restore?.(); restore = null; });
 *     ...
 *     restore = installQuotaLimitedStorage(200 * 1024);
 */
export function installQuotaLimitedStorage(maxBytes: number): () => void {
  const real = window.localStorage;
  const store: Record<string, string> = {};

  const limited: Storage = {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => {
      // The key being written does not count toward the total it has to fit
      // inside — it is replaced, not added to. Counting it would make an
      // overwrite of an existing key look larger than it is.
      const otherKeys = Object.entries(store).reduce(
        (sum, [k, v]) => sum + (k === key ? 0 : k.length + v.length),
        0
      );
      if (otherKeys + key.length + value.length > maxBytes) {
        const err = new Error('QuotaExceededError');
        err.name = 'QuotaExceededError';
        throw err;
      }
      store[key] = value;
    },
    removeItem: (key) => {
      delete store[key];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i) => Object.keys(store)[i] ?? null,
    get length() {
      return Object.keys(store).length;
    },
  };

  Object.defineProperty(window, 'localStorage', {
    value: limited,
    writable: true,
    configurable: true,
  });

  return () => {
    Object.defineProperty(window, 'localStorage', {
      value: real,
      writable: true,
      configurable: true,
    });
  };
}

/** A `data:` URL of roughly `kb` kilobytes, for filling a quota on purpose. */
export function fakeDataUrl(kb: number): string {
  return 'data:image/jpeg;base64,' + 'A'.repeat(kb * 1024);
}
