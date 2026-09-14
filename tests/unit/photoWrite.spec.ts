import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  savePhotoVariants,
  insertPhotoUnderQuota,
  broadcastPhotoAdded,
  PhotoVariants,
  UploadContext,
} from '../../server/lib/photoWrite';
import { storageAdapter } from '../../server/lib/storage';
import { pool } from '../../server/lib/db';
import { wsManager } from '../../server/ws/wsServer';
import * as tierGate from '../../server/middleware/tierGate';

/**
 * The shared tail of both upload paths.
 *
 * Every photo in the product goes through here — a guest's phone capture and a
 * photographer's DSLR frame alike — and the module's own header names the three
 * rules it exists to hold: nothing is orphaned (DB-05), the quota is re-checked
 * under a lock (SEC-D1), and a quarantined photo is never broadcast with its
 * real URLs (MED-03/SEC-M5).
 *
 * All three were reachable only through the two callers, which means the paths
 * that matter most were the ones nothing exercised directly: what happens when
 * one of three concurrent writes fails, what happens when the locked re-check
 * refuses, and what a host receives versus what a guest receives. Those are
 * failures you cannot see from outside — an orphaned object is invisible by
 * definition, because once the row is gone nothing knows the file exists and it
 * is billed forever.
 *
 * Nothing here touches Postgres or storage for real; this is about the
 * protocol between the pieces, and the integration is already covered by
 * `ingestPipeline.spec.ts` and the upload route specs.
 */

const EVENT = 'aaaaaaaa-1111-4222-8333-444455556666';

function variant(name: string, bytes: number) {
  return { buffer: Buffer.alloc(bytes, 1), filename: name, mimetype: 'image/jpeg' };
}

function variants(withOriginal = true): PhotoVariants {
  return {
    display: variant('p.jpg', 100),
    thumbnail: variant('p-thumb.jpg', 10),
    ...(withOriginal ? { original: variant('p-original.jpg', 1000) } : {}),
  };
}

/** storageAdapter.save resolving to a path derived from the filename. */
function stubSave() {
  return vi.spyOn(storageAdapter, 'save').mockImplementation(async (_b, filename) => ({
    publicUrl: `https://cdn.example.com/${filename}`,
    storagePath: `/uploads/events/${EVENT}/${filename}`,
  }));
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('savePhotoVariants', () => {
  it('writes the display and thumbnail with the caller’s own filenames', async () => {
    // Each path keeps its own naming convention — `wedding-photo-…` for guests,
    // `pro-…` for photographer frames — so the filename is the caller's to
    // choose and this module must not rewrite it.
    const save = stubSave();

    await savePhotoVariants(EVENT, variants(false), false, 'Spec');

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls.map((c) => c[1])).toEqual(['p.jpg', 'p-thumb.jpg']);
  });

  it('writes the original too when there is one', async () => {
    const save = stubSave();

    await savePhotoVariants(EVENT, variants(true), false, 'Spec');

    expect(save.mock.calls.map((c) => c[1])).toEqual(['p.jpg', 'p-thumb.jpg', 'p-original.jpg']);
  });

  it('maps each stored object back to the right rendition', async () => {
    // The results come back from Promise.allSettled positionally, so a mapping
    // bug here would put the thumbnail's path in the display column — every
    // photo in the feed silently served at thumbnail resolution.
    stubSave();

    const saved = await savePhotoVariants(EVENT, variants(true), false, 'Spec');

    expect(saved.display.storagePath).toContain('p.jpg');
    expect(saved.thumbnail.storagePath).toContain('p-thumb.jpg');
    expect(saved.original!.storagePath).toContain('p-original.jpg');
  });

  it('reports no original when none was supplied', async () => {
    stubSave();

    const saved = await savePhotoVariants(EVENT, variants(false), false, 'Spec');

    expect(saved.original).toBeNull();
  });

  it('passes the quarantine flag to every write', async () => {
    // A pending photo whose thumbnail landed on a public path is reachable by
    // anyone who guesses the URL, which is the whole of MED-03.
    const save = stubSave();

    await savePhotoVariants(EVENT, variants(true), true, 'Spec');

    for (const call of save.mock.calls) {
      expect(call[4]).toMatchObject({ quarantine: true });
    }
  });

  it('charges every rendition against the plan', async () => {
    stubSave();

    const saved = await savePhotoVariants(EVENT, variants(true), false, 'Spec');

    expect(saved.totalBytes).toBe(100 + 10 + 1000);
  });

  it('charges only what it wrote when there is no original', async () => {
    stubSave();

    const saved = await savePhotoVariants(EVENT, variants(false), false, 'Spec');

    expect(saved.totalBytes).toBe(110);
  });
});

describe('when one of the writes fails', () => {
  /** Fail whichever filename is named; succeed for the rest. */
  function stubSaveFailing(failFilename: string) {
    return vi.spyOn(storageAdapter, 'save').mockImplementation(async (_b, filename) => {
      if (filename === failFilename) throw new Error('R2 refused the write');
      return {
        publicUrl: `https://cdn.example.com/${filename}`,
        storagePath: `/uploads/events/${EVENT}/${filename}`,
      };
    });
  }

  it('deletes the writes that succeeded before propagating the error', async () => {
    // The bug this closes (DB-05). `Promise.all` gives you only the resolved
    // array, which a rejection never produces — so the siblings that *did*
    // land were never seen again by anything. ingestPipeline had exactly that
    // hole, and an orphan is invisible: nothing references it, nothing 404s,
    // the quota says the space was freed, and it is billed forever.
    stubSaveFailing('p-original.jpg');
    const del = vi.spyOn(storageAdapter, 'delete').mockResolvedValue(undefined);

    await expect(savePhotoVariants(EVENT, variants(true), false, 'Spec')).rejects.toThrow(
      'R2 refused the write'
    );

    const deleted = del.mock.calls.map((c) => c[0]);
    expect(deleted).toHaveLength(2);
    expect(deleted.some((p) => p.includes('p.jpg'))).toBe(true);
    expect(deleted.some((p) => p.includes('p-thumb.jpg'))).toBe(true);
  });

  it('still cleans up when it is the first write that fails', async () => {
    stubSaveFailing('p.jpg');
    const del = vi.spyOn(storageAdapter, 'delete').mockResolvedValue(undefined);

    await expect(savePhotoVariants(EVENT, variants(true), false, 'Spec')).rejects.toThrow();

    expect(del.mock.calls).toHaveLength(2);
  });

  it('propagates the original error rather than a cleanup error', async () => {
    // The caller needs to know why the upload failed. A delete that also fails
    // while tidying up must not replace that with something unrelated.
    stubSaveFailing('p-original.jpg');
    vi.spyOn(storageAdapter, 'delete').mockRejectedValue(new Error('delete also failed'));

    await expect(savePhotoVariants(EVENT, variants(true), false, 'Spec')).rejects.toThrow(
      'R2 refused the write'
    );
  });
});

describe('the cleanup handle', () => {
  it('removes everything that was written', async () => {
    stubSave();
    const del = vi.spyOn(storageAdapter, 'delete').mockResolvedValue(undefined);
    const saved = await savePhotoVariants(EVENT, variants(true), false, 'Spec');

    await saved.cleanup();

    expect(del.mock.calls).toHaveLength(3);
  });

  it('does nothing on a second call', async () => {
    // insertPhotoUnderQuota calls it on every refusal path and again from the
    // catch; a second pass would try to delete objects that are already gone
    // and log failures for work that actually succeeded.
    stubSave();
    const del = vi.spyOn(storageAdapter, 'delete').mockResolvedValue(undefined);
    const saved = await savePhotoVariants(EVENT, variants(true), false, 'Spec');

    await saved.cleanup();
    await saved.cleanup();

    expect(del.mock.calls).toHaveLength(3);
  });

  it('never throws, because the caller is already handling a worse failure', async () => {
    stubSave();
    vi.spyOn(storageAdapter, 'delete').mockRejectedValue(new Error('storage down'));
    const saved = await savePhotoVariants(EVENT, variants(true), false, 'Spec');

    await expect(saved.cleanup()).resolves.toBeUndefined();
  });

  it('says which object it could not remove, under the caller’s log label', async () => {
    // The bytes are now orphaned. A silent catch would make that unrecoverable
    // knowledge; the path in the log is the only way back to them.
    stubSave();
    vi.spyOn(storageAdapter, 'delete').mockRejectedValue(new Error('storage down'));
    const saved = await savePhotoVariants(EVENT, variants(false), false, 'Ingest');

    await saved.cleanup();

    const logged = (console.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    expect(logged.some((c) => String(c[0]).includes('[Ingest]'))).toBe(true);
    expect(logged.some((c) => String(c[0]).includes('p.jpg'))).toBe(true);
  });
});

describe('insertPhotoUnderQuota', () => {
  const CONTEXT = { hostUserId: 'host-1' } as UploadContext;

  function stubClient() {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }), release: vi.fn() };
    vi.spyOn(pool, 'connect').mockResolvedValue(client as never);
    return client;
  }

  function allow(context: UploadContext | null = CONTEXT) {
    vi.spyOn(tierGate, 'getUploadContext').mockResolvedValue(context);
    vi.spyOn(tierGate, 'acquireEventUploadLock').mockResolvedValue(undefined);
    vi.spyOn(tierGate, 'checkUploadAllowance').mockReturnValue({ allowed: true });
  }

  it('takes the lock inside the transaction, then inserts and commits', async () => {
    // The lock is transaction-scoped: taken before BEGIN it would hold nothing,
    // and released at COMMIT rather than by any explicit call.
    const client = stubClient();
    allow();
    const insert = vi.fn().mockResolvedValue({ id: 'photo-1' });

    const outcome = await insertPhotoUnderQuota({
      eventId: EVENT,
      storageBytes: 1110,
      cleanup: vi.fn(),
      insert,
    });

    expect(outcome).toMatchObject({ ok: true, row: { id: 'photo-1' }, hostUserId: 'host-1' });
    expect(client.query.mock.calls[0][0]).toBe('BEGIN');
    expect(tierGate.acquireEventUploadLock).toHaveBeenCalledWith(client, EVENT);
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('re-reads the context on the locked client, not the pool', async () => {
    // Reading it from the pool would return the same stale totals the unlocked
    // check already saw, which is the entire point of SEC-D1.
    const client = stubClient();
    allow();

    await insertPhotoUnderQuota({
      eventId: EVENT,
      deviceFingerprint: 'device-7',
      storageBytes: 1,
      cleanup: vi.fn(),
      insert: vi.fn().mockResolvedValue({}),
    });

    expect(tierGate.getUploadContext).toHaveBeenCalledWith(EVENT, 'device-7', client);
  });

  it('rolls back and removes the files when the event has gone', async () => {
    const client = stubClient();
    allow(null);
    const cleanup = vi.fn();
    const insert = vi.fn();

    const outcome = await insertPhotoUnderQuota({
      eventId: EVENT,
      storageBytes: 1,
      cleanup,
      insert,
    });

    expect(outcome).toEqual({ ok: false, reason: 'event_not_found' });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back and removes the files when the plan is spent', async () => {
    const client = stubClient();
    allow();
    vi.spyOn(tierGate, 'checkUploadAllowance').mockReturnValue({
      allowed: false,
      reason: 'Достигнат е лимитът',
      code: 'STORAGE_LIMIT_REACHED',
    });
    const cleanup = vi.fn();
    const insert = vi.fn();

    const outcome = await insertPhotoUnderQuota({
      eventId: EVENT,
      storageBytes: 1,
      cleanup,
      insert,
    });

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'quota',
      message: 'Достигнат е лимитът',
      code: 'STORAGE_LIMIT_REACHED',
    });
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(insert).not.toHaveBeenCalled();
  });

  it('still says something useful when the check gives no reason', async () => {
    const client = stubClient();
    allow();
    vi.spyOn(tierGate, 'checkUploadAllowance').mockReturnValue({ allowed: false });

    const outcome = await insertPhotoUnderQuota({
      eventId: EVENT,
      storageBytes: 1,
      cleanup: vi.fn(),
      insert: vi.fn(),
    });

    expect(outcome).toMatchObject({
      ok: false,
      reason: 'quota',
      message: 'Plan limit reached',
      code: 'STORAGE_LIMIT_REACHED',
    });
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('rolls back, cleans up and rethrows when the insert itself fails', async () => {
    // A unique-violation or a dropped connection mid-insert: the files are
    // already written, and nothing else will ever know they exist.
    const client = stubClient();
    allow();
    const cleanup = vi.fn();

    await expect(
      insertPhotoUnderQuota({
        eventId: EVENT,
        storageBytes: 1,
        cleanup,
        insert: vi.fn().mockRejectedValue(new Error('duplicate key')),
      })
    ).rejects.toThrow('duplicate key');

    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(client.release).toHaveBeenCalledTimes(1);
  });

  it('releases the connection even when the rollback also fails', async () => {
    // A leaked connection per failed upload exhausts the pool during exactly
    // the burst that caused the failures.
    const client = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql === 'BEGIN') return Promise.resolve({ rows: [] });
        return Promise.reject(new Error('connection lost'));
      }),
      release: vi.fn(),
    };
    vi.spyOn(pool, 'connect').mockResolvedValue(client as never);
    allow();

    await expect(
      insertPhotoUnderQuota({
        eventId: EVENT,
        storageBytes: 1,
        cleanup: vi.fn(),
        insert: vi.fn().mockRejectedValue(new Error('insert failed')),
      })
    ).rejects.toThrow();

    expect(client.release).toHaveBeenCalledTimes(1);
  });
});

describe('broadcastPhotoAdded', () => {
  let toHosts: ReturnType<typeof vi.spyOn>;
  let toEvent: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    toHosts = vi.spyOn(wsManager, 'broadcastToEventHosts').mockImplementation(() => undefined);
    toEvent = vi.spyOn(wsManager, 'broadcastToEvent').mockImplementation(() => undefined);
  });

  const base = {
    eventId: EVENT,
    photoId: 'photo-1',
    photo: { id: 'photo-1', fullUrl: 'https://cdn/real.jpg', thumbnailUrl: 'https://cdn/thumb.jpg' },
    hostUserId: 'host-1',
    hasOriginal: true,
  };

  it('sends a photo awaiting moderation to hosts and never to the guest room', async () => {
    // The rule has to live here and not only on the read path: the REST list
    // filters non-hosts to approved/featured, and a broadcast that skipped the
    // same check would put an unapproved photo straight into every guest feed.
    broadcastPhotoAdded({ ...base, status: 'pending', needsQuarantine: true });

    expect(toHosts).toHaveBeenCalledTimes(1);
    expect(toEvent).not.toHaveBeenCalled();
  });

  it('replaces a quarantined photo’s real URLs with host-scoped preview links', async () => {
    broadcastPhotoAdded({ ...base, status: 'pending', needsQuarantine: true });

    const sent = toHosts.mock.calls[0][2] as Record<string, string>;
    expect(sent.fullUrl).not.toBe('https://cdn/real.jpg');
    expect(sent.fullUrl).toContain('/preview?variant=display');
    expect(sent.thumbnailUrl).toContain('/preview?variant=thumbnail');
    expect(sent.originalUrl).toContain('/preview?variant=original');
  });

  it('offers no original preview when there is no original', async () => {
    broadcastPhotoAdded({ ...base, status: 'pending', needsQuarantine: true, hasOriginal: false });

    expect((toHosts.mock.calls[0][2] as Record<string, unknown>).originalUrl).toBeNull();
  });

  it('sends the photo unchanged when it is pending but not quarantined', async () => {
    // Nothing to substitute: the files are on their ordinary paths, and a
    // preview token would point at objects that are already reachable.
    broadcastPhotoAdded({ ...base, status: 'pending', needsQuarantine: false });

    expect(toHosts.mock.calls[0][2]).toMatchObject({ fullUrl: 'https://cdn/real.jpg' });
  });

  it('sends the photo unchanged when there is no host to scope a token to', async () => {
    broadcastPhotoAdded({
      ...base,
      status: 'pending',
      needsQuarantine: true,
      hostUserId: null,
    });

    expect(toHosts).toHaveBeenCalledTimes(1);
    expect(toHosts.mock.calls[0][2]).toMatchObject({ fullUrl: 'https://cdn/real.jpg' });
  });

  it('sends an approved photo to the whole room', async () => {
    broadcastPhotoAdded({ ...base, status: 'approved', needsQuarantine: false });

    expect(toEvent).toHaveBeenCalledTimes(1);
    expect(toHosts).not.toHaveBeenCalled();
    expect(toEvent.mock.calls[0][2]).toMatchObject({ fullUrl: 'https://cdn/real.jpg' });
  });

  it('strips the image URLs while a disposable album is still locked', async () => {
    // Disposable mode exists so nobody sees anything until the couple's reveal
    // moment. The row is broadcast so the count moves; the picture is not.
    broadcastPhotoAdded({
      ...base,
      status: 'approved',
      needsQuarantine: false,
      lockedUntil: new Date(Date.now() + 3600_000),
    });

    expect(toEvent.mock.calls[0][2]).toMatchObject({ fullUrl: '', thumbnailUrl: '' });
  });

  it('sends the real URLs once the reveal moment has passed', async () => {
    broadcastPhotoAdded({
      ...base,
      status: 'approved',
      needsQuarantine: false,
      lockedUntil: new Date(Date.now() - 1000),
    });

    expect(toEvent.mock.calls[0][2]).toMatchObject({ fullUrl: 'https://cdn/real.jpg' });
  });

  it('sends the real URLs when the album is not disposable at all', async () => {
    broadcastPhotoAdded({
      ...base,
      status: 'approved',
      needsQuarantine: false,
      lockedUntil: null,
    });

    expect(toEvent.mock.calls[0][2]).toMatchObject({ fullUrl: 'https://cdn/real.jpg' });
  });
});
