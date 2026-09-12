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
  uploadPhotos: async (
    eventId: string,
    key: string,
    files: File[],
    options: IngestUploadOptions = {}
  ): Promise<Photo[]> => {
    const { photographerName = '', caption = '', concurrency = 3, onProgress } = options;
    const total = files.length;
    if (total === 0) return [];

    const baseUrl = ENV.API_URL?.replace(/\/+$/, '') || '';
    const endpoint = `${baseUrl}/api/ingest/${encodeURIComponent(eventId)}/photos`;

    const results: Photo[] = [];
    let cursor = 0;
    let done = 0;

    const worker = async (): Promise<void> => {
      while (cursor < files.length) {
        const file = files[cursor++];
        const formData = new FormData();
        formData.append('file', file);
        if (photographerName) formData.append('photographerName', photographerName);
        if (caption) formData.append('caption', caption);

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'X-Ingest-Key': key },
          body: formData,
        });

        if (!res.ok) {
          const errJson = await res.json().catch(() => ({}));
          const message =
            errJson && typeof errJson === 'object' && 'error' in errJson
              ? String((errJson as { error: unknown }).error)
              : '';
          throw new Error(message || `Upload failed (HTTP ${res.status})`);
        }

        const data = await res.json();
        if (Array.isArray(data.photos)) results.push(...data.photos);

        done += 1;
        onProgress?.(done, total);
      }
    };

    const workers = Array.from({ length: Math.max(1, Math.min(concurrency, total)) }, () => worker());
    await Promise.all(workers);
    return results;
  },
};
