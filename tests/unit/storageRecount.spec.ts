import { describe, it, expect, vi, afterEach } from 'vitest';
import { Readable } from 'stream';

/**
 * Measuring one stored object.
 *
 * `npm run storage:recount` rewrites `photos.storage_bytes` from what it
 * measures, and the per-event totals from those rows. A number it gets wrong
 * is written straight over a correct one, and nothing notices until the next
 * full recount — so the only safe answer to "I could not read this file" is an
 * error, never a size.
 *
 * The distinction these tests pin: a *missing* object really is zero bytes of
 * storage, while an object that exists and fails mid-read is unknown.
 */

const getStream = vi.fn();
const query = vi.fn();
vi.mock('../../server/lib/storage', () => ({
  storageAdapter: { getStream: (p: string) => getStream(p) },
  toStoragePath: (url: string) => url,
}));
vi.mock('../../server/lib/db', () => ({
  pool: {
    query: (sql: string, params?: unknown[]) => query(sql, params),
    connect: async () => ({ query: (sql: string, params?: unknown[]) => query(sql, params), release: () => undefined }),
    end: async () => undefined,
  },
}));

const { sizeOf, main } = await import('../../scripts/storage-recount');

afterEach(() => vi.clearAllMocks());

describe('sizeOf', () => {
  it('adds up the chunks of a readable object', async () => {
    getStream.mockResolvedValue(Readable.from([Buffer.alloc(400), Buffer.alloc(112)]));

    await expect(sizeOf('events/x/photo.jpg')).resolves.toBe(512);
  });

  it('counts nothing for a row with no path', async () => {
    await expect(sizeOf(null)).resolves.toBe(0);
    expect(getStream).not.toHaveBeenCalled();
  });

  it('counts nothing for an object the bucket does not have', async () => {
    // Deleted or never written: it occupies no storage, and saying so is right.
    getStream.mockResolvedValue(null);

    await expect(sizeOf('events/x/gone.jpg')).resolves.toBe(0);
  });

  it('refuses to call a failed read zero bytes', async () => {
    // This returned 0. A transient read error on one copy of a photo then
    // undercounted it, and the recount wrote that smaller number over the
    // correct one — accounting drifting downwards, silently.
    const stream = new Readable({
      read() {
        this.destroy(new Error('connection reset'));
      },
    });
    getStream.mockResolvedValue(stream);

    await expect(sizeOf('events/x/photo.jpg')).rejects.toThrow('connection reset');
  });

  it('refuses when the object cannot even be opened', async () => {
    getStream.mockRejectedValue(new Error('AccessDenied'));

    await expect(sizeOf('events/x/photo.jpg')).rejects.toThrow('AccessDenied');
  });
});

/**
 * The whole run, over two photos: one readable, one that fails mid-read.
 */
describe('the recount itself', () => {
  const photo = (id: string) => ({
    id,
    storage_path: `events/e/${id}.jpg`,
    original_storage_path: null,
    thumbnail_url: null,
    storage_bytes: '1',
  });

  function routeQueries(photos: ReturnType<typeof photo>[]) {
    query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM photos')) return { rows: photos };
      if (sql.includes('FROM audio_guestbook')) return { rows: [] };
      if (sql.includes('COUNT(*)')) return { rows: [{ events: 1, total: '512' }] };
      return { rows: [] };
    });
  }

  const updatesFor = () =>
    query.mock.calls
      .filter(([sql]) => String(sql).startsWith('UPDATE photos'))
      .map(([, params]) => params as [number, string]);

  it('leaves a row it could not measure exactly as it found it', async () => {
    // The point of the whole fix: an unreadable object must not become a
    // smaller storage_bytes. The row keeps its number and the run says so.
    routeQueries([photo('good'), photo('unreadable')]);
    getStream.mockImplementation(async (p: string) => {
      if (p.includes('unreadable')) throw new Error('connection reset');
      return Readable.from([Buffer.alloc(512)]);
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main();

    expect(updatesFor()).toEqual([[512, 'good']]);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('1 photo row(s)'))).toBe(true);
  });

  it('says nothing about skipped rows when every one was measured', async () => {
    routeQueries([photo('good')]);
    getStream.mockResolvedValue(Readable.from([Buffer.alloc(512)]));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await main();

    expect(updatesFor()).toEqual([[512, 'good']]);
    expect(warn).not.toHaveBeenCalled();
  });
});
