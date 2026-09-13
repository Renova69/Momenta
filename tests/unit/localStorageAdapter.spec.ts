import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { LocalStorageAdapter } from '../../server/lib/storage';

/**
 * The local disk adapter's path handling, against a throwaway root.
 *
 * `storageAdapter.spec.ts` covers the R2 adapter against a mocked S3 client.
 * This covers the local one, which is what every deployment that is not on
 * Cloudflare actually runs, and specifically the three places where a stored
 * path is treated as a filesystem instruction:
 *
 *   delete() — a storagePath is a database column, so `..` in one is a request
 *   to unlink something outside the uploads root, and an empty relative
 *   segment resolves to the root directory itself (SEC-M6).
 *
 *   promoteFromQuarantine() — this is what makes a moderated photo publicly
 *   reachable. The target path is derived from the stored one, so it has to be
 *   confirmed to land inside the uploads root before anything is copied there.
 *
 *   removeEventDirectory() — called after a purge. It must remove an empty
 *   directory and must *not* force one that still has files in it, because
 *   "still has files" means a delete above failed and those bytes are someone's
 *   wedding.
 *
 * Every case runs against a temporary root, so nothing here can touch the
 * repository's own uploads.
 */

let root: string;
let uploadsDir: string;
let quarantineDir: string;
let adapter: LocalStorageAdapter;
const roots: string[] = [];

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wedmoments-storage-'));
  roots.push(root);
  uploadsDir = path.join(root, 'uploads');
  quarantineDir = path.join(root, 'uploads', 'quarantine');
  adapter = new LocalStorageAdapter(uploadsDir, quarantineDir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
});

describe('saving', () => {
  it('creates the roots it was given', () => {
    expect(fs.existsSync(uploadsDir)).toBe(true);
    expect(fs.existsSync(quarantineDir)).toBe(true);
  });

  it('partitions a file by event', async () => {
    const saved = await adapter.save(Buffer.from('bytes'), 'photo.jpg', 'image/jpeg', 'event-1');

    expect(saved.storagePath).toBe('/uploads/events/event-1/photo.jpg');
    expect(fs.existsSync(path.join(uploadsDir, 'events', 'event-1', 'photo.jpg'))).toBe(true);
  });

  it('writes to the quarantine root when asked', async () => {
    const saved = await adapter.save(Buffer.from('bytes'), 'held.jpg', 'image/jpeg', 'event-1', {
      quarantine: true,
    });

    expect(saved.storagePath).toBe('/quarantine/events/event-1/held.jpg');
    expect(fs.existsSync(path.join(quarantineDir, 'events', 'event-1', 'held.jpg'))).toBe(true);
  });

  it('saves outside any event when none is given', async () => {
    const saved = await adapter.save(Buffer.from('bytes'), 'loose.jpg');
    expect(saved.storagePath).toBe('/uploads/loose.jpg');
  });
});

describe('deleting', () => {
  it('removes a real file', async () => {
    const saved = await adapter.save(Buffer.from('bytes'), 'gone.jpg', 'image/jpeg', 'event-1');

    await adapter.delete(saved.storagePath);

    expect(fs.existsSync(path.join(uploadsDir, 'events', 'event-1', 'gone.jpg'))).toBe(false);
  });

  it('ignores a path under neither root', async () => {
    // Not an error: the caller is working through rows, and a row holding an
    // R2 URL reaches the local adapter during a migration.
    await expect(adapter.delete('/somewhere/else/photo.jpg')).resolves.toBeUndefined();
  });

  it('ignores an empty path', async () => {
    await expect(adapter.delete('')).resolves.toBeUndefined();
  });

  it('refuses to unlink outside its own root', async () => {
    // SEC-M6. storage_path is a column, so `..` in one is a request to delete
    // something the uploads root does not contain.
    const outside = path.join(root, 'outside.txt');
    fs.writeFileSync(outside, 'do not delete me');

    await adapter.delete('/uploads/../outside.txt');

    expect(fs.existsSync(outside)).toBe(true);
  });

  it('refuses to treat the root itself as a delete target', async () => {
    // The whole prefix and nothing after it resolves to the directory.
    await adapter.delete('/uploads/');

    expect(fs.existsSync(uploadsDir)).toBe(true);
  });

  it('will not unlink a directory that happens to be named like a file', async () => {
    fs.mkdirSync(path.join(uploadsDir, 'events', 'event-1', 'photo.jpg'), { recursive: true });

    await adapter.delete('/uploads/events/event-1/photo.jpg');

    expect(fs.existsSync(path.join(uploadsDir, 'events', 'event-1', 'photo.jpg'))).toBe(true);
  });

  it('does not throw for a file that is already gone', async () => {
    await expect(adapter.delete('/uploads/events/event-1/never-existed.jpg')).resolves.toBeUndefined();
  });
});

describe('resolving a path', () => {
  it('returns null for a path under neither root', () => {
    expect(adapter.getAbsolutePath('https://cdn.example.com/x.jpg')).toBeNull();
  });

  it('returns null for a file that does not exist', () => {
    expect(adapter.getAbsolutePath('/uploads/events/e1/missing.jpg')).toBeNull();
  });

  it('returns null for a traversal attempt even when the target exists', () => {
    fs.writeFileSync(path.join(root, 'outside.txt'), 'secret');
    expect(adapter.getAbsolutePath('/uploads/../outside.txt')).toBeNull();
  });

  it('streams a file that is there, and nothing for one that is not', async () => {
    const saved = await adapter.save(Buffer.from('bytes'), 'streamed.jpg', 'image/jpeg', 'e1');

    expect(await adapter.getStream(saved.storagePath)).not.toBeNull();
    expect(await adapter.getStream('/uploads/events/e1/absent.jpg')).toBeNull();
  });
});

describe('promoting out of quarantine', () => {
  it('moves the file into the public root and reports its new path', async () => {
    const held = await adapter.save(Buffer.from('bytes'), 'held.jpg', 'image/jpeg', 'e1', {
      quarantine: true,
    });

    const promoted = await adapter.promoteFromQuarantine(held.storagePath);

    expect(promoted.storagePath).toBe('/uploads/events/e1/held.jpg');
    expect(fs.existsSync(path.join(uploadsDir, 'events', 'e1', 'held.jpg'))).toBe(true);
    // And the quarantined copy is gone, not left as a second reachable object.
    expect(fs.existsSync(path.join(quarantineDir, 'events', 'e1', 'held.jpg'))).toBe(false);
  });

  it('leaves an already-public path alone', async () => {
    // Approving a photo twice must not be an error, and must not move a file
    // that is already where it belongs.
    const saved = await adapter.save(Buffer.from('bytes'), 'public.jpg', 'image/jpeg', 'e1');

    const promoted = await adapter.promoteFromQuarantine(saved.storagePath);

    expect(promoted.storagePath).toBe(saved.storagePath);
  });

  it('throws rather than silently approving a photo whose file is missing', async () => {
    // The caller flips the row to approved on success. Returning quietly here
    // would mark a photo public that has no bytes behind it.
    await expect(
      adapter.promoteFromQuarantine('/quarantine/events/e1/vanished.jpg')
    ).rejects.toThrow(/missing/i);
  });

  it('refuses a traversal path without copying anything into the public root', async () => {
    // Which of the two guards fires here is worth being precise about. The
    // refusal comes from resolving the source: getAbsolutePath confirms the
    // quarantined file sits inside the quarantine root, and `..` fails that,
    // so this throws "file missing" before the target is computed at all.
    //
    // The startsWith(uploadsRoot) check further down is defence in depth that
    // this arithmetic cannot actually reach: both checks apply the same
    // relative segment to their own root, so the net depth change is
    // identical and either both stay inside or both escape. Removing it does
    // not change the outcome of any input — which is the honest reason this
    // test asserts the refusal and the absence of a copy, and not that
    // particular line.
    fs.writeFileSync(path.join(root, 'escaped.jpg'), 'bytes');

    await expect(adapter.promoteFromQuarantine('/quarantine/../escaped.jpg')).rejects.toThrow(
      /missing/i
    );

    expect(fs.existsSync(path.join(uploadsDir, 'escaped.jpg'))).toBe(false);
  });
});

describe('removing an event directory after a purge', () => {
  it('removes one that is empty', async () => {
    const dir = path.join(uploadsDir, 'events', 'e1');
    fs.mkdirSync(dir, { recursive: true });

    await adapter.removeEventDirectory('e1');

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('leaves one that still holds a file', async () => {
    // A non-empty directory after a purge means a delete failed, and what is
    // still in there is someone's wedding. Forcing it would turn a storage
    // leak into data loss.
    const dir = path.join(uploadsDir, 'events', 'e1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'survivor.jpg'), 'bytes');

    await adapter.removeEventDirectory('e1');

    expect(fs.existsSync(path.join(dir, 'survivor.jpg'))).toBe(true);
  });

  it('does not complain about a directory that was never there', async () => {
    await expect(adapter.removeEventDirectory('never-existed')).resolves.toBeUndefined();
  });

  it('clears the quarantine side too', async () => {
    const dir = path.join(quarantineDir, 'events', 'e1');
    fs.mkdirSync(dir, { recursive: true });

    await adapter.removeEventDirectory('e1');

    expect(fs.existsSync(dir)).toBe(false);
  });

  it('does nothing without an event id', async () => {
    await expect(adapter.removeEventDirectory('')).resolves.toBeUndefined();
  });
});
