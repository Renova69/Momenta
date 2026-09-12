import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * No two spec files may bind the same TCP port.
 *
 * vitest runs spec files in parallel worker processes, and most specs here
 * stand up a real HTTP server on a hardcoded port. Two files choosing the same
 * one is not a conflict that shows up as a clear error: whichever worker loses
 * the race throws EADDRINUSE inside `beforeAll`, vitest reports the suite as
 * failed with its tests *skipped*, and the file passes perfectly when run on
 * its own. It only appears when the scheduler happens to overlap those two
 * files, so it reads as a mystery flake.
 *
 * That is exactly what happened: `wsThrottleAndReactions.spec.ts` listened on
 * `TEST_PORT + 1`, which resolved to 6607 — the same port
 * `authHardening.spec.ts` binds. The arithmetic is why nobody spotted it;
 * scanning for the literal 6607 finds only one of the two.
 *
 * So this checks the resolved value, arithmetic included, rather than the
 * literals. Adding a spec that reuses a port now fails here immediately and
 * names both files, instead of surfacing as an intermittent failure somewhere
 * unrelated weeks later.
 */

const TESTS_DIR = path.resolve(__dirname, '..');

function listSpecFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSpecFiles(full);
    return /\.(spec|test)\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/**
 * Strip comments and template/string literals before scanning.
 *
 * Without this the scanner matches its own documentation: a comment explaining
 * a past collision contains the very expression it warns about, and the check
 * reports a port nobody actually binds.
 */
function stripCommentsAndStrings(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/`(?:\\[\s\S]|\$\{[^}]*\}|[^\\`])*`/g, (m) => m.replace(/[^\n]/g, ' '))
    .replace(/'(?:\\.|[^'\\])*'/g, ' ')
    .replace(/"(?:\\.|[^"\\])*"/g, ' ');
}

/** Every port a file actually binds, resolving `SOME_PORT + n` arithmetic. */
function portsBoundBy(source: string): number[] {
  const code = stripCommentsAndStrings(source);
  const ports = new Set<number>();
  const valuesByName = new Map<string, number[]>();

  for (const m of code.matchAll(/const\s+(\w*PORT\w*)\s*=\s*(\d{2,5})\b/g)) {
    const value = Number(m[2]);
    ports.add(value);
    valuesByName.set(m[1], [...(valuesByName.get(m[1]) ?? []), value]);
  }

  // A name can be declared more than once in a file (one per describe block),
  // so every value it takes has to be offset, not just the last.
  for (const m of code.matchAll(/(\w*PORT\w*)\s*\+\s*(\d+)/g)) {
    for (const base of valuesByName.get(m[1]) ?? []) {
      ports.add(base + Number(m[2]));
    }
  }

  return [...ports];
}

describe('spec files do not share TCP ports', () => {
  const specFiles = listSpecFiles(TESTS_DIR);

  it('finds the spec files to check', () => {
    expect(specFiles.length).toBeGreaterThan(50);
  });

  it('assigns every port to at most one file', () => {
    const owners = new Map<number, Set<string>>();

    for (const file of specFiles) {
      const rel = path.relative(TESTS_DIR, file).replace(/\\/g, '/');
      for (const port of portsBoundBy(fs.readFileSync(file, 'utf8'))) {
        if (!owners.has(port)) owners.set(port, new Set());
        owners.get(port)!.add(rel);
      }
    }

    const collisions = [...owners.entries()]
      .filter(([, files]) => files.size > 1)
      .map(([port, files]) => `port ${port}: ${[...files].sort().join(' and ')}`);

    expect(collisions).toEqual([]);
  });

  it('resolves arithmetic ports, not just literal declarations', () => {
    // The guard is only worth having if it sees the derived form that caused
    // the original collision.
    const ports = portsBoundBy('const TEST_PORT = 6606;\nserver.listen(TEST_PORT + 1);');
    expect(ports).toContain(6606);
    expect(ports).toContain(6607);
  });

  it('ignores ports mentioned only in comments or strings', () => {
    const ports = portsBoundBy(
      "// const TEST_PORT = 9999;\n/* TEST_PORT + 1 */\nconst msg = 'const OTHER_PORT = 8888;';"
    );
    expect(ports).not.toContain(9999);
    expect(ports).not.toContain(8888);
  });
});
