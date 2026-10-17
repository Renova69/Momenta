import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { sweepOrphanAlbumDirs } from '../helpers/orphanSweep';
import { query } from '../../server/lib/db';
import { deleteEventFixture } from '../helpers/cleanup';

/**
 * N-162 — the teardown's sweep for album folders a run left on disk. It runs
 * against the developer's real uploads folder, so what it must never remove
 * matters more than what it removes.
 */

let root: string;
let livingEventId: string | null = null;

function albumDir(id: string): string {
  const dir = path.join(root, 'events', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wedding-photo-1.jpg'), 'x');
  return dir;
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'orphan-sweep-'));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

afterAll(async () => {
  await deleteEventFixture(livingEventId);
});

describe('sweepOrphanAlbumDirs (N-162)', () => {
  it('removes a folder made during the run whose album is gone', async () => {
    const since = Date.now() - 1000;
    const orphan = albumDir(randomUUID());

    const removed = await sweepOrphanAlbumDirs([root], since);

    expect(removed).toBe(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });

  it('keeps the folder of an album that still exists', async () => {
    const since = Date.now() - 1000;
    const { rows } = await query<{ id: string }>(
      `INSERT INTO events (title, slug, host_name, host_email, event_date, venue_name, welcome_message)
       VALUES ('Sweep Spec', $1, 'Host', 'sweep@test.com', NOW(), 'Venue', 'Welcome') RETURNING id::text AS id`,
      [`sweep-spec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`]
    );
    livingEventId = rows[0].id;
    const living = albumDir(livingEventId);

    await sweepOrphanAlbumDirs([root], since);

    expect(fs.existsSync(living)).toBe(true);
  });

  it('leaves alone anything older than the run, orphan or not', async () => {
    const orphan = albumDir(randomUUID());

    const removed = await sweepOrphanAlbumDirs([root], Date.now() + 60_000);

    expect(removed).toBe(0);
    expect(fs.existsSync(orphan)).toBe(true);
  });

  it('touches only folders named as an album id', async () => {
    const since = Date.now() - 1000;
    const other = path.join(root, 'events', 'not-an-album');
    fs.mkdirSync(other, { recursive: true });

    await sweepOrphanAlbumDirs([root], since);

    expect(fs.existsSync(other)).toBe(true);
  });

  it('does nothing for a root with no events folder', async () => {
    expect(await sweepOrphanAlbumDirs([path.join(root, 'missing')], 0)).toBe(0);
  });
});
