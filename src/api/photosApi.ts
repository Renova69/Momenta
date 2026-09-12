import { apiFetch } from './apiClient';
import { Photo, PhotoStatus, PhotoComment, PhotoReactionKind } from '../types';

export const photosApi = {
  // Get photos scoped by event with optional cursor pagination
  list: async (eventId?: string, limit: number = 100, cursor?: string): Promise<Photo[]> => {
    const params = new URLSearchParams();
    if (eventId) params.append('eventId', eventId);
    if (limit) params.append('limit', limit.toString());
    if (cursor) params.append('cursor', cursor);

    const queryStr = params.toString() ? `?${params.toString()}` : '';
    return apiFetch<Photo[]>(`/api/photos${queryStr}`);
  },

  // Create photo
  create: async (photoData: Partial<Photo>): Promise<Photo> => {
    return apiFetch<Photo>('/api/photos', {
      method: 'POST',
      body: JSON.stringify(photoData),
    });
  },

  // Toggle like
  toggleLike: async (
    photoId: string,
    guestId: string,
    guestToken?: string
  ): Promise<{ success: boolean; photoId: string; isLiked: boolean }> => {
    return apiFetch<{ success: boolean; photoId: string; isLiked: boolean }>(`/api/photos/${photoId}/like`, {
      method: 'POST',
      body: JSON.stringify({ guestId, guestToken }),
    });
  },

  // Toggle one emoji reaction (independent of the others — a guest can have
  // several active reactions on the same photo at once)
  toggleReaction: async (
    photoId: string,
    reaction: PhotoReactionKind,
    guestId: string,
    guestToken?: string
  ): Promise<{ success: boolean; photoId: string; reaction: PhotoReactionKind; isActive: boolean }> => {
    return apiFetch<{ success: boolean; photoId: string; reaction: PhotoReactionKind; isActive: boolean }>(
      `/api/photos/${photoId}/reactions`,
      {
        method: 'POST',
        body: JSON.stringify({ reaction, guestId, guestToken }),
      }
    );
  },

  // Add comment
  addComment: async (
    photoId: string,
    guestId: string,
    guestName: string,
    commentText: string,
    localId?: string,
    guestToken?: string,
    deviceFingerprint?: string
  ): Promise<PhotoComment & { localId?: string; guestToken?: string }> => {
    return apiFetch<PhotoComment & { localId?: string; guestToken?: string }>(`/api/photos/${photoId}/comments`, {
      method: 'POST',
      body: JSON.stringify({ guestId, guestName, commentText, localId, guestToken, deviceFingerprint }),
    });
  },

  // Set photo status (moderation)
  setStatus: async (photoId: string, status: PhotoStatus): Promise<{ success: boolean; photoId: string; status: PhotoStatus }> => {
    return apiFetch<{ success: boolean; photoId: string; status: PhotoStatus }>(`/api/photos/${photoId}/status`, {
      method: 'POST',
      body: JSON.stringify({ status }),
    });
  },

  // Delete photo
  delete: async (photoId: string): Promise<{ success: boolean; photoId: string }> => {
    return apiFetch<{ success: boolean; photoId: string }>(`/api/photos/${photoId}`, {
      method: 'DELETE',
    });
  },
};
