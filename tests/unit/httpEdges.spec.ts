import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request, type IncomingHttpHeaders } from 'http';
import express from 'express';
import { compressGuestFeed, apiNotFound } from '../../server/lib/httpEdges';

/**
 * The edges of the HTTP API that sit outside any one router: how the guest
 * feed is sent, and what an address no route answers gets back.
 *
 * The middleware under test is mounted on a bare app; importing
 * `server/index.ts` would boot the whole application.
 */

const TEST_PORT = 6682;
let server: ReturnType<typeof createServer>;

/** A page of the feed as big as a real one: about 1 kB a photo. */
const FEED_PAGE = Array.from({ length: 100 }, (_, i) => ({
  id: `photo-${i}`,
  guestName: 'Гост',
  fullUrl: `https://media.example.org/events/abc/wedding-photo-${i}.jpg`,
  thumbnailUrl: `https://media.example.org/events/abc/wedding-thumb-${i}.jpg`,
  caption: 'Честито!',
  reactions: [],
}));

function get(
  urlPath: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: 'localhost', port: TEST_PORT, path: urlPath, headers: { 'Accept-Encoding': 'gzip, br', ...headers } },
      (res) => {
        let body = '';
        res.setEncoding('latin1');
        res.on('data', (chunk) => (body += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      }
    );
    req.on('error', reject);
    req.end();
  });
}

beforeAll(async () => {
  const app = express();
  app.get('/api/photos', compressGuestFeed());
  app.get('/api/photos', (_req, res) => {
    res.json(FEED_PAGE);
  });
  app.get('/api/events/:id/usage', (_req, res) => {
    res.json({ filler: 'x'.repeat(5000) });
  });
  app.use('/api', apiNotFound);
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(() => {
  server?.close();
});

describe('the guest feed on the wire (N-157)', () => {
  it('is compressed for a guest', async () => {
    // About 96 kB for a page of 100 photos, 9 kB gzipped: every guest at the
    // venue loads it, on the venue's Wi-Fi.
    const res = await get('/api/photos?eventId=abc');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toMatch(/^(gzip|br)$/);
  });

  it('is sent as it is to a signed-in host', async () => {
    // The host's copy carries signed preview tokens next to text guests
    // wrote, which is what a compression side channel needs (N-134).
    const res = await get('/api/photos?eventId=abc', { Authorization: 'Bearer host-token' });

    expect(res.headers['content-encoding']).toBeUndefined();
  });

  it('leaves every other API answer uncompressed', async () => {
    const res = await get('/api/events/abc/usage');

    expect(res.headers['content-encoding']).toBeUndefined();
  });
});

describe('an API address nothing answers (N-160)', () => {
  it('gets a JSON 404, not an HTML page', async () => {
    const res = await get('/api/no-such-thing');

    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(JSON.parse(res.body)).toEqual({ error: 'Not found' });
  });
});
