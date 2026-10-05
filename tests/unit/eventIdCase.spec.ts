import { describe, it, expect } from 'vitest';
import fs from 'fs';
import { storageAdapter, storagePathBelongsToEvent } from '../../server/lib/storage';
import { isLiveEventId } from '../../scripts/storage-orphan-sweep';
import { findLocalOrphans } from '../../scripts/storage-orphans';
import os from 'os';
import path from 'path';

/**
 * N-50 — Postgres matches a uuid in any case, so an upload addressed with
 * `ABCD…` reached the right album. But the storage path kept the caller's
 * casing, while the orphan sweeps built their list of live albums from the
 * database's lowercase ids and compared case-sensitively. A live album's
 * uppercase folder read as an orphan, and `--delete` would remove it. The ZIP
 * export compared case-sensitively too, so it skipped every such photo.
 *
 * Paths are now built from the lowercase id, and every comparison between a
 * path and an album ignores case. No first-party client sends an uppercase
 * id; a third-party tool or a hand-typed one would.
 */

const LOWER = 'abcdef01-2345-4678-89ab-cdef01234567';
const UPPER = LOWER.toUpperCase();

describe('event ids in storage paths (N-50)', () => {
  it('stores a file under the lowercase id, whatever case it was addressed with', async () => {
    const saved = await storageAdapter.save(Buffer.from('x'), 'case-spec.jpg', 'image/jpeg', UPPER);
    try {
      expect(saved.storagePath).toContain(`/events/${LOWER}/`);
      expect(saved.storagePath).not.toContain(UPPER);
    } finally {
      await storageAdapter.delete(saved.storagePath).catch(() => undefined);
      await storageAdapter.removeEventDirectory?.(LOWER);
    }
  });

  it('matches a path to its album whatever the case of either', () => {
    expect(storagePathBelongsToEvent(`/uploads/events/${UPPER}/photo.jpg`, LOWER)).toBe(true);
    expect(storagePathBelongsToEvent(`/uploads/events/${LOWER}/photo.jpg`, UPPER)).toBe(true);
  });

  it('still refuses a path from another album', () => {
    expect(storagePathBelongsToEvent(`/uploads/events/${UPPER}/photo.jpg`, '00000000-0000-4000-8000-000000000000')).toBe(
      false
    );
  });

  it('the R2 and disk sweep treats an uppercase folder of a live album as live', () => {
    expect(isLiveEventId(new Set([LOWER]), UPPER)).toBe(true);
    expect(isLiveEventId(new Set([LOWER]), '00000000-0000-4000-8000-000000000000')).toBe(false);
  });

  it('storage:orphans treats it as live too, before it ever asks the database', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wedmoments-case-'));
    try {
      const eventsRoot = path.join(tmp, 'events');
      fs.mkdirSync(path.join(eventsRoot, UPPER), { recursive: true });
      const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
      fs.utimesSync(path.join(eventsRoot, UPPER), old, old);

      const { orphans } = await findLocalOrphans([{ label: 'uploads', eventsRoot }], { knownIds: new Set([LOWER]) });

      expect(orphans).toEqual([]);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
