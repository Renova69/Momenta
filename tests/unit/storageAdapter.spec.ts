import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { LocalStorageAdapter, R2StorageAdapter, createStorageAdapter } from '../../server/lib/storage';

describe('Storage Adapter & Path Containment Spec', () => {
  const testUploadsDir = path.resolve(process.cwd(), 'tmp_test_spec_uploads');
  const testQuarantineDir = path.resolve(process.cwd(), 'tmp_test_spec_quarantine');
  const adapter = new LocalStorageAdapter(testUploadsDir, testQuarantineDir);

  afterAll(async () => {
    for (const dir of [testUploadsDir, testQuarantineDir]) {
      if (fs.existsSync(dir)) {
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    }
  });

  it('saves files to designated uploads directory', async () => {
    const fileBuf = Buffer.from('TEST_PAYLOAD_IMAGE');
    const result = await adapter.save(fileBuf, 'test-spec-image.jpg', 'image/jpeg');

    expect(result.storagePath).toMatch(/^\/uploads\//);
    expect(result.publicUrl).toMatch(/^\/uploads\//);
  });

  it('resolves absolute path and blocks path traversal attempts', async () => {
    const fileBuf = Buffer.from('CONTAINMENT_CHECK');
    const saved = await adapter.save(fileBuf, 'containment.jpg', 'image/jpeg');

    const abs = adapter.getAbsolutePath(saved.storagePath);
    expect(abs).not.toBeNull();
    expect(abs?.startsWith(path.resolve(testUploadsDir))).toBe(true);

    // Traversal checks
    expect(adapter.getAbsolutePath('/uploads/../../etc/shadow')).toBeNull();
    expect(adapter.getAbsolutePath('/uploads/../../../windows/system32')).toBeNull();
    expect(adapter.getAbsolutePath('/uploads_spoofed/file.txt')).toBeNull();
    expect(adapter.getAbsolutePath('')).toBeNull();
  });

  it('provides readable streams and handles deletions safely', async () => {
    const fileBuf = Buffer.from('STREAM_CONTENT');
    const saved = await adapter.save(fileBuf, 'stream-test.jpg', 'image/jpeg');

    const stream = await adapter.getStream(saved.storagePath);
    expect(stream).not.toBeNull();

    if (stream) {
      await new Promise((resolve) => {
        stream.on('data', () => {});
        stream.on('end', resolve);
        stream.on('error', resolve);
      });
    }

    const nonStream = await adapter.getStream('/uploads/not-real.jpg');
    expect(nonStream).toBeNull();

    await adapter.delete(saved.storagePath);
    expect(adapter.getAbsolutePath(saved.storagePath)).toBeNull();

    // Dangerous traversal delete
    await adapter.delete('/uploads/../../package.json');
    expect(fs.existsSync(path.resolve(process.cwd(), 'package.json'))).toBe(true);
  });

  it('never treats the uploads root itself as a deletable/resolvable file (SEC-M6)', async () => {
    // storagePath === '/uploads/' strips down to an empty relative segment,
    // so path.resolve(uploadsDir, '') === uploadsDir itself - the whole
    // directory, not a file.
    expect(adapter.getAbsolutePath('/uploads/')).toBeNull();

    await adapter.delete('/uploads/');
    expect(fs.existsSync(testUploadsDir)).toBe(true);
  });

  it('refuses to unlink a real subdirectory even if one exists under uploads (SEC-M6)', async () => {
    const subdir = path.join(testUploadsDir, 'events');
    if (!fs.existsSync(subdir)) fs.mkdirSync(subdir, { recursive: true });

    await adapter.delete('/uploads/events');
    expect(fs.existsSync(subdir)).toBe(true);
  });

  it('tests R2StorageAdapter methods and factory', async () => {
    const r2 = new R2StorageAdapter();
    expect(r2.getAbsolutePath('any/path')).toBeNull();

    const created = createStorageAdapter();
    expect(created).toBeDefined();
    expect(typeof created.save).toBe('function');
  });

  it('resolves a genuine not-found to null without throwing (MED-06)', async () => {
    const r2 = new R2StorageAdapter();
    const notFound = new Error('The specified key does not exist.');
    notFound.name = 'NoSuchKey';
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r2 as any).s3 = { send: vi.fn().mockRejectedValue(notFound) };

    await expect(r2.getStream('events/e1/missing.jpg')).resolves.toBeNull();
  });

  it('propagates a genuine R2 failure instead of silently dropping the file (MED-06)', async () => {
    const r2 = new R2StorageAdapter();
    const outage = new Error('connect ETIMEDOUT');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (r2 as any).s3 = { send: vi.fn().mockRejectedValue(outage) };

    // Before the fix this resolved to null, indistinguishable from a
    // missing file — export-zip would have silently skipped the photo.
    await expect(r2.getStream('events/e1/real.jpg')).rejects.toThrow('connect ETIMEDOUT');
  });

  describe('removeEventDirectory (G4)', () => {
    it('removes the event directory once every file under it is gone', async () => {
      const eventId = 'g4-empty-dir';
      const dir = path.join(testUploadsDir, 'events', eventId);
      fs.mkdirSync(dir, { recursive: true });

      await adapter.removeEventDirectory!(eventId);

      expect(fs.existsSync(dir)).toBe(false);
    });

    it('leaves a non-empty event directory alone instead of forcing it away', async () => {
      const eventId = 'g4-nonempty-dir';
      const dir = path.join(testUploadsDir, 'events', eventId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'still-here.jpg'), 'not actually deleted');

      await adapter.removeEventDirectory!(eventId);

      // A failed individual file delete upstream must not turn this into a
      // forced recursive removal of real, undeleted media.
      expect(fs.existsSync(dir)).toBe(true);
      expect(fs.existsSync(path.join(dir, 'still-here.jpg'))).toBe(true);
    });

    it('is a no-op when the event directory never existed', async () => {
      await expect(adapter.removeEventDirectory!('g4-never-existed')).resolves.not.toThrow();
    });
  });

  describe('quarantine (MED-03/SEC-M5)', () => {
    it('saves a quarantined file outside the public uploads root entirely', async () => {
      const eventId = 'med03-event';
      const buf = Buffer.from('pending photo bytes');
      const saved = await adapter.save(buf, 'pending.jpg', 'image/jpeg', eventId, { quarantine: true });

      expect(saved.storagePath).toBe(`/quarantine/events/${eventId}/pending.jpg`);
      // Not reachable under the publicly-served uploads root at all.
      expect(fs.existsSync(path.join(testUploadsDir, 'events', eventId, 'pending.jpg'))).toBe(false);
      // Really is on disk, just under the quarantine root instead.
      expect(fs.existsSync(path.join(testQuarantineDir, 'events', eventId, 'pending.jpg'))).toBe(true);
    });

    it('streams and deletes a quarantined file the same way it does a public one', async () => {
      const eventId = 'med03-stream';
      const buf = Buffer.from('quarantined stream bytes');
      const saved = await adapter.save(buf, 'stream.jpg', 'image/jpeg', eventId, { quarantine: true });

      const stream = await adapter.getStream(saved.storagePath);
      expect(stream).not.toBeNull();

      // Read it to the end before deleting, rather than leaving it open.
      // `fs.createReadStream` opens the file asynchronously, so an unconsumed
      // stream races the unlink below: on Linux the delete wins, the open then
      // fails with ENOENT, and with nothing listening for 'error' Node raises
      // it as an uncaught exception that fails the whole run while every test
      // still reports as passing. Consuming it also makes the test check what
      // its name claims — that the bytes come back — instead of only that a
      // stream object was returned.
      const chunks: Buffer[] = [];
      for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('quarantined stream bytes');

      await adapter.delete(saved.storagePath);
      expect(fs.existsSync(path.join(testQuarantineDir, 'events', eventId, 'stream.jpg'))).toBe(false);
    });

    it('promotes a quarantined file to the public path and removes the quarantine copy', async () => {
      const eventId = 'med03-promote';
      const buf = Buffer.from('now approved bytes');
      const saved = await adapter.save(buf, 'approved.jpg', 'image/jpeg', eventId, { quarantine: true });

      const promoted = await adapter.promoteFromQuarantine(saved.storagePath);

      expect(promoted.storagePath).toBe(`/uploads/events/${eventId}/approved.jpg`);
      const publicPath = path.join(testUploadsDir, 'events', eventId, 'approved.jpg');
      expect(fs.existsSync(publicPath)).toBe(true);
      expect(fs.readFileSync(publicPath, 'utf8')).toBe('now approved bytes');
      // The quarantine copy is gone, not duplicated.
      expect(fs.existsSync(path.join(testQuarantineDir, 'events', eventId, 'approved.jpg'))).toBe(false);
    });

    it('treats promoting an already-public path as a harmless no-op', async () => {
      const saved = await adapter.save(Buffer.from('already public'), 'public.jpg', 'image/jpeg', 'med03-noop');
      const result = await adapter.promoteFromQuarantine(saved.storagePath);
      expect(result.storagePath).toBe(saved.storagePath);
    });

    it('R2: prefixes the object key with quarantine/ and omits it once saved publicly', async () => {
      const r2 = new R2StorageAdapter();
      const sendSpy = vi.fn().mockResolvedValue({});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r2 as any).s3 = { send: sendSpy };

      await r2.save(Buffer.from('x'), 'photo.jpg', 'image/jpeg', 'e1', { quarantine: true });
      expect(sendSpy.mock.calls[0][0].input.Key).toBe('quarantine/events/e1/photo.jpg');

      await r2.save(Buffer.from('x'), 'photo.jpg', 'image/jpeg', 'e1');
      expect(sendSpy.mock.calls[1][0].input.Key).toBe('events/e1/photo.jpg');
    });

    it('R2: promotion copies quarantine -> public key, then deletes the quarantine key', async () => {
      const r2 = new R2StorageAdapter();
      const sendSpy = vi.fn().mockResolvedValue({});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r2 as any).s3 = { send: sendSpy };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r2 as any).publicBaseUrl = 'https://pub-test.r2.dev';

      const result = await r2.promoteFromQuarantine('https://pub-test.r2.dev/quarantine/events/e1/photo.jpg');

      expect(sendSpy).toHaveBeenCalledTimes(2);
      const copyCall = sendSpy.mock.calls[0][0].input;
      expect(copyCall.CopySource).toContain('quarantine/events/e1/photo.jpg');
      expect(copyCall.Key).toBe('events/e1/photo.jpg');
      const deleteCall = sendSpy.mock.calls[1][0].input;
      expect(deleteCall.Key).toBe('quarantine/events/e1/photo.jpg');
      expect(result.storagePath).toBe('https://pub-test.r2.dev/events/e1/photo.jpg');
    });

    it('R2: leaves an already-public key untouched when asked to promote it', async () => {
      const r2 = new R2StorageAdapter();
      const sendSpy = vi.fn().mockResolvedValue({});
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (r2 as any).s3 = { send: sendSpy };

      const result = await r2.promoteFromQuarantine('https://pub-test.r2.dev/events/e1/photo.jpg');
      expect(sendSpy).not.toHaveBeenCalled();
      expect(result.storagePath).toBe('https://pub-test.r2.dev/events/e1/photo.jpg');
    });
  });
});
