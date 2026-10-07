import { ENV } from '../config/env';
import { Photo } from '../types';
import { apiFetch } from './apiClient';

export interface IngestKeyInfo {
  id: string;
  eventId?: string;
  label: string;
  createdAt: string;
  lastUsedAt?: string | null;
  expiresAt?: string | null;
  revokedAt?: string | null;
  masked?: string;
  key?: string; // present only in the create response
}

export interface IngestUploadOptions {
  photographerName?: string;
  caption?: string;
  concurrency?: number;
  onProgress?: (done: number, total: number) => void;
}

/** A file from a batch that did not become a photo, and the reason given. */
export interface IngestFailure {
  file: File;
  reason: string;
}

export interface IngestUploadResult {
  photos: Photo[];
  failed: IngestFailure[];
}

/**
 * Answers that every remaining file in the batch would get too: a refused
 * key, an album that is gone, or a rate limit. Further requests only repeat
 * them, so the rest of the batch is returned as not sent.
 */
const BATCH_ENDING_STATUSES = new Set([401, 404, 429]);

/** The server's own message from an error response, or the status code. */
async function errorMessage(res: Response): Promise<string> {
  const errJson = await res.json().catch(() => ({}));
  const message =
    errJson && typeof errJson === 'object' && 'error' in errJson ? String((errJson as { error: unknown }).error) : '';
  return message || `Upload failed (HTTP ${res.status})`;
}

export const ingestApi = {
  // Host Studio: create an ingest key for an event (returns plaintext key once).
  createKey: async (eventId: string, label?: string): Promise<IngestKeyInfo> => {
    return apiFetch<IngestKeyInfo>('/api/ingest/keys', {
      method: 'POST',
      body: JSON.stringify({ eventId, label }),
    });
  },

  // Host Studio: list (masked) keys for an event.
  listKeys: async (eventId: string): Promise<IngestKeyInfo[]> => {
    return apiFetch<IngestKeyInfo[]>(`/api/ingest/keys?eventId=${encodeURIComponent(eventId)}`);
  },

  // Host Studio: revoke a key.
  revokeKey: async (keyId: string): Promise<{ success: boolean; keyId: string }> => {
    return apiFetch<{ success: boolean; keyId: string }>(`/api/ingest/keys/${keyId}`, {
      method: 'DELETE',
    });
  },

  // Upload photos with an ingest key (not the host JWT). Runs several requests in
  // parallel (browser "threads") and reports progress. Used by the VIP portal.
  //
  // N-75 — every file is accounted for: it either became a photo or is in
  // `failed` with the reason. The first failure used to reject the whole call
  // while the other workers kept uploading, so the portal reported the batch
  // as failed, and a retry sent the frames that had arrived a second time.
  uploadPhotos: async (
    eventId: string,
    key: string,
    files: File[],
    options: IngestUploadOptions = {}
  ): Promise<IngestUploadResult> => {
    const { photographerName = '', caption = '', concurrency = 3, onProgress } = options;
    const total = files.length;
    const photos: Photo[] = [];
    const failed: IngestFailure[] = [];
    if (total === 0) return { photos, failed };

    const baseUrl = ENV.API_URL?.replace(/\/+$/, '') || '';
    const endpoint = `${baseUrl}/api/ingest/${encodeURIComponent(eventId)}/photos`;

    let cursor = 0;
    let done = 0;
    let batchEnded: string | null = null;

    const send = async (file: File): Promise<void> => {
      const formData = new FormData();
      formData.append('file', file);
      if (photographerName) formData.append('photographerName', photographerName);
      if (caption) formData.append('caption', caption);

      let res: Response;
      try {
        res = await fetch(endpoint, { method: 'POST', headers: { 'X-Ingest-Key': key }, body: formData });
      } catch (err) {
        // Venue Wi-Fi: this file did not go, the next one may.
        failed.push({ file, reason: err instanceof Error ? err.message : 'Network error' });
        return;
      }

      if (!res.ok) {
        const reason = await errorMessage(res);
        failed.push({ file, reason });
        if (BATCH_ENDING_STATUSES.has(res.status)) batchEnded = reason;
        return;
      }

      const data = await res.json().catch(() => ({}));
      if (Array.isArray(data.photos)) photos.push(...data.photos);
      // One file per request, so a file the server turned away is this one.
      if (Array.isArray(data.rejected) && data.rejected.length > 0) {
        failed.push({ file, reason: String(data.rejected[0]?.reason || 'Not a supported image file') });
      }
    };

    const worker = async (): Promise<void> => {
      while (cursor < files.length && batchEnded === null) {
        await send(files[cursor++]);
        done += 1;
        onProgress?.(done, total);
      }
    };

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, () => worker());
    await Promise.all(workers);

    // Files never started because the batch ended are returned as not sent.
    for (const file of files.slice(cursor)) failed.push({ file, reason: batchEnded ?? '' });
    return { photos, failed };
  },
};
