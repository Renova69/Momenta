import { photosApi } from '../api/photosApi';
import { questsApi } from '../api/questsApi';
import { audioApi } from '../api/audioApi';
import { eventsApi } from '../api/eventsApi';
import { Photo } from '../types';
import { INITIAL_EVENT } from './defaultEvent';
import { STORAGE_KEYS } from './storageKeys';
import { persistPhotos } from './photoStore';
import { ServiceContext } from './storageServiceContext';

/** What GET /api/photos returns per request; also the server's own default. */
const PHOTO_PAGE_SIZE = 100;

/**
 * Ceiling on how many pages one sync will walk, so a pathological response
 * (a server that never returns a short page) cannot spin forever. 20 pages is
 * 2000 photos — comfortably past any real wedding.
 */
const MAX_PHOTO_PAGES = 20;

/**
 * Fetch an event's photos in full.
 *
 * H3 — this used to ask for a single page of 100 and stop, so an album with
 * more than that showed 100 photos and never more. The server has supported a
 * composite keyset cursor all along ("priority:isoTimestamp", matching its
 * `ORDER BY priority DESC, created_at DESC`), and photosApi.list already
 * accepts one; nothing ever passed it.
 *
 * Rows are deduplicated by id rather than trusted to be disjoint: the cursor
 * timestamp is millisecond-precision JSON while Postgres stores microseconds,
 * so a page boundary that lands between two photos sharing a priority and a
 * millisecond can repeat a row. Cheaper to dedupe than to reason about.
 *
 * A mid-album failure returns what was gathered so far instead of throwing —
 * 100 photos beats zero when the venue Wi-Fi drops.
 */
async function fetchAllPhotos(eventId: string): Promise<Photo[]> {
  const byId = new Map<string, Photo>();
  let cursor: string | undefined;

  for (let page = 0; page < MAX_PHOTO_PAGES; page++) {
    let batch: Photo[];
    try {
      batch = await photosApi.list(eventId, PHOTO_PAGE_SIZE, cursor);
    } catch (err) {
      if (byId.size === 0) throw err;
      console.warn(`[Storage] Photo page ${page + 1} failed; keeping the ${byId.size} already fetched:`, err);
      break;
    }

    if (!Array.isArray(batch) || batch.length === 0) break;
    for (const photo of batch) {
      if (photo?.id && !byId.has(photo.id)) byId.set(photo.id, photo);
    }

    // A short page is the last page.
    if (batch.length < PHOTO_PAGE_SIZE) break;

    const last = batch[batch.length - 1];
    const createdAt = last?.createdAt ? new Date(last.createdAt) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) break;
    cursor = `${last.priority ?? 0}:${createdAt.toISOString()}`;
  }

  return [...byId.values()];
}

// Scoped sync from backend strictly using targetEventId
export async function syncFromBackend(ctx: ServiceContext, eventIdOverride?: string): Promise<void> {
  const targetEventId = eventIdOverride || ctx.getEvent()?.id;
  if (!targetEventId) return;

  try {
    // 1. Photos for this specific event ONLY — every page of them.
    const serverPhotos = await fetchAllPhotos(targetEventId);
    if (Array.isArray(serverPhotos)) {
      // Merge remote photos with locally pending un-synced photos to prevent offline data loss
      const localPhotos = ctx.getPhotos(targetEventId);
      const unsyncedLocal = localPhotos.filter((p) => p.id.startsWith('photo-'));
      const serverIds = new Set(serverPhotos.map((p) => p.id));
      const merged = [...unsyncedLocal.filter((p) => !serverIds.has(p.id)), ...serverPhotos];
      persistPhotos(targetEventId, merged);
      ctx.notify();
    }

    // 2. Quests for this specific event ONLY
    const quests = await questsApi.list(targetEventId);
    if (Array.isArray(quests)) {
      localStorage.setItem(STORAGE_KEYS.QUESTS(targetEventId), JSON.stringify(quests));
      ctx.notify();
    }

    // 3. Audio entries for this specific event ONLY
    const audioEntries = await audioApi.list(targetEventId);
    if (Array.isArray(audioEntries)) {
      localStorage.setItem(STORAGE_KEYS.AUDIO(targetEventId), JSON.stringify(audioEntries));
      ctx.notify();
    }

    // 4. QR Canvas config
    const qrConfig = await eventsApi.getQRConfig(targetEventId);
    if (qrConfig) {
      localStorage.setItem(STORAGE_KEYS.QR_CANVAS(targetEventId), JSON.stringify(qrConfig));
      ctx.notify();
    }
  } catch (err) {
    console.warn('[Storage] Backend sync failed, serving from local cache:', err);
  }
}

/**
 * P8: the sample guests/photos/quests/audio/QR-config fixtures are dynamically
 * imported so `mockData.ts`'s array literals are a separate chunk fetched only
 * when demo mode is actually requested, instead of shipping in every production
 * bundle. Notifies subscribers once seeded so the already-mounted (empty) demo
 * view picks the fixtures up.
 */
async function seedDemoData(ctx: ServiceContext): Promise<void> {
  const { INITIAL_GUESTS, INITIAL_PHOTOS, INITIAL_QUESTS, INITIAL_AUDIO_ENTRIES, INITIAL_QR_CANVAS_CONFIG } =
    await import('./mockData');

  const defaultEvent = INITIAL_EVENT;
  if (!localStorage.getItem(STORAGE_KEYS.ACTIVE_EVENT_ID)) {
    localStorage.setItem(STORAGE_KEYS.ACTIVE_EVENT_ID, defaultEvent.id);
  }
  const seed: [string, unknown][] = [
    [STORAGE_KEYS.EVENT(defaultEvent.id), defaultEvent],
    [STORAGE_KEYS.GUESTS(defaultEvent.id), INITIAL_GUESTS],
    [STORAGE_KEYS.PHOTOS(defaultEvent.id), INITIAL_PHOTOS],
    [STORAGE_KEYS.QUESTS(defaultEvent.id), INITIAL_QUESTS],
    [STORAGE_KEYS.AUDIO(defaultEvent.id), INITIAL_AUDIO_ENTRIES],
    [STORAGE_KEYS.QR_CANVAS(defaultEvent.id), INITIAL_QR_CANVAS_CONFIG],
  ];

  let wroteAny = false;
  for (const [key, value] of seed) {
    if (!localStorage.getItem(key)) {
      localStorage.setItem(key, JSON.stringify(value));
      wroteAny = true;
    }
  }
  if (wroteAny) ctx.notify();
}

/**
 * Seed the sample wedding into localStorage.
 *
 * Only ever runs when the demo is explicitly requested (`?demo=1`, or a build
 * with VITE_SEED_DEMO_DATA=true). Seeding unconditionally meant every
 * first-time visitor to the bare domain was browsing a fictional wedding —
 * fake guests and photos indistinguishable from real data.
 */
export function initializeDefaults(ctx: ServiceContext): void {
  if (typeof window === 'undefined') return;

  const demoRequested =
    new URLSearchParams(window.location.search).get('demo') === '1' ||
    import.meta.env?.VITE_SEED_DEMO_DATA === 'true';

  if (!demoRequested) return;

  void seedDemoData(ctx);
}

export function resetToDefaults(ctx: ServiceContext): void {
  // Preserve authentication keys
  const user = localStorage.getItem('wedmoments_host_user');
  const token = localStorage.getItem('wedmoments_host_token');
  const deviceId = localStorage.getItem(STORAGE_KEYS.DEVICE_ID);

  localStorage.clear();

  if (user) localStorage.setItem('wedmoments_host_user', user);
  if (token) localStorage.setItem('wedmoments_host_token', token);
  if (deviceId) localStorage.setItem(STORAGE_KEYS.DEVICE_ID, deviceId);

  initializeDefaults(ctx);
  ctx.notify();
}
