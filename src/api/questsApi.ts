import { apiFetch } from './apiClient';
import { QuestLeaderboardEntry, ScavengerQuest } from '../types';

export const questsApi = {
  // List quests for an event
  list: async (eventId: string): Promise<ScavengerQuest[]> => {
    return apiFetch<ScavengerQuest[]>(`/api/events/${eventId}/quests`);
  },

  // Ranked guests; only photo-backed completions score
  leaderboard: async (eventId: string): Promise<QuestLeaderboardEntry[]> => {
    return apiFetch<QuestLeaderboardEntry[]>(`/api/events/${eventId}/leaderboard`);
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
};
