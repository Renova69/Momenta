import { ENV } from '../config/env';
import { getOrCreateDeviceFingerprint } from './storageKeys';
import { isRefusedForGood } from './uploadRefusal';

/**
 * The JSON body of a queued upload, replayed verbatim against /api/photos or
 * /api/audio. Its exact shape belongs to those endpoints, so it stays a plain
 * JSON record here rather than being duplicated.
 */
export type QueuedPayload = Record<string, unknown>;

export interface QueuedUpload {
  id: string;
  type: 'photo' | 'audio';
  payload: QueuedPayload;
  queuedAt: string;
  retryCount: number;
}

type OfflineQueueListener = (queuedCount: number, isOnline: boolean) => void;
/** Fired once per successfully-uploaded item with the parsed server response, so a caller can reconcile an optimistic local entry (still under its temp id) with the real one (FE-03). */
type FlushSuccessListener = (item: QueuedUpload, serverResponse: Record<string, unknown>) => void;
/** Fired when an item is given up on, so the guest is told rather than finding out later (N-60). */
/**
 * Why an item left the queue unsent. `refused` is the server saying no for
 * good (N-150), with its code and its words; otherwise the queue gave up
 * after its retries.
 */
export interface DropReason {
  refused: boolean;
  code?: string;
  message?: string;
  /** The whole refusal, for the values its translation names. */
  body?: Record<string, unknown>;
}
type ItemDroppedListener = (item: QueuedUpload, reason: DropReason) => void;

// [FIX H-13] Max items and max retries to prevent runaway growth
const MAX_QUEUE_SIZE = 50;
const MAX_RETRIES = 5;

/** How long one replayed upload may take before it counts as a network failure (N-61). */
const REPLAY_TIMEOUT_MS = 120_000;

/**
 * Which answers a retry cannot change is decided in uploadRefusal.ts, shared
 * with the live upload: malformed, the album gone, too large, the wrong type,
 * or a plan's limit (N-150). A 5xx, 401, 408, a 403 without the app's code
 * (a venue's captive portal), or the rate limiter's 429 may succeed later.
 */

/** The code and words of a refusal, when the server sent them as JSON. */
async function readRefusal(res: Response): Promise<Omit<DropReason, 'refused'>> {
  try {
    const body = (await res.json()) as Record<string, unknown>;
    return {
      code: typeof body.code === 'string' ? body.code : undefined,
      message: typeof body.error === 'string' ? body.error : undefined,
      body,
    };
  } catch {
    return {};
  }
}

const DB_NAME = 'wedmoments_offline_queue';
const DB_VERSION = 1;
const STORE_NAME = 'uploads';

/**
 * Queued items carry a raw capture's full-resolution data URL (`originalUrl`)
 * — 5-15MB uncompressed, easily several times that once base64-inflated and
 * JSON-stringified alongside the rest of the payload. A single offline photo
 * could exceed the origin's entire 5MB localStorage quota by itself (SEC-P2 /
 * the localStorage-backed version of this file). IndexedDB has no such
 * ceiling in practice, so the queue lives there instead.
 */
function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * `db` is injectable purely for testing (FE-02) — real callers always omit
 * it and get a fresh connection from openDb().
 */
export async function withStore<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T>,
  injectedDb?: IDBDatabase
): Promise<T> {
  const db = injectedDb || (await openDb());
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, mode);
      const store = tx.objectStore(STORE_NAME);
      const request = fn(store);
      // FE-02: the request succeeding only means the operation was accepted,
      // not that the transaction has committed to disk yet — resolving here
      // (and closing the connection in the outer `finally` right after) let
      // db.close() run before commit, which WebKit/iOS Safari treats as a
      // reason to abort the transaction outright instead of letting it
      // finish, silently losing whatever was just written. Wait for
      // tx.oncomplete instead; only capture the result value early.
      let result: T;
      request.onsuccess = () => {
        result = request.result;
      };
      request.onerror = () => reject(request.error);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  } finally {
    db.close();
  }
}

export class OfflineQueueService {
  private listeners: Set<OfflineQueueListener> = new Set();
  private flushSuccessListeners: Set<FlushSuccessListener> = new Set();
  private itemDroppedListeners: Set<ItemDroppedListener> = new Set();
  private isProcessing = false;
  private available = typeof window !== 'undefined' && typeof window.indexedDB !== 'undefined';

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => {
        void this.notify();
        this.flushQueue();
      });
      window.addEventListener('offline', () => {
        void this.notify();
      });
    }
  }

  public isOnline(): boolean {
    return typeof navigator !== 'undefined' && typeof navigator.onLine === 'boolean' ? navigator.onLine : true;
  }

  public async getQueue(): Promise<QueuedUpload[]> {
    if (!this.available) return [];
    try {
      return await withStore<QueuedUpload[]>('readonly', (store) => store.getAll());
    } catch {
      return [];
    }
  }

  /**
   * The `localId` of every photo upload still waiting to be retried.
   *
   * An optimistic photo row survives in localStorage under this same id until
   * its upload lands, so this is what tells a sync which temp-id rows are still
   * genuinely on their way up and which have been abandoned.
   */
  public async getQueuedPhotoLocalIds(): Promise<Set<string>> {
    const queued = await this.getQueue();
    const ids = new Set<string>();
    for (const item of queued) {
      if (item.type !== 'photo') continue;
      const localId = (item.payload as { localId?: unknown }).localId;
      if (typeof localId === 'string' && localId) ids.add(localId);
    }
    return ids;
  }

  public async enqueue(type: 'photo' | 'audio', payload: QueuedPayload): Promise<QueuedUpload | null> {
    if (!this.available) {
      console.warn('[OfflineQueue] IndexedDB unavailable — item dropped.');
      return null;
    }

    const current = await this.getQueue();
    // [FIX H-13] Cap queue size — a bound is still worth keeping even without
    // a hard storage ceiling, so one runaway session cannot queue forever.
    if (current.length >= MAX_QUEUE_SIZE) {
      console.warn('[OfflineQueue] Queue is full (max', MAX_QUEUE_SIZE, '). Dropping item.');
      return null;
    }

    const item: QueuedUpload = {
      id: 'queue-' + Date.now() + '-' + Math.random().toString(36).substring(2, 6),
      type,
      payload,
      queuedAt: new Date().toISOString(),
      retryCount: 0,
    };

    try {
      await withStore('readwrite', (store) => store.put(item));
    } catch (e) {
      console.warn('[OfflineQueue] Failed to persist item:', e);
      return null;
    }

    await this.notify();

    if (this.isOnline()) {
      this.flushQueue();
    }

    return item;
  }

  public async removeItem(id: string): Promise<void> {
    if (!this.available) return;
    try {
      await withStore('readwrite', (store) => store.delete(id));
    } catch (e) {
      console.warn('[OfflineQueue] Failed to remove item:', e);
    }
    await this.notify();
  }

  public async incrementRetry(id: string): Promise<void> {
    if (!this.available) return;
    try {
      const item = await withStore<QueuedUpload | undefined>('readonly', (store) => store.get(id));
      if (item) {
        await withStore('readwrite', (store) => store.put({ ...item, retryCount: item.retryCount + 1 }));
      }
    } catch (e) {
      console.warn('[OfflineQueue] Failed to update retry count:', e);
    }
    await this.notify();
  }

  // [FIX C-7] Use ENV.API_URL instead of hardcoded localhost
  // [FIX H-12] Include auth token in requests
  public async flushQueue() {
    if (this.isProcessing || !this.isOnline()) return;
    this.isProcessing = true;

    // [FIX M-11] Wrap entire flush in try/finally to always release isProcessing
    try {
      const queue = await this.getQueue();
      if (queue.length === 0) return;

      const apiHost = ENV.API_URL?.replace(/\/+$/, '') || '';
      if (!apiHost && typeof window !== 'undefined' && !window.location?.origin) return;
      const baseUrl =
        apiHost || (typeof window !== 'undefined' && window.location?.origin ? window.location.origin : '');
      if (!baseUrl) return;
      const token = localStorage.getItem('wedmoments_host_token');

      for (const item of queue) {
        // Drop items that exceeded max retries
        if (item.retryCount >= MAX_RETRIES) {
          console.warn('[OfflineQueue] Dropping item after max retries:', item.id);
          await this.dropItem(item, { refused: false });
          continue;
        }

        try {
          const endpoint = item.type === 'photo' ? `${baseUrl}/api/photos` : `${baseUrl}/api/audio`;
          // N-59 — the device, as the live upload sends it. The audio route
          // needs it (or a guest token) to know who is speaking, and the rate
          // limiter keys on it; without it every replayed voice message was
          // refused and, after five tries, deleted.
          const headers: Record<string, string> = { 'x-device-fingerprint': getOrCreateDeviceFingerprint() };
          if (token) headers['Authorization'] = `Bearer ${token}`;

          let body: BodyInit;
          if (item.type === 'audio') {
            // /api/audio is multipart-only (P7) — the blob survives in
            // IndexedDB across the retry, unlike the old localStorage queue
            // where a Blob could never have been serialized into it at all.
            const { audioBlob, audioFilename, ...fields } = item.payload as Record<string, unknown> & {
              audioBlob?: Blob;
              audioFilename?: string;
            };
            const form = new FormData();
            if (audioBlob instanceof Blob) {
              form.append('audio', audioBlob, audioFilename || 'audio-message.webm');
            }
            for (const [key, value] of Object.entries(fields)) {
              if (value !== undefined && value !== null) form.append(key, String(value));
            }
            body = form;
          } else {
            headers['Content-Type'] = 'application/json';
            body = JSON.stringify(item.payload);
          }

          // N-61 — a deadline, so one stalled request on weak Wi-Fi cannot hold
          // isProcessing, and with it every later flush, until a reload.
          const controller = new AbortController();
          const deadline = setTimeout(() => controller.abort(), REPLAY_TIMEOUT_MS);
          let res: Response;
          try {
            res = await fetch(endpoint, { method: 'POST', headers, body, signal: controller.signal });
          } catch (networkErr) {
            if (controller.signal.aborted) {
              // N-96 — this upload ran out of time; the link answered, it was
              // too slow for this item. Spend a retry and go on: treated as
              // the network failing, an upload too large for the link stayed
              // first in line for good and nothing behind it was ever sent.
              console.warn('[OfflineQueue] Upload ran out of time, trying the next one:', item.id);
              await this.incrementRetry(item.id);
              continue;
            }
            // N-60 — the network failed, not the item. Spend no retry, and stop
            // this pass: the next item would only fail the same way. The next
            // 'online' event or enqueue tries again.
            console.warn('[OfflineQueue] Network unavailable, keeping the queue for later:', networkErr);
            break;
          } finally {
            clearTimeout(deadline);
          }
          if (!res.ok) {
            const refusal = await readRefusal(res);
            if (isRefusedForGood(res.status, refusal.code)) {
              // Retrying cannot make a malformed, oversized or orphaned upload
              // succeed, nor get one into a full album. Drop it now, and say so.
              console.warn('[OfflineQueue] Upload refused for good, dropping:', item.id, res.status, refusal.code);
              await this.dropItem(item, { refused: true, ...refusal });
              continue;
            }
            throw new Error(`Upload failed with HTTP ${res.status}`);
          }
          // FE-03: parse the response so a listener can reconcile the
          // optimistic local entry (still under its temp id) with the
          // server-assigned one. Without this, the next syncFromBackend pull
          // adds the server row as a brand-new photo while the temp-id row
          // is never cleaned up — a permanent duplicate in the feed.
          let serverResponse: Record<string, unknown> | null = null;
          try {
            serverResponse = await res.json();
          } catch {
            // Not JSON - the upload still succeeded, just nothing to reconcile.
          }
          // Atomic item removal upon success to prevent overwriting concurrently added items
          await this.removeItem(item.id);
          if (serverResponse) {
            this.flushSuccessListeners.forEach((listener) => listener(item, serverResponse!));
          }
        } catch (err) {
          console.warn('[OfflineQueue] Failed to upload item', item.id, err);
          await this.incrementRetry(item.id);
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  public subscribe(listener: OfflineQueueListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public onItemDropped(listener: ItemDroppedListener): () => void {
    this.itemDroppedListeners.add(listener);
    return () => this.itemDroppedListeners.delete(listener);
  }

  /** Remove an item for good and tell whoever is listening. */
  private async dropItem(item: QueuedUpload, reason: DropReason): Promise<void> {
    await this.removeItem(item.id);
    this.itemDroppedListeners.forEach((listener) => listener(item, reason));
  }

  public onFlushSuccess(listener: FlushSuccessListener): () => void {
    this.flushSuccessListeners.add(listener);
    return () => this.flushSuccessListeners.delete(listener);
  }

  private async notify() {
    const count = (await this.getQueue()).length;
    const online = this.isOnline();
    this.listeners.forEach((fn) => fn(count, online));
  }
}

export const offlineQueue = new OfflineQueueService();
