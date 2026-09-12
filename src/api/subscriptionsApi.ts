import { apiFetch } from './apiClient';
import { PlanTier } from '../types';

export interface SubscriptionSummary {
  id: string;
  tier: PlanTier;
  status: string;
  event_limit: number;
}

export const subscriptionsApi = {
  // Sets the caller's plan tier for real. See server/routes/subscriptions.ts
  // for why this writes the subscriptions row directly rather than going
  // through a payment gateway.
  upgrade: async (tier: PlanTier): Promise<SubscriptionSummary> => {
    return apiFetch<SubscriptionSummary>('/api/subscriptions/upgrade', {
      method: 'POST',
      body: JSON.stringify({ tier }),
    });
  },
};
