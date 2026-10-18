import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * N-189 — test runs left photo files behind on development machines. The
 * browser tests' server writes to local disk, but the cleanup in the
 * Playwright worker took STORAGE_PROVIDER=r2 from .env and deleted those
 * files through the R2 adapter, which removed nothing; the e2e run's purge
 * did the same to rows a local unit run had left. The folders were older than
 * the run that sweeps them (N-162), so they stayed for good. CI sets local
 * storage for every job, which is why only developers' machines filled up.
 *
 * Every test run that writes through the app now writes to, and cleans up,
 * local storage, wherever it runs. R2 has its own suite (test:storage:r2).
 */

const root = process.cwd();
const read = (file: string) => fs.readFileSync(path.join(root, file), 'utf8');

describe('test runs use local storage (N-189)', () => {
  it('pins it for the unit, coverage and e2e runs', () => {
    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> }).scripts;
    for (const name of ['test:unit', 'test:coverage', 'test:e2e']) {
      expect(scripts[name], name).toMatch(/STORAGE_PROVIDER=local/);
    }
  });

  it('pins it for the browser tests’ workers as well as their server', () => {
    const config = read('playwright.config.ts');
    expect(config).toMatch(/process\.env\.STORAGE_PROVIDER = 'local'/);
  });
});
