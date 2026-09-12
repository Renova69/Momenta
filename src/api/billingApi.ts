import { apiFetch, ApiError } from './apiClient';
import { PlanTier } from '../types';

export interface CheckoutSessionResult {
  url: string;
}

export const billingApi = {
  /**
   * Starts a real Stripe Checkout for a paid tier. Throws an ApiError with
   * code 'STRIPE_NOT_CONFIGURED' (503) while STRIPE_SECRET_KEY isn't set yet
   * — PricingPlansModal catches that specific code and falls back to the
   * direct self-serve upgrade instead of surfacing it as a failure.
   */
  createCheckoutSession: async (
    tier: Exclude<PlanTier, 'free'>,
    successUrl: string,
    cancelUrl: string
  ): Promise<CheckoutSessionResult> => {
    return apiFetch<CheckoutSessionResult>('/api/billing/checkout-session', {
      method: 'POST',
      body: JSON.stringify({ tier, successUrl, cancelUrl }),
    });
  },
};

export function isStripeNotConfiguredError(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'STRIPE_NOT_CONFIGURED';
}

/**
 * A Stripe Billing Portal link for the signed-in host (H7).
 *
 * The self-service downgrade refuses while a subscription is still live at
 * Stripe, answering MANAGE_SUBSCRIPTION_IN_PORTAL — this is where that
 * refusal sends the customer, so cancelling actually stops the charge instead
 * of only changing the tier on our side.
 */
export async function createBillingPortalSession(returnUrl: string): Promise<{ url: string }> {
  return apiFetch<{ url: string }>('/api/billing/portal-session', {
    method: 'POST',
    body: JSON.stringify({ returnUrl }),
  });
}

/** True when a plan change was refused because the subscription must be cancelled at Stripe. */
export function isManageInPortalError(err: unknown): boolean {
  return !!err && typeof err === 'object' && (err as { code?: string }).code === 'MANAGE_SUBSCRIPTION_IN_PORTAL';
}
