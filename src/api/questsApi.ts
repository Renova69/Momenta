import { apiFetch } from './apiClient';
import { ScavengerQuest } from '../types';

export const questsApi = {
  // List quests for an event
  list: async (eventId: string): Promise<ScavengerQuest[]> => {
    return apiFetch<ScavengerQuest[]>(`/api/events/${eventId}/quests`);
  },

  // Create quest (host only)
  create: async (eventId: string, quest: { title: string; description?: string; iconName?: string; points?: number; localId?: string }): Promise<ScavengerQuest & { localId?: string }> => {
    return apiFetch<ScavengerQuest & { localId?: string }>(`/api/events/${eventId}/quests`, {
      method: 'POST',
      body: JSON.stringify(quest),
    });
  },

  // Delete quest (host only)
  delete: async (questId: string): Promise<{ success: boolean; questId: string }> => {
    return apiFetch<{ success: boolean; questId: string }>(`/api/quests/${questId}`, {
      method: 'DELETE',
    });
  },

  // Complete quest
  complete: async (
    questId: string,
    guestId: string,
    photoId?: string,
    guestToken?: string,
    deviceFingerprint?: string
  ): Promise<{ success: boolean; questId: string; guestId: string; guestToken?: string }> => {
    return apiFetch<{ success: boolean; questId: string; guestId: string; guestToken?: string }>(
      `/api/quests/${questId}/complete`,
      {
        method: 'POST',
        body: JSON.stringify({ guestId, photoId, guestToken, deviceFingerprint }),
      }
    );
  },
};
