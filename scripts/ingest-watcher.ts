import fs from 'node:fs';
import path from 'node:path';

/**
 * The message from an unknown thrown value.
 *
 * These call sites used `catch (err: any)` and reached straight for
 * `err?.message`, which is only safe because `any` silences the check — the
 * same reason it hid from review. This is `errorLabel()` from
 * server/lib/errors.ts in miniature; inlined because this script deliberately
 * imports nothing from the server.
 */
function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && typeof (err as { message?: unknown }).message === 'string') {
    return (err as { message: string }).message;
  }
  return String(err);
}

/**
 * WedMoments hot-folder ingest watcher.
 *
 * Watches a directory (Lightroom/Capture One export folder, or the drop folder of
 * any FTP server your camera targets) and pushes new images to the photographer
 * ingest endpoint as soon as they appear.
 *
 * Required env:
 *   INGEST_WATCH_DIR           folder to watch
 *   INGEST_EVENT_ID            target wedding event UUID
 *   INGEST_API_KEY             photographer ingest key (wmi_...)
 * Optional:
 *   INGEST_API_URL             default http://localhost:6501
 *   INGEST_PHOTOGRAPHER_NAME   default "Official Photographer"
 *   INGEST_POLL_INTERVAL_MS    default 3000
 */

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`[ingest-watcher] ${name} is required`);
    process.exit(1);
  }
  return value;
}

const WATCH_DIR = requireEnv('INGEST_WATCH_DIR');
const API_URL = (process.env.INGEST_API_URL || 'http://localhost:6501').replace(/\/+$/, '');
const EVENT_ID = requireEnv('INGEST_EVENT_ID');
const API_KEY = requireEnv('INGEST_API_KEY');
const PHOTOGRAPHER_NAME = process.env.INGEST_PHOTOGRAPHER_NAME || 'Official Photographer';
const POLL_INTERVAL_MS = parseInt(process.env.INGEST_POLL_INTERVAL_MS || '3000', 10);

const EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);

const processedDir = path.join(WATCH_DIR, '.processed');
fs.mkdirSync(processedDir, { recursive: true });

const inFlight = new Set<string>();

function mimeFor(ext: string): string {
  switch (ext) {
    case '.png':
      return 'image/png';
    case '.webp':
      return 'image/webp';
    case '.gif':
      return 'image/gif';
    default:
      return 'image/jpeg';
  }
}

async function upload(filePath: string): Promise<boolean> {
  const base = path.basename(filePath);
  const ext = path.extname(base).toLowerCase();
  if (!EXTENSIONS.has(ext)) return false;
  if (inFlight.has(filePath)) return false;
  inFlight.add(filePath);

  try {
    const buf = fs.readFileSync(filePath);
    const form = new FormData();
    form.append('file', new Blob([buf], { type: mimeFor(ext) }), base);
    form.append('photographerName', PHOTOGRAPHER_NAME);

    const res = await fetch(`${API_URL}/api/ingest/${EVENT_ID}/photos`, {
      method: 'POST',
      headers: { 'X-Ingest-Key': API_KEY },
      body: form,
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      console.error(`[ingest-watcher] Upload failed (HTTP ${res.status}) for ${base}: ${body.slice(0, 200)}`);
      return false;
    }

    const dest = path.join(processedDir, `${Date.now()}-${base}`);
    fs.renameSync(filePath, dest);
    console.log(`[ingest-watcher] Uploaded ${base}`);
    return true;
  } catch (err) {
    console.error(`[ingest-watcher] Error processing ${base}:`, messageOf(err));
    return false;
  } finally {
    inFlight.delete(filePath);
  }
}

async function scan(): Promise<void> {
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(WATCH_DIR).filter((f) => !f.startsWith('.'));
  } catch (err) {
    console.error('[ingest-watcher] readdir failed:', messageOf(err));
  }

  for (const entry of entries) {
    const full = path.join(WATCH_DIR, entry);
    try {
      if (!fs.statSync(full).isFile()) continue;
      await upload(full);
    } catch {
      // file may have been moved/deleted between readdir and stat
    }
  }
}

scan().then(() => {
  console.log(`[ingest-watcher] Watching ${WATCH_DIR} → ${API_URL}/api/ingest/${EVENT_ID}/photos`);
});

// Portable periodic scan (fs.watch is unreliable on network/SMB/FTP-mount folders).
setInterval(scan, POLL_INTERVAL_MS);

try {
  fs.watch(WATCH_DIR, (_evt, filename) => {
    if (!filename) return;
    upload(path.join(WATCH_DIR, filename.toString())).catch(() => {});
  });
} catch (err) {
  console.warn('[ingest-watcher] fs.watch unavailable, using polling only:', messageOf(err));
}
