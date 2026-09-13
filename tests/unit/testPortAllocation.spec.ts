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
 * Blank out comments and string/template literal text before scanning.
 *
 * Without this the scanner matches its own documentation: a comment explaining
 * a past collision contains the very expression it warns about, and the check
 * reports a port nobody actually binds.
 *
 * This walks the source once rather than applying a chain of regexes, because
 * the two forms interact. `const BASE_URL = \`http://localhost:${TEST_PORT}\`;`
 * holds a `//` *inside* a template literal, so stripping comments first eats
 * the rest of that line — the closing backtick included. Every later backtick
 * then pairs up one out of step and whole regions of real code get blanked.
 * That is not hypothetical: it is why `server.listen(TEST_PORT + 3)` in
 * retentionPurge.spec.ts was invisible here while the guard reported no
 * collisions at all, and a new spec was waved onto a port already in use.
 *
 * Interpolations are kept as code — `${TEST_PORT + 3}` is a genuine reference
 * to a port that file talks to — while the literal text around them is blanked.
 * Newlines are preserved so line positions stay meaningful.
 */
function stripCommentsAndStrings(source: string): string {
  let out = '';
  let i = 0;
  const blank = (ch: string): string => (ch === '\n' ? '\n' : ' ');

  // One entry per template literal we are inside, holding the brace depth
  // reached within its current `${...}`. Empty means ordinary code.
  const templateBraces: number[] = [];
  let inTemplateText = false;

  while (i < source.length) {
    const ch = source[i];
    const next = source[i + 1] ?? '';

    if (inTemplateText) {
      if (ch === '\\') {
        out += blank(ch) + (i + 1 < source.length ? blank(next) : '');
        i += 2;
      } else if (ch === '`') {
        out += ' ';
        i += 1;
        templateBraces.pop();
        // A nested template can only appear inside an interpolation, so
        // closing one returns to code either way.
        inTemplateText = false;
      } else if (ch === '$' && next === '{') {
        out += '  ';
        i += 2;
        templateBraces[templateBraces.length - 1] = 0;
        inTemplateText = false;
      } else {
        out += blank(ch);
        i += 1;
      }
      continue;
    }

    if (ch === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') out += blank(source[i++]);
      continue;
    }

    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      while (i < stop) out += blank(source[i++]);
      continue;
    }

    if (ch === '"' || ch === "'") {
      out += ' ';
      i += 1;
      while (i < source.length && source[i] !== ch && source[i] !== '\n') {
        if (source[i] === '\\') {
          out += blank(source[i++]);
          if (i < source.length) out += blank(source[i++]);
          continue;
        }
        out += blank(source[i++]);
      }
      if (i < source.length && source[i] === ch) {
        out += ' ';
        i += 1;
      }
      continue;
    }

    if (ch === '`') {
      out += ' ';
      i += 1;
      templateBraces.push(0);
      inTemplateText = true;
      continue;
    }

    if (templateBraces.length > 0 && ch === '{') {
      templateBraces[templateBraces.length - 1] += 1;
      out += ch;
      i += 1;
      continue;
    }

    if (templateBraces.length > 0 && ch === '}') {
      if (templateBraces[templateBraces.length - 1] === 0) {
        out += ' ';
        i += 1;
        inTemplateText = true;
      } else {
        templateBraces[templateBraces.length - 1] -= 1;
        out += ch;
        i += 1;
      }
      continue;
    }

    out += ch;
    i += 1;
  }

  return out;
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

  it('is not thrown off by a // inside a template literal', () => {
    // The regression this guard was silently failing on. Every spec file here
    // opens with exactly this pair of lines, so a stripper that reads the `//`
    // in `http://` as a comment loses the closing backtick and then blanks
    // arbitrary code further down — which is how a real collision got through.
    const ports = portsBoundBy(
      [
        'const TEST_PORT = 6616;',
        'const BASE_URL = `http://localhost:${TEST_PORT}`;',
        'server.listen(TEST_PORT + 3);',
      ].join('\n')
    );

    expect(ports).toContain(6616);
    expect(ports).toContain(6619);
  });

  it('keeps reading code after a string holding an unmatched backtick', () => {
    const ports = portsBoundBy(
      ['const label = "a ` backtick";', 'const TEST_PORT = 7001;', 'server.listen(TEST_PORT + 2);'].join(
        '\n'
      )
    );

    expect(ports).toContain(7001);
    expect(ports).toContain(7003);
  });

  it('reads code inside a nested interpolation', () => {
    const ports = portsBoundBy(
      ['const TEST_PORT = 7100;', 'const url = `a${`b${TEST_PORT + 5}c`}d`;'].join('\n')
    );

    expect(ports).toContain(7105);
  });
});
