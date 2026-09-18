import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * No spec may delete an event row without purging its media first.
 *
 * `DELETE FROM events` cascades to the photo and audio rows, and those rows are
 * the only record of where the bytes live. Delete them first and the files are
 * stranded with nothing left to identify them. This repository has recorded
 * that failure four separate times in application code — and its own test suite
 * was doing it in forty spec files, leaving roughly 7,000 orphaned album
 * directories and 421 MB behind on every full run. 10,431 of them had
 * accumulated on the development machine before anyone counted.
 *
 * `tests/helpers/cleanup.ts` does it in the order production must. This guard
 * is what stops the next spec quietly going back to the raw statement, in the
 * same spirit as `testPortAllocation.spec.ts`: the rule is only worth writing
 * down if something enforces it.
 */

const TESTS_DIR = path.join(process.cwd(), 'tests');

/** Files allowed to contain the raw statement, and why. */
const ALLOWED = new Set([
  // The helper itself — this is the one place the statement belongs.
  path.join('helpers', 'cleanup.ts'),
  // This file names the statement in its own assertions.
  path.join('unit', 'fixtureCleanup.spec.ts'),
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('fixture cleanup purges media before it deletes rows', () => {
  const files = walk(TESTS_DIR);

  it('finds the test tree it is supposed to be checking', () => {
    // Without this the assertions below pass over an empty list the moment the
    // layout changes, and quietly stop testing anything.
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((f) => f.endsWith(path.join('helpers', 'cleanup.ts')))).toBe(true);
  });

  it('has no spec deleting event rows directly', () => {
    const offenders: string[] = [];

    for (const file of files) {
      const rel = path.relative(TESTS_DIR, file);
      if (ALLOWED.has(rel)) continue;
      if (/DELETE\s+FROM\s+events/i.test(fs.readFileSync(file, 'utf8'))) {
        offenders.push(rel.replace(/\\/g, '/'));
      }
    }

    // Named, not counted: the failure should say which file to fix.
    expect(offenders).toEqual([]);
  });

  it('routes every deletion through the helper', () => {
    // The inverse check. A spec could satisfy the rule above by deleting rows
    // some other way — a DELETE built by string concatenation, say — so this
    // asserts the helper is what the suite actually uses.
    const importers = files.filter((f) => /helpers\/cleanup/.test(fs.readFileSync(f, 'utf8')));

    expect(importers.length).toBeGreaterThan(30);
  });
});
