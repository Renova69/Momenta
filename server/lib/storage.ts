import fs from 'fs';
import path from 'path';
import { S3Client, PutObjectCommand, DeleteObjectCommand, GetObjectCommand, CopyObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import { CONFIG } from './config';

// Slug generation is shared with the client so both produce identical URLs.
export { transliterateBg, cleanSlug } from '../../shared/transliterate';

export interface SaveOptions {
  /**
   * MED-03/SEC-M5 — a photo pending moderation, or still disposable-locked,
   * must not be reachable at a public URL at all: `express.static` serves
   * everything under `UPLOADS_DIR` with zero auth, and API-level filtering
   * (hiding pending/locked rows from non-hosts) does nothing to stop someone
   * who has, guesses, or leaks the raw file URL directly. `quarantine: true`
   * saves the file somewhere that mount doesn't reach at all.
   */
  quarantine?: boolean;
}

export interface StorageAdapter {
  save(buffer: Buffer, filename: string, mimetype?: string, eventId?: string, options?: SaveOptions): Promise<{ publicUrl: string; storagePath: string }>;
  delete(storagePath: string): Promise<void>;
  getAbsolutePath(storagePath: string): string | null;
  getStream(storagePath: string): Promise<Readable | null>;
  /**
   * G4 — best-effort cleanup of an event's now-empty storage directory after
   * every file under it has been deleted (e.g. a retention purge). Optional
   * because it's only meaningful for adapters with real directories; R2 keys
   * have no filesystem-style folder to remove.
   */
  removeEventDirectory?(eventId: string): Promise<void>;
  /**
   * Move a quarantined object to its normal public location, once it is
   * safe to be public (moderation approved it, or a disposable reveal
   * passed). A no-op — returns the input unchanged — for a path that was
   * never quarantined, so callers can call this unconditionally.
   */
  promoteFromQuarantine(storagePath: string): Promise<{ publicUrl: string; storagePath: string }>;
}

// 1. Local Disk Storage Adapter
export class LocalStorageAdapter implements StorageAdapter {
  private uploadsDir: string;
  private quarantineDir: string;

  constructor(uploadsDir: string = CONFIG.UPLOADS_DIR, quarantineDir: string = CONFIG.QUARANTINE_DIR) {
    this.uploadsDir = uploadsDir;
    this.quarantineDir = quarantineDir;
    if (!fs.existsSync(this.uploadsDir)) {
      fs.mkdirSync(this.uploadsDir, { recursive: true });
    }
    if (!fs.existsSync(this.quarantineDir)) {
      fs.mkdirSync(this.quarantineDir, { recursive: true });
    }
  }

  /** Which root + URL prefix a storagePath belongs under, or null if neither. */
  private resolveRoot(storagePath: string): { root: string; prefix: string } | null {
    if (!storagePath) return null;
    if (storagePath.startsWith('/quarantine/')) return { root: this.quarantineDir, prefix: '/quarantine/' };
    if (storagePath.startsWith('/uploads/')) return { root: this.uploadsDir, prefix: '/uploads/' };
    return null;
  }

  public async save(buffer: Buffer, filename: string, _mimetype?: string, eventId?: string, options?: SaveOptions): Promise<{ publicUrl: string; storagePath: string }> {
    const root = options?.quarantine ? this.quarantineDir : this.uploadsDir;
    const urlPrefix = options?.quarantine ? '/quarantine' : '/uploads';
    const targetDir = eventId ? path.join(root, 'events', eventId) : root;
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }

    const filePath = path.join(targetDir, filename);
    await fs.promises.writeFile(filePath, buffer);

    const relativePath = eventId ? `${urlPrefix}/events/${eventId}/${filename}` : `${urlPrefix}/${filename}`;
    return {
      publicUrl: relativePath,
      storagePath: relativePath,
    };
  }

  public async delete(storagePath: string): Promise<void> {
    const resolved = this.resolveRoot(storagePath);
    if (!resolved) return;
    const relative = storagePath.replace(resolved.prefix, '');
    const filePath = path.resolve(resolved.root, relative);
    const root = path.resolve(resolved.root);
    // SEC-M6: filePath === root happens for an empty relative segment (the
    // whole prefix and nothing else) - that must never be a valid delete
    // target, it's the whole directory, not a file. Require a real file
    // strictly inside the root, and confirm it actually is one (not a
    // directory) before unlinking.
    if (!filePath.startsWith(root + path.sep)) return;
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) return;
    } catch {
      return;
    }
    await fs.promises.unlink(filePath);
    console.log(`[LocalStorage] Deleted physical file: ${relative}`);
  }

  public getAbsolutePath(storagePath: string): string | null {
    const resolved = this.resolveRoot(storagePath);
    if (!resolved) return null;
    const relative = storagePath.replace(resolved.prefix, '');
    const filePath = path.resolve(resolved.root, relative);
    const root = path.resolve(resolved.root);
    return filePath.startsWith(root + path.sep) && fs.existsSync(filePath) ? filePath : null;
  }

  public async getStream(storagePath: string): Promise<Readable | null> {
    const absPath = this.getAbsolutePath(storagePath);
    if (absPath && fs.existsSync(absPath)) {
      return fs.createReadStream(absPath);
    }
    return null;
  }

  public async promoteFromQuarantine(storagePath: string): Promise<{ publicUrl: string; storagePath: string }> {
    if (!storagePath || !storagePath.startsWith('/quarantine/')) {
      // Already public (or not a path this adapter recognizes at all) — a
      // no-op so callers can promote unconditionally without checking first.
      return { publicUrl: storagePath, storagePath };
    }

    const sourcePath = this.getAbsolutePath(storagePath);
    if (!sourcePath) {
      throw new Error(`[LocalStorage] Cannot promote — quarantined file missing: ${storagePath}`);
    }

    const relative = storagePath.replace('/quarantine/', '');
    const targetPath = path.resolve(this.uploadsDir, relative);
    const uploadsRoot = path.resolve(this.uploadsDir);
    if (!targetPath.startsWith(uploadsRoot + path.sep)) {
      throw new Error(`[LocalStorage] Refusing to promote outside the uploads root: ${storagePath}`);
    }

    await fs.promises.mkdir(path.dirname(targetPath), { recursive: true });
    await fs.promises.copyFile(sourcePath, targetPath);
    await fs.promises.unlink(sourcePath).catch((err) => {
      console.warn(`[LocalStorage] Promoted ${storagePath} but could not remove the quarantine copy:`, err instanceof Error ? err.message : err);
    });

    const publicPath = `/uploads/${relative}`;
    console.log(`[LocalStorage] Promoted from quarantine: ${storagePath} -> ${publicPath}`);
    return { publicUrl: publicPath, storagePath: publicPath };
  }

  // G4 — purgeEventMedia() deletes every file under events/<id>/ but left the
  // directory itself behind, so the orphan count never truly went to zero
  // after a purge. rmdir only succeeds on a genuinely empty directory, so
  // this is safe to call even if some individual file delete above failed.
  public async removeEventDirectory(eventId: string): Promise<void> {
    if (!eventId) return;
    for (const root of [this.uploadsDir, this.quarantineDir]) {
      const dir = path.join(root, 'events', eventId);
      try {
        await fs.promises.rmdir(dir);
        console.log(`[LocalStorage] Removed empty event directory: ${path.relative(process.cwd(), dir)}`);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException)?.code;
        // ENOENT: already gone. ENOTEMPTY: a file delete above failed, so
        // something real is still in there - leave it, don't force it.
        if (code !== 'ENOENT' && code !== 'ENOTEMPTY') {
          console.warn(
            `[LocalStorage] Could not remove event directory ${path.relative(process.cwd(), dir)}:`,
            err instanceof Error ? err.message : err
          );
        }
      }
    }
  }
}

// 2. Cloudflare R2 Storage Adapter (S3-Compatible)
export class R2StorageAdapter implements StorageAdapter {
  private s3: S3Client;
  private bucketName: string;
  private publicBaseUrl: string;

  constructor() {
    this.bucketName = CONFIG.R2_BUCKET_NAME;
    this.publicBaseUrl = CONFIG.R2_PUBLIC_URL;

    this.s3 = new S3Client({
      region: 'auto',
      endpoint: `https://${CONFIG.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: {
        accessKeyId: CONFIG.R2_ACCESS_KEY_ID,
        secretAccessKey: CONFIG.R2_SECRET_ACCESS_KEY,
      },
    });

    console.log(`[R2Storage] Initialized Cloudflare R2 Adapter -> Bucket: ${this.bucketName}`);
  }

  public async save(buffer: Buffer, filename: string, mimetype: string = 'image/jpeg', eventId?: string, options?: SaveOptions): Promise<{ publicUrl: string; storagePath: string }> {
    try {
      // Cleanly partition albums by event ID: events/{eventId}/photos/{filename}
      // MED-03/SEC-M5 caveat: a `quarantine/` key prefix is a naming
      // convention, not real access control — this bucket is configured for
      // public read (docs/CLOUDFLARE_R2_SETUP_GUIDE.md), so any object key,
      // quarantined or not, is fetchable by anyone who has or guesses the
      // URL. Genuine R2-side privacy needs a private bucket and presigned
      // GETs, which is out of scope here; on R2 this still closes the gap
      // for the guest-facing app and API (nothing links to the quarantine
      // URL until promotion), just not against URL guessing. Local disk
      // storage does not have this caveat — quarantined files there sit
      // outside the statically-served root entirely.
      const key = eventId
        ? `${options?.quarantine ? 'quarantine/' : ''}events/${eventId}/${filename}`
        : filename;

      await this.s3.send(
        new PutObjectCommand({
          Bucket: this.bucketName,
          Key: key,
          Body: buffer,
          ContentType: mimetype,
        })
      );

      const publicUrl = this.publicBaseUrl
        ? `${this.publicBaseUrl}/${key}`
        : `https://${this.bucketName}.${CONFIG.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${key}`;

      console.log(`[R2Storage] Uploaded ${buffer.length} bytes to R2 -> ${key}`);
      return {
        publicUrl,
        storagePath: publicUrl,
      };
    } catch (err) {
      console.error('[R2Storage Error] Failed to upload to Cloudflare R2:', err);
      throw err;
    }
  }

  /** Recover the raw R2 object key from either a public URL or the private endpoint URL. */
  private extractKey(storagePath: string): string {
    if (this.publicBaseUrl && storagePath.startsWith(this.publicBaseUrl)) {
      return storagePath.replace(`${this.publicBaseUrl}/`, '');
    }
    if (storagePath.includes('.r2.cloudflarestorage.com/')) {
      return storagePath.split('.r2.cloudflarestorage.com/')[1];
    }
    return storagePath;
  }

  public async delete(storagePath: string): Promise<void> {
    try {
      const key = this.extractKey(storagePath);

      await this.s3.send(
        new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        })
      );
      console.log(`[R2Storage] Deleted file from R2 -> ${key}`);
    } catch (err) {
      console.error('[R2Storage Error] Failed to delete file from R2:', err);
    }
  }

  public getAbsolutePath(_storagePath: string): string | null {
    return null;
  }

  public async getStream(storagePath: string): Promise<Readable | null> {
    try {
      const key = this.extractKey(storagePath);

      const response = await this.s3.send(
        new GetObjectCommand({
          Bucket: this.bucketName,
          Key: key,
        })
      );

      return (response.Body as Readable) || null;
    } catch (err) {
      // MED-06 — a real outage (network failure, bad credentials, R2 5xx)
      // looked identical to a plain "no such file" here, so ZIP export
      // silently dropped the photo with nothing telling the host why the
      // download came back short. Only a genuine not-found resolves to
      // null; anything else propagates so the caller finds out.
      const name = err instanceof Error ? err.name : '';
      const httpStatus = (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
      if (name === 'NoSuchKey' || name === 'NotFound' || httpStatus === 404) {
        return null;
      }
      console.error(`[R2Storage] Failed to fetch stream for ${storagePath}:`, (err instanceof Error ? err.message : String(err)));
      throw err;
    }
  }

  public async promoteFromQuarantine(storagePath: string): Promise<{ publicUrl: string; storagePath: string }> {
    const key = this.extractKey(storagePath);
    if (!key.startsWith('quarantine/')) {
      // Already public (or not a key this adapter recognizes) — a no-op so
      // callers can promote unconditionally without checking first.
      return { publicUrl: storagePath, storagePath };
    }

    const targetKey = key.replace(/^quarantine\//, '');

    await this.s3.send(
      new CopyObjectCommand({
        Bucket: this.bucketName,
        CopySource: `${this.bucketName}/${key}`,
        Key: targetKey,
      })
    );
    await this.s3.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));

    const publicUrl = this.publicBaseUrl
      ? `${this.publicBaseUrl}/${targetKey}`
      : `https://${this.bucketName}.${CONFIG.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${targetKey}`;

    console.log(`[R2Storage] Promoted from quarantine: ${key} -> ${targetKey}`);
    return { publicUrl, storagePath: publicUrl };
  }
}

// Select active storage adapter based on environment configuration
export function createStorageAdapter(): StorageAdapter {
  if (CONFIG.STORAGE_PROVIDER === 'r2' && CONFIG.R2_ACCOUNT_ID && CONFIG.R2_ACCESS_KEY_ID) {
    return new R2StorageAdapter();
  }
  return new LocalStorageAdapter();
}

export const storageAdapter: StorageAdapter = createStorageAdapter();

export interface DecodedDataUrl {
  buffer: Buffer;
  mimetype: string;
  ext: string;
}

/**
 * Decode a `data:` URL into a buffer plus its media type.
 * Returns null for anything that is not a non-empty data URL (external URLs,
 * already-stored paths) so callers can pass those through untouched.
 */
export function decodeDataUrl(dataUrl?: string | null): DecodedDataUrl | null {
  if (!dataUrl || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return null;

  const commaIndex = dataUrl.indexOf(',');
  if (commaIndex === -1) return null;

  const header = dataUrl.substring(0, commaIndex);
  const buffer = Buffer.from(dataUrl.substring(commaIndex + 1), 'base64');
  if (buffer.length === 0) return null;

  let ext = '.jpg';
  let mimetype = 'image/jpeg';
  if (header.includes('png')) {
    ext = '.png';
    mimetype = 'image/png';
  } else if (header.includes('webp')) {
    ext = '.webp';
    mimetype = 'image/webp';
  } else if (header.includes('webm') || header.includes('audio') || header.includes('ogg')) {
    ext = '.webm';
    mimetype = 'audio/webm';
  }

  return { buffer, mimetype, ext };
}

/** Store a raw buffer under a generated, collision-resistant filename. */
export async function saveBuffer(
  buffer: Buffer,
  prefix: string,
  ext: string,
  mimetype: string,
  eventId?: string,
  options?: SaveOptions
): Promise<{ publicUrl: string; storagePath: string }> {
  const filename = `${prefix}-${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`;
  return storageAdapter.save(buffer, filename, mimetype, eventId, options);
}

/**
 * Turn an internal `/uploads/...` path into an absolute URL using the configured
 * public base.
 *
 * Never build this from the request's Host header: the value is persisted in the
 * photos and audio tables, so a forged header writes an attacker-chosen origin
 * into rows that are then served to every guest and packed into ZIP exports.
 * Values that are already absolute (R2, external) pass through untouched.
 */
/**
 * Resolve a stored object's path from either a path or a full public URL.
 *
 * Some columns hold a path (storage_path, original_storage_path) and some hold a
 * URL (thumbnail_url, audio_url). Everything under the uploads prefix addresses
 * the same object either way, and every delete path needs all of them - missing
 * one leaks the bytes silently, because once the row is gone nothing references
 * the file any more.
 */
/**
 * True when a stored object's path/URL actually belongs to the given event.
 *
 * Both adapters key their objects under an `events/{eventId}/` segment —
 * `/uploads/events/{id}/photo.jpg` locally, `https://.../events/{id}/photo.jpg`
 * on R2 — so a plain substring check works for either shape without needing
 * to know which adapter is active. This has to be checked BEFORE ever asking
 * an adapter to stream a path (SEC-04): `LocalStorageAdapter.getStream`
 * succeeds for any real file under the uploads root generally, not just this
 * event's subfolder, so a check that only runs when getStream() fails never
 * actually ran for the common case. A photo row whose storage_path ever
 * pointed cross-event (a bug, a bad insert, a migration artifact) would
 * otherwise stream out through the ZIP export untouched.
 */
export function storagePathBelongsToEvent(storagePath: string | null | undefined, eventId: string): boolean {
  if (!storagePath) return false;
  return storagePath.includes(`/events/${eventId}/`);
}

/**
 * True when a stored object is still quarantined (MED-03/SEC-M5) — a
 * `/quarantine/` segment locally, or a `quarantine/` key segment in an R2
 * URL. Both adapters use the same substring shape for this the same way
 * {@link storagePathBelongsToEvent} does for the event-id segment.
 */
export function isQuarantined(storagePath: string | null | undefined): boolean {
  if (!storagePath) return false;
  return storagePath.includes('/quarantine/') || storagePath.includes('quarantine/events/');
}

export function toStoragePath(value: string | null | undefined): string | null {
  if (!value) return null;
  const marker = value.indexOf('/uploads/');
  return marker === -1 ? value : value.substring(marker);
}

export function toAbsoluteUrl(storagePath: string): string {
  if (!storagePath || !storagePath.startsWith('/uploads/')) return storagePath;
  return `${CONFIG.PUBLIC_BASE_URL}${storagePath}`;
}
