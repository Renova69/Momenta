import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request, type IncomingHttpHeaders } from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import { builtClient } from '../../server/lib/builtClient';

/**
 * N-134 — the shipped compose publishes the app's port with nothing in front
 * of it, and Express sent the built client uncompressed: the 428 kB main
 * chunk crossed a venue's Wi-Fi as 418 kB rather than about 125 kB, before a
 * guest saw anything. Nor could a phone keep the hashed files between visits:
 * every reopen of the album asked for each of them again.
 *
 * The router under test is the real one, mounted on a bare app over a
 * throwaway build directory; importing `server/index.ts` would boot the whole
 * application.
 */

const TEST_PORT = 6678;
let server: ReturnType<typeof createServer>;
let distDir: string;

const BUNDLE = `export const filler = ${JSON.stringify('wedding '.repeat(4000))};\n`;

function get(
  urlPath: string,
  acceptEncoding = 'gzip, br'
): Promise<{ status: number; headers: IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: 'localhost', port: TEST_PORT, path: urlPath, headers: { 'Accept-Encoding': acceptEncoding } },
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
  distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'built-client-'));
  fs.mkdirSync(path.join(distDir, 'assets'));
  fs.writeFileSync(path.join(distDir, 'assets', 'index-AbC123.js'), BUNDLE);
  fs.writeFileSync(path.join(distDir, 'index.html'), `<!doctype html><html><body>${'<div></div>'.repeat(300)}</body></html>`);

  const app = express();
  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true });
  });
  app.use(builtClient(distDir));
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(() => {
  server?.close();
  fs.rmSync(distDir, { recursive: true, force: true });
});

describe('the built client (N-134)', () => {
  it('sends the bundle compressed', async () => {
    const res = await get('/assets/index-AbC123.js');

    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toMatch(/^(gzip|br)$/);
  });

  it('lets a phone keep a hashed file for good', async () => {
    const res = await get('/assets/index-AbC123.js');

    expect(res.headers['cache-control']).toBe('public, max-age=31536000, immutable');
  });

  it('has the page itself checked every time, so a new build is picked up', async () => {
    const res = await get('/index.html');

    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('answers an album address with the page, compressed and checked every time', async () => {
    const res = await get('/e/ana-i-boris');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.headers['content-encoding']).toMatch(/^(gzip|br)$/);
    expect(res.headers['cache-control']).toBe('no-cache');
  });

  it('keeps an album out of search engines', async () => {
    // N-153 — a link a guest posts publicly is all a crawler needs; the
    // couple's names, venue and guests' photos would then come up in search.
    const album = await get('/e/ana-i-boris');
    const studio = await get('/host');

    expect(album.headers['x-robots-tag']).toBe('noindex, nofollow');
    expect(studio.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('keeps the pricing page out of search when it names an album', async () => {
    // /pricing?event=<slug> is what the studio links to; it carries the
    // album's address.
    const res = await get('/pricing?event=ana-i-boris');

    expect(res.headers['x-robots-tag']).toBe('noindex, nofollow');
  });

  it('leaves the landing and pricing pages indexable', async () => {
    const landing = await get('/');
    const pricing = await get('/pricing');

    expect(landing.headers['x-robots-tag']).toBeUndefined();
    expect(pricing.headers['x-robots-tag']).toBeUndefined();
  });

  it('leaves the legal pages indexable (N-163)', async () => {
    expect((await get('/privacy')).headers['x-robots-tag']).toBeUndefined();
    expect((await get('/terms')).headers['x-robots-tag']).toBeUndefined();
  });

  it('leaves the API alone', async () => {
    const ping = await get('/api/ping');
    const missing = await get('/api/nothing-here', 'identity');

    expect(ping.headers['content-encoding']).toBeUndefined();
    expect(missing.status).toBe(404);
    expect(missing.body).not.toContain('<div></div>');
  });
});
