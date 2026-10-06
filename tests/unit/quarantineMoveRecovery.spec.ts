import { describe, it, expect, vi, afterAll, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LocalStorageAdapter, R2StorageAdapter, storageAdapter, toStoragePath } from '../../server/lib/storage';
import { promotePhotoFromQuarantine, withholdPhotoToQuarantine } from '../../server/lib/photoQuarantine';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * N-70 — promoting or withholding a photo moves three files and then writes
 * the row, and the row was written only if all three moves succeeded. One
 * failed move, or a failed write after them, left the row naming files that
 * had already moved. Every retry then tried to move a source that was no
 * longer there and failed the same way, for good: the photo stayed invisible,
 * or stayed public after the host had rejected it.
 *
 * A move whose source is gone but whose target exists has already happened,
 * and the row now records each move as it lands.
 */

afterEach(() => {
  vi.restoreAllMocks();
});

describe('moving a file that an earlier attempt already moved (local storage)', () => {
  const uploads = path.resolve(process.cwd(), 'tmp_n70_uploads');
  const quarantine = path.resolve(process.cwd(), 'tmp_n70_quarantine');
  const adapter = new LocalStorageAdapter(uploads, quarantine);

  afterAll(async () => {
    for (const dir of [uploads, quarantine]) await fs.promises.rm(dir, { recursive: true, force: true });
  });

  it('reports a promotion that already happened as done', async () => {
    const saved = await adapter.save(Buffer.from('bytes'), 'moved.jpg', 'image/jpeg', 'n70-a', { quarantine: true });
    await adapter.promoteFromQuarantine(saved.storagePath);

    const again = await adapter.promoteFromQuarantine(saved.storagePath);

    expect(again.storagePath).toBe('/uploads/events/n70-a/moved.jpg');
  });

  it('reports a withholding that already happened as done', async () => {
    const saved = await adapter.save(Buffer.from('bytes'), 'held.jpg', 'image/jpeg', 'n70-b');
    await adapter.demoteToQuarantine(saved.storagePath);

    const again = await adapter.demoteToQuarantine(saved.storagePath);

    expect(again.storagePath).toBe('/quarantine/events/n70-b/held.jpg');
  });

  it('still refuses a file that is in neither place', async () => {
    await expect(adapter.promoteFromQuarantine('/quarantine/events/n70-c/never.jpg')).rejects.toThrow(/missing/);
    await expect(adapter.demoteToQuarantine('/uploads/events/n70-c/never.jpg')).rejects.toThrow(/missing/);
  });
});

describe('moving an object that an earlier attempt already moved (R2)', () => {
  function notFound(name: string): Error {
    const err = new Error('not found');
    err.name = name;
    return err;
  }

  function r2With(send: ReturnType<typeof vi.fn>): R2StorageAdapter {
    const r2 = new R2StorageAdapter();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r2 as any).s3 = { send };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r2 as any).publicBaseUrl = 'https://pub-test.r2.dev';
    return r2;
  }

  const commandName = (call: unknown[]) => (call[0] as { constructor: { name: string } }).constructor.name;

  it('reports a promotion as done when the source is gone and the target is there', async () => {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CopyObjectCommand') throw notFound('NoSuchKey');
      return {};
    });
    const r2 = r2With(send);

    const result = await r2.promoteFromQuarantine('https://pub-test.r2.dev/quarantine/events/e1/photo.jpg');

    expect(result.storagePath).toBe('https://pub-test.r2.dev/events/e1/photo.jpg');
    const head = send.mock.calls.find((c) => commandName(c) === 'HeadObjectCommand');
    expect((head?.[0] as { input: { Key: string } }).input.Key).toBe('events/e1/photo.jpg');
  });

  it('reports a withholding as done when the source is gone and the target is there', async () => {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CopyObjectCommand') throw notFound('NoSuchKey');
      return {};
    });
    const r2 = r2With(send);

    const result = await r2.demoteToQuarantine('https://pub-test.r2.dev/events/e1/photo.jpg');

    expect(result.storagePath).toBe('https://pub-test.r2.dev/quarantine/events/e1/photo.jpg');
  });

  it('still fails when the object is in neither place', async () => {
    const send = vi.fn(async (command: { constructor: { name: string } }) => {
      if (command.constructor.name === 'CopyObjectCommand') throw notFound('NoSuchKey');
      if (command.constructor.name === 'HeadObjectCommand') throw notFound('NotFound');
      return {};
    });
    const r2 = r2With(send);

    await expect(r2.promoteFromQuarantine('https://pub-test.r2.dev/quarantine/events/e1/gone.jpg')).rejects.toThrow();
  });

  it('does not treat an outage as an object already moved', async () => {
    const send = vi.fn().mockRejectedValue(new Error('connect ETIMEDOUT'));
    const r2 = r2With(send);

    await expect(r2.promoteFromQuarantine('https://pub-test.r2.dev/quarantine/events/e1/photo.jpg')).rejects.toThrow(
      'connect ETIMEDOUT'
    );
    expect(send.mock.calls.some((c) => commandName(c) === 'HeadObjectCommand')).toBe(false);
  });
});

describe('a photo whose files moved only in part (N-70)', () => {
  const createdEvents: string[] = [];

  afterAll(async () => {
    await deleteEventFixtures(createdEvents);
  });

  interface PhotoRow {
    storage_path: string;
    original_storage_path: string;
    thumbnail_url: string;
    full_url: string;
    original_url: string;
    is_quarantined: boolean;
  }

  async function quarantinedPhoto(): Promise<string> {
    const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const event = await query<{ id: string }>(
      `INSERT INTO events (slug, title, host_name, host_email, event_date)
       VALUES ($1, 'N-70 Spec', 'Spec Host', 'n70@test.local', CURRENT_DATE) RETURNING id`,
      [`n70-${tag}`]
    );
    const eventId = event.rows[0].id;
    createdEvents.push(eventId);
    const guest = await query<{ id: string }>(`INSERT INTO guests (event_id, name) VALUES ($1, 'G') RETURNING id`, [
      eventId,
    ]);
    const [display, original, thumb] = await Promise.all(
      ['display', 'original', 'thumb'].map((v) =>
        storageAdapter.save(Buffer.from(v), `${v}-${tag}.jpg`, 'image/jpeg', eventId, { quarantine: true })
      )
    );
    const photo = await query<{ id: string }>(
      `INSERT INTO photos (event_id, guest_id, storage_path, full_url, original_storage_path, original_url,
                           thumbnail_url, status, is_quarantined, storage_bytes)
       VALUES ($1, $2, $3, $3, $4, $4, $5, 'approved', true, 0) RETURNING id`,
      [eventId, guest.rows[0].id, display.storagePath, original.storagePath, thumb.storagePath]
    );
    return photo.rows[0].id;
  }

  async function rowOf(photoId: string): Promise<PhotoRow> {
    const { rows } = await query<PhotoRow>(
      `SELECT storage_path, original_storage_path, thumbnail_url, full_url, original_url, is_quarantined
         FROM photos WHERE id = $1`,
      [photoId]
    );
    return rows[0];
  }

  function onDisk(storagePath: string | null): boolean {
    const abs = storagePath ? storageAdapter.getAbsolutePath(storagePath) : null;
    return !!abs && fs.existsSync(abs);
  }

  /** Make one move fail, the way a storage error would, and let the others through. */
  function failMovesOf(method: 'promoteFromQuarantine' | 'demoteToQuarantine', match: string) {
    const real = storageAdapter[method].bind(storageAdapter);
    return vi.spyOn(storageAdapter, method).mockImplementation(async (p: string) => {
      if (p.includes(match)) throw new Error('storage blip');
      return real(p);
    });
  }

  it('records the copies that did move when one promotion fails', async () => {
    const photoId = await quarantinedPhoto();
    failMovesOf('promoteFromQuarantine', '/thumb-');

    await expect(promotePhotoFromQuarantine(photoId)).rejects.toThrow('storage blip');

    const row = await rowOf(photoId);
    expect(row.storage_path).toMatch(/^\/uploads\//);
    expect(row.original_storage_path).toMatch(/^\/uploads\//);
    expect(onDisk(row.storage_path)).toBe(true);
    expect(onDisk(row.original_storage_path)).toBe(true);
    // Not every copy is public yet, so the row must not say so.
    expect(row.thumbnail_url).toContain('/quarantine/');
    expect(row.is_quarantined).toBe(true);
  });

  it('finishes the promotion on the next attempt', async () => {
    const photoId = await quarantinedPhoto();
    const blip = failMovesOf('promoteFromQuarantine', '/thumb-');
    await promotePhotoFromQuarantine(photoId).catch(() => undefined);
    blip.mockRestore();

    await promotePhotoFromQuarantine(photoId);

    const row = await rowOf(photoId);
    expect(row.is_quarantined).toBe(false);
    for (const p of [row.storage_path, row.original_storage_path, toStoragePath(row.thumbnail_url)]) {
      expect(p).toMatch(/^\/uploads\//);
      expect(onDisk(p)).toBe(true);
    }
  });

  it('recovers when every file moved but the row was never written', async () => {
    // The process stopped between the moves and the UPDATE.
    const photoId = await quarantinedPhoto();
    const before = await rowOf(photoId);
    for (const p of [before.storage_path, before.original_storage_path, before.thumbnail_url]) {
      await storageAdapter.promoteFromQuarantine(p);
    }

    await promotePhotoFromQuarantine(photoId);

    const row = await rowOf(photoId);
    expect(row.is_quarantined).toBe(false);
    expect(row.storage_path).toMatch(/^\/uploads\//);
    expect(onDisk(row.storage_path)).toBe(true);
  });

  it('records the copies that were withheld when one withholding fails, and finishes on retry', async () => {
    const photoId = await quarantinedPhoto();
    await promotePhotoFromQuarantine(photoId);
    const blip = failMovesOf('demoteToQuarantine', '/original-');

    await expect(withholdPhotoToQuarantine(photoId)).rejects.toThrow('storage blip');

    const partial = await rowOf(photoId);
    expect(partial.storage_path).toContain('/quarantine/');
    expect(onDisk(partial.storage_path)).toBe(true);
    expect(partial.original_storage_path).toMatch(/^\/uploads\//);
    expect(partial.is_quarantined).toBe(false);

    blip.mockRestore();
    await withholdPhotoToQuarantine(photoId);

    const row = await rowOf(photoId);
    expect(row.is_quarantined).toBe(true);
    for (const p of [row.storage_path, row.original_storage_path, toStoragePath(row.thumbnail_url)]) {
      expect(p).toContain('/quarantine/');
      expect(onDisk(p)).toBe(true);
    }
  });
});
