import '@testing-library/jest-dom';
// jsdom does not implement IndexedDB — offlineQueueService.ts (SEC-P2, moved
// off localStorage) needs it. Side-effect import registers window.indexedDB.
import 'fake-indexeddb/auto';

/**
 * Refuse to run the unit suite against remote storage.
 *
 * vitest.config.ts pins STORAGE_PROVIDER=local for exactly this reason, and
 * this asserts the pin is still in place. Requiring an explicit 'local' (not
 * merely "not r2") means deleting that config line trips this too, rather than
 * silently falling through to whatever .env holds.
 *
 * Without it, pointing .env at r2 turned every media-touching spec into a
 * network test. The symptom was not an obvious failure but days of moving,
 * unreproducible flakes in whichever timing-sensitive spec was unluckiest —
 * the failure this converts into one clear line, before a single test runs.
 */
const storageProvider = process.env.STORAGE_PROVIDER;
if (storageProvider !== 'local' && process.env.ALLOW_REMOTE_STORAGE_IN_TESTS !== 'true') {
  throw new Error(
    `[tests] STORAGE_PROVIDER is "${storageProvider ?? '(unset)'}" — unit tests must run against local disk. ` +
      'They would otherwise make real network calls to Cloudflare R2, which makes timing-sensitive specs ' +
      '(exportDownload MED-01, ingestRoutes MED-04) fail unpredictably. ' +
      'Restore STORAGE_PROVIDER: "local" in vitest.config.ts, or set ALLOW_REMOTE_STORAGE_IN_TESTS=true to ' +
      'deliberately exercise real storage.'
  );
}

/**
 * In-memory localStorage mock.
 *
 * The quota is enforced, and that is deliberate. This stub used to accept
 * writes of any size, so every quota-handling branch in the app was
 * unreachable from the suite — which is where H1 lived: a capture whose
 * `data:` URL would not fit was silently dropped from the feed, and no test
 * could see it because the stub never refused anything.
 *
 * 5MB matches what browsers actually give an origin. Nothing in the suite
 * comes close to it today, so this changes no existing behaviour; it means a
 * future spec that writes more than a real browser would allow fails here
 * rather than passing against conditions that cannot occur.
 *
 * To exercise a quota branch on purpose, do not reach for this ceiling —
 * install a tight one for the duration of a test with
 * `installQuotaLimitedStorage` from `tests/helpers/quotaStorage.ts`.
 */
const LOCAL_STORAGE_QUOTA_BYTES = 5 * 1024 * 1024;

const storage: Record<string, string> = {};
const localStorageMock: Storage = {
  getItem: (key: string): string | null => storage[key] || null,
  setItem: (key: string, value: string): void => {
    const otherKeys = Object.entries(storage).reduce(
      (sum, [k, v]) => sum + (k === key ? 0 : k.length + v.length),
      0
    );
    if (otherKeys + key.length + value.length > LOCAL_STORAGE_QUOTA_BYTES) {
      const err = new Error('QuotaExceededError');
      err.name = 'QuotaExceededError';
      throw err;
    }
    storage[key] = value;
  },
  removeItem: (key: string): void => {
    delete storage[key];
  },
  clear: (): void => {
    for (const k of Object.keys(storage)) delete storage[k];
  },
  key: (i: number): string | null => Object.keys(storage)[i] || null,
  get length(): number {
    return Object.keys(storage).length;
  },
};

Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true,
});

// Mock canvas-confetti
vi.mock('canvas-confetti', () => ({
  default: vi.fn(),
}));

// Mock Audio & MediaRecorder
class MockAudio {
  src = '';
  currentTime = 0;
  duration = 10;
  paused = true;
  play = vi.fn().mockResolvedValue(undefined);
  pause = vi.fn();
  load = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

Object.defineProperty(window, 'Audio', {
  value: MockAudio,
  writable: true,
});

// Mock WebSocket in JSDOM
class MockWebSocket {
  url: string;
  readyState = 1;
  onopen: (() => void) | null = null;
  onclose: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(url: string) {
    this.url = url;
  }
  send = vi.fn();
  close = vi.fn();
  addEventListener = vi.fn();
  removeEventListener = vi.fn();
}

Object.defineProperty(window, 'WebSocket', {
  value: MockWebSocket,
  writable: true,
});

if (typeof navigator.mediaDevices === 'undefined') {
  Object.defineProperty(navigator, 'mediaDevices', {
    value: {
      getUserMedia: vi.fn().mockResolvedValue({
        getTracks: () => [{ stop: vi.fn() }],
      }),
    },
    writable: true,
    // Configurable so individual specs can replace it — the secure-context
    // tests need to simulate a browser where it is absent entirely.
    configurable: true,
  });
}
