import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * N-135 — the page asked fonts.googleapis.com for its typefaces. The
 * production CSP (server/index.ts) allows styles and fonts from 'self' only,
 * so in production the request was refused and the app never showed its
 * fonts; where no CSP applied, every guest's phone told Google which album it
 * had opened. What the page loads before the bundle runs must come from the
 * page's own origin.
 */
describe('the page shell', () => {
  const html = fs.readFileSync(path.resolve(__dirname, '../../index.html'), 'utf8');

  it('loads nothing from another origin', () => {
    const external = [...html.matchAll(/\b(?:href|src)\s*=\s*["'](?:https?:)?\/\/([^/"']+)/gi)].map((m) => m[1]);

    expect(external).toEqual([]);
  });
});
