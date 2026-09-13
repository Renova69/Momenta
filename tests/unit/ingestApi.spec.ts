import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ingestApi } from '../../src/api/ingestApi';

/**
 * The photographer upload client.
 *
 * This is the browser half of the pro-ingest path: the VIP portal calls
 * `uploadPhotos` with an ingest key rather than a host session, and pushes a
 * whole card of frames through it. It was at 2.7% coverage — the key-management
 * calls were exercised only indirectly and the uploader not at all, which meant
 * its concurrency, its progress reporting and its error handling were all
 * unverified on the one path a photographer actually uses at a wedding.
 *
 * `fetch` is stubbed rather than the module mocked, so the request the server
 * would receive — method, header, FormData fields — is what gets asserted.
 */

interface Recorded {
  url: string;
  init: RequestInit;
}

function stubFetch(handler: (call: Recorded) => Response | Promise<Response>) {
  const calls: Recorded[] = [];
  const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const record = { url: String(input), init: init ?? {} };
    calls.push(record);
    return handler(record);
  });
  vi.stubGlobal('fetch', impl);
  return calls;
}

const okPhotos = (n = 1) =>
  new Response(JSON.stringify({ photos: Array.from({ length: n }, (_, i) => ({ id: `p${i}` })) }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

function fileNamed(name: string): File {
  return new File([new Uint8Array([1, 2, 3])], name, { type: 'image/jpeg' });
}

describe('ingestApi.uploadPhotos', () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns immediately for an empty selection without calling the network', async () => {
    const calls = stubFetch(() => okPhotos());

    const result = await ingestApi.uploadPhotos('e1', 'key', []);

    expect(result).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('sends the ingest key as a header and the file as multipart, never as a JSON body', async () => {
    // The key is a bearer credential for an endpoint that takes no session, so
    // it belongs in the header. A regression that moved it into the body would
    // still "work" against a permissive server and leak it into request logs
    // shaped differently.
    const calls = stubFetch(() => okPhotos());

    await ingestApi.uploadPhotos('event-42', 'secret-key', [fileNamed('DSC_1.jpg')], {
      photographerName: 'Ansel',
      caption: 'First dance',
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/api/ingest/event-42/photos');
    expect(calls[0].init.method).toBe('POST');
    expect((calls[0].init.headers as Record<string, string>)['X-Ingest-Key']).toBe('secret-key');

    const body = calls[0].init.body as FormData;
    expect(body).toBeInstanceOf(FormData);
    expect((body.get('file') as File).name).toBe('DSC_1.jpg');
    expect(body.get('photographerName')).toBe('Ansel');
    expect(body.get('caption')).toBe('First dance');
  });

  it('omits the optional fields entirely when they are blank', async () => {
    const calls = stubFetch(() => okPhotos());

    await ingestApi.uploadPhotos('e1', 'k', [fileNamed('a.jpg')]);

    const body = calls[0].init.body as FormData;
    expect(body.has('photographerName')).toBe(false);
    expect(body.has('caption')).toBe(false);
  });

  it('percent-encodes the event id into the path', async () => {
    const calls = stubFetch(() => okPhotos());

    await ingestApi.uploadPhotos('a/b?c', 'k', [fileNamed('a.jpg')]);

    expect(calls[0].url).toContain('/api/ingest/a%2Fb%3Fc/photos');
  });

  it('uploads every file exactly once and collects all returned photos', async () => {
    const calls = stubFetch(() => okPhotos(2));
    const files = Array.from({ length: 7 }, (_, i) => fileNamed(`DSC_${i}.jpg`));

    const result = await ingestApi.uploadPhotos('e1', 'k', files, { concurrency: 3 });

    expect(calls).toHaveLength(7);
    const names = calls.map((c) => ((c.init.body as FormData).get('file') as File).name).sort();
    expect(names).toEqual(files.map((f) => f.name).sort());
    // Two photos per response, seven responses.
    expect(result).toHaveLength(14);
  });

  it('reports progress once per file, ending at the total', async () => {
    stubFetch(() => okPhotos());
    const seen: [number, number][] = [];

    await ingestApi.uploadPhotos('e1', 'k', [fileNamed('a.jpg'), fileNamed('b.jpg'), fileNamed('c.jpg')], {
      concurrency: 2,
      onProgress: (done, total) => seen.push([done, total]),
    });

    expect(seen).toHaveLength(3);
    expect(seen.every(([, total]) => total === 3)).toBe(true);
    // Order between workers is not deterministic, but the counter is.
    expect(seen.map(([done]) => done).sort()).toEqual([1, 2, 3]);
  });

  it('never runs more requests at once than the configured concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    stubFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return okPhotos();
    });

    await ingestApi.uploadPhotos(
      'e1',
      'k',
      Array.from({ length: 8 }, (_, i) => fileNamed(`f${i}.jpg`)),
      { concurrency: 3 }
    );

    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThan(1);
  });

  it('does not spawn more workers than there are files', async () => {
    let peak = 0;
    let inFlight = 0;
    stubFetch(async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return okPhotos();
    });

    await ingestApi.uploadPhotos('e1', 'k', [fileNamed('only.jpg')], { concurrency: 8 });

    expect(peak).toBe(1);
  });

  it("surfaces the server's own error message rather than a generic one", async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: 'Plan limit reached' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    await expect(
      ingestApi.uploadPhotos('e1', 'k', [fileNamed('a.jpg')])
    ).rejects.toThrow('Plan limit reached');
  });

  it('falls back to the status code when the error body is not JSON', async () => {
    stubFetch(() => new Response('<html>502</html>', { status: 502 }));

    await expect(
      ingestApi.uploadPhotos('e1', 'k', [fileNamed('a.jpg')])
    ).rejects.toThrow('Upload failed (HTTP 502)');
  });

  it('tolerates a success response that carries no photos array', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        })
    );

    await expect(ingestApi.uploadPhotos('e1', 'k', [fileNamed('a.jpg')])).resolves.toEqual([]);
  });
});

describe('ingestApi key management', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const jsonOk = (payload: unknown) =>
    new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });

  it('creates a key with the event id and label in the body', async () => {
    const calls = stubFetch(() => jsonOk({ id: 'k1', label: 'Camera A', createdAt: 'now' }));

    const key = await ingestApi.createKey('e1', 'Camera A');

    expect(key.id).toBe('k1');
    expect(calls[0].url).toContain('/api/ingest/keys');
    expect(calls[0].init.method).toBe('POST');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ eventId: 'e1', label: 'Camera A' });
  });

  it('lists keys with the event id encoded in the query string', async () => {
    const calls = stubFetch(() => jsonOk([]));

    await ingestApi.listKeys('a b&c');

    expect(calls[0].url).toContain('eventId=a%20b%26c');
  });

  it('revokes a key with DELETE', async () => {
    const calls = stubFetch(() => jsonOk({ success: true, keyId: 'k1' }));

    const result = await ingestApi.revokeKey('k1');

    expect(result.success).toBe(true);
    expect(calls[0].url).toContain('/api/ingest/keys/k1');
    expect(calls[0].init.method).toBe('DELETE');
  });
});
