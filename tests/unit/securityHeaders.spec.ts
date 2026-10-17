import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, request, type IncomingHttpHeaders } from 'http';
import express from 'express';
import { securityHeaders, noStore } from '../../server/lib/securityHeaders';

/**
 * The response headers, as an OWASP ZAP baseline scan of the production build
 * read them (2026-10-17). It found no failure and these warnings worth acting
 * on: a WebSocket allowance to any host, no Permissions-Policy, and API
 * answers any cache could keep.
 */

const TEST_PORT = 6684;
let server: ReturnType<typeof createServer>;

function get(path: string, host?: string): Promise<{ status: number; headers: IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: 'localhost', port: TEST_PORT, path, headers: host ? { Host: host } : {} }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

function directive(csp: string | undefined, name: string): string[] {
  const found = (csp ?? '').split(';').find((d) => d.trim().startsWith(`${name} `));
  return found ? found.trim().split(/\s+/).slice(1) : [];
}

beforeAll(async () => {
  const app = express();
  app.use(securityHeaders({ r2Origin: 'https://media.example.org', production: true }));
  app.use('/api', noStore);
  app.get('/api/thing', (_req, res) => {
    res.json({ ok: true });
  });
  app.get('/', (_req, res) => {
    res.send('<!doctype html>');
  });
  server = createServer(app);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(() => {
  server?.close();
});

describe('the content security policy', () => {
  it('lets the page open a WebSocket to its own host, and no other', async () => {
    const { headers } = await get('/', 'wedmoments.example:443');
    const connect = directive(headers['content-security-policy'] as string, 'connect-src');

    expect(connect).toContain("'self'");
    expect(connect).toContain('ws://wedmoments.example:443');
    expect(connect).toContain('wss://wedmoments.example:443');
    expect(connect).not.toContain('ws:');
    expect(connect).not.toContain('wss:');
  });

  it('names no WebSocket host when the request names a malformed one', async () => {
    const { headers } = await get('/', 'evil.example;script-src');
    const csp = headers['content-security-policy'] as string;

    expect(csp).not.toContain('evil.example');
    expect(directive(csp, 'script-src')).toEqual(["'self'"]);
  });

  it('lets the page start its own workers, as the confetti does, from a blob', async () => {
    const { headers } = await get('/');
    expect(directive(headers['content-security-policy'] as string, 'worker-src')).toEqual(["'self'", 'blob:']);
  });

  it('allows photos from the storage host and nothing else outside the site', async () => {
    const { headers } = await get('/');
    expect(directive(headers['content-security-policy'] as string, 'img-src')).toEqual([
      "'self'",
      'data:',
      'blob:',
      'https://media.example.org',
    ]);
  });
});

describe('the permissions policy', () => {
  it('lets this site use the camera and microphone, and turns off what it never uses', async () => {
    const policy = (await get('/')).headers['permissions-policy'] as string;

    expect(policy).toContain('camera=(self)');
    expect(policy).toContain('microphone=(self)');
    expect(policy).toContain('geolocation=()');
    expect(policy).toContain('payment=()');
  });
});

describe('API answers', () => {
  it('are kept by no cache', async () => {
    const { headers } = await get('/api/thing');
    expect(headers['cache-control']).toBe('no-store');
  });
});
