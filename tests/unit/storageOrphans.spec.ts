import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { eventIdFromKey, localEventRoots, removeOrphanDirs } from '../../scripts/storage-orphans';
import { CONFIG } from '../../server/lib/config';

/**
 * Which stored object belongs to which album.
 *
 * This one function decides what `npm run storage:orphans -- --delete` removes
 * from a live bucket, so the interesting cases are all the ones where it should
 * answer "I don't know". An orphan wrongly kept costs a few cents a year. An
 * object wrongly classified as an orphan is somebody's wedding, deleted, with
 * no copy anywhere — the bucket is the copy.
 *
 * So the rule the tests below pin is deliberately lopsided: anything not
 * clearly inside a recognised event-scoped layout returns null and is left
 * alone, whatever it looks like.
 */

const EVENT = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

describe('keys the scan must attribute to an event', () => {
  it('reads a public photo key', () => {
    expect(eventIdFromKey(`events/${EVENT}/wedding-photo-1789.jpg`)).toBe(EVENT);
  });

  it('reads a quarantined key, which lives one level deeper', () => {
    // Missing this prefix would leave every pending-moderation photo
    // unattributed — and, before the safe default below, deletable.
    expect(eventIdFromKey(`quarantine/events/${EVENT}/wedding-photo-1789.jpg`)).toBe(EVENT);
  });

  it('reads a key nested below the event folder', () => {
    expect(eventIdFromKey(`events/${EVENT}/originals/wedding-original-1789.jpg`)).toBe(EVENT);
  });

  it('reads an audio key, which shares the layout', () => {
    expect(eventIdFromKey(`events/${EVENT}/audio-message-1789.webm`)).toBe(EVENT);
  });
});

describe('keys the scan must refuse to attribute', () => {
  it('refuses a bare directory marker with no object under it', () => {
    // `events/<id>/` is a prefix, not a file to reclaim.
    expect(eventIdFromKey(`events/${EVENT}/`)).toBeNull();
  });

  it('refuses a key with no event segment', () => {
    expect(eventIdFromKey('events/')).toBeNull();
    expect(eventIdFromKey('events')).toBeNull();
  });

  it('refuses anything outside the events layout', () => {
    // Something else's bucket prefix, a backup, a stray upload — none of it is
    // this script's to delete.
    expect(eventIdFromKey('backups/2026-09-01.tar.gz')).toBeNull();
    expect(eventIdFromKey('exports/monika-and-alexander.zip')).toBeNull();
    expect(eventIdFromKey('favicon.ico')).toBeNull();
    expect(eventIdFromKey('')).toBeNull();
  });

  it('refuses a key that only mentions events further along', () => {
    // The anchor is deliberate: matching `events/` anywhere in the key would
    // attribute someone else's object to an album id it happens to contain.
    expect(eventIdFromKey(`archive/events/${EVENT}/photo.jpg`)).toBeNull();
    expect(eventIdFromKey(`someone-elses-events/${EVENT}/photo.jpg`)).toBeNull();
  });

  it('refuses a quarantine key that is not event-scoped', () => {
    expect(eventIdFromKey('quarantine/loose-file.jpg')).toBeNull();
    expect(eventIdFromKey('quarantine/events/')).toBeNull();
  });
});

describe('the shape of the answer', () => {
  it('returns the id exactly, without the surrounding path', () => {
    // The id is compared against `SELECT id FROM events` by string equality, so
    // a stray slash or prefix would make every object look unreferenced.
    const id = eventIdFromKey(`events/${EVENT}/wedding-photo.jpg`);

    expect(id).toBe(EVENT);
    expect(id).not.toContain('/');
    expect(id).not.toContain('events');
  });

  it('does not lowercase or otherwise rewrite the id', () => {
    // Postgres returns uuids lowercased; rewriting here would break the
    // comparison in one direction only, which is the hardest kind to notice.
    const mixed = 'A0EEBC99-9c0b-4ef8-bb6d-6bb9bd380a11';
    expect(eventIdFromKey(`events/${mixed}/photo.jpg`)).toBe(mixed);
  });
});

/**
 * What the sweep walks, and what it claims afterwards.
 *
 * Both of the behaviours below were added after running the thing on a real
 * machine rather than reading it. Neither was visible from the source.
 */

const scratchDirs: string[] = [];

function makeOrphan(
  files: number,
  bytes: number
): { dir: string; entry: Parameters<typeof removeOrphanDirs>[0][number] } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-spec-'));
  scratchDirs.push(dir);
  for (let i = 0; i < files; i += 1) {
    fs.writeFileSync(path.join(dir, `wedding-photo-${i}.jpg`), Buffer.alloc(bytes / files || 1));
  }
  return { dir, entry: { eventId: path.basename(dir), dir, files, bytes } };
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of scratchDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('which local trees get swept', () => {
  it('walks the quarantine tree, not only uploads', () => {
    // QUARANTINE_DIR defaults to a *sibling* of the uploads directory rather
    // than a child, so a sweep that walks UPLOADS_DIR alone never sees a byte
    // of it — and quarantine is where full-size photos sit awaiting
    // moderation. On the machine where this was found it held 2,577 orphaned
    // albums that every previous sweep had reported nothing about.
    fs.mkdirSync(path.join(CONFIG.UPLOADS_DIR, 'events'), { recursive: true });
    fs.mkdirSync(path.join(CONFIG.QUARANTINE_DIR, 'events'), { recursive: true });

    const labels = localEventRoots().map((r) => r.label);

    expect(labels).toContain('uploads');
    expect(labels).toContain('quarantine');
  });

  it('points each root at events/, never at the directory above it', () => {
    // A root one level too high would make the sweep treat `events` itself as
    // an event id, and every real album under it as an orphan.
    for (const root of localEventRoots()) {
      expect(path.basename(root.eventsRoot)).toBe('events');
    }
  });

  it('drops a root that does not exist rather than failing', () => {
    // Moderation switched off means no quarantine directory, which is not a
    // fault.
    const missing = path.join(os.tmpdir(), `no-such-root-${Date.now()}`);
    vi.spyOn(CONFIG, 'QUARANTINE_DIR', 'get').mockReturnValue(missing);

    expect(localEventRoots().every((r) => fs.existsSync(r.eventsRoot))).toBe(true);
  });
});

describe('what the sweep claims it removed', () => {
  it('counts a directory only once it is actually gone', () => {
    const a = makeOrphan(2, 200);
    const b = makeOrphan(3, 300);

    const result = removeOrphanDirs([a.entry, b.entry]);

    expect(result).toEqual({ removed: 2, failed: 0, reclaimed: 500 });
    expect(fs.existsSync(a.dir)).toBe(false);
    expect(fs.existsSync(b.dir)).toBe(false);
  });

  it('reports a directory that survived removal instead of counting it', () => {
    // The whole reason the verify exists. A real run reported 7234 folders
    // removed while 616 were still on disk: rmSync returned without throwing
    // and without deleting, so the catch never fired and the summary said the
    // bytes were reclaimed. The operator stops looking at that point.
    const survivor = makeOrphan(4, 400);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fs, 'rmSync').mockImplementation(() => undefined);

    const result = removeOrphanDirs([survivor.entry]);

    expect(result.removed).toBe(0);
    expect(result.failed).toBe(1);
    // Nothing was freed, so nothing may be reported as freed.
    expect(result.reclaimed).toBe(0);
  });

  it('counts a throwing removal as failed and keeps going', () => {
    const doomed = makeOrphan(1, 100);
    const fine = makeOrphan(1, 100);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const real = fs.rmSync;
    vi.spyOn(fs, 'rmSync').mockImplementation(((target: fs.PathLike, options?: fs.RmOptions) => {
      if (String(target) === doomed.dir) throw new Error('EBUSY: resource busy or locked');
      return real(target, options);
    }) as typeof fs.rmSync);

    const result = removeOrphanDirs([doomed.entry, fine.entry]);

    // One bad directory must not abandon the rest of the sweep.
    expect(result.failed).toBe(1);
    expect(result.removed).toBe(1);
    expect(result.reclaimed).toBe(100);
  });
});
