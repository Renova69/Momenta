import Stripe from 'stripe';
import { CONFIG } from './config';

/**
 * Lazily-constructed Stripe client. `CONFIG.STRIPE_SECRET_KEY` is
 * deliberately optional (see config.ts) — the owner plans to add real keys
 * later, and the app must keep working without them (local dev, demos, and
 * the self-serve subscriptions.ts fallback all depend on that). Constructing
 * a `Stripe` instance eagerly at module load with an empty string key would
 * throw immediately and take down the whole server on import, long before
 * any route that actually needs it runs.
 */
let client: Stripe | null = null;

/**
 * Pinned deliberately, and pinned to the exact version the installed SDK's
 * TypeScript definitions were generated from (`stripe/apiVersion.js`). Left
 * unset, the effective version is whatever default the SDK happens to ship,
 * so a routine `npm update stripe` becomes a silent API-behavior change with
 * no diff to review. Bump this only together with the SDK, after reading
 * Stripe's changelog for the versions in between.
 *
 * Note this governs *outbound* API calls only. The shape of an inbound
 * webhook payload follows the version configured on the webhook endpoint in
 * the Stripe Dashboard, which is a separate setting — see the payload-shape
 * handling in routes/billingWebhook.ts.
 */
const STRIPE_API_VERSION = '2026-08-26.dahlia';

export function isStripeConfigured(): boolean {
  return !!CONFIG.STRIPE_SECRET_KEY;
}

export function getStripeClient(): Stripe {
  if (!CONFIG.STRIPE_SECRET_KEY) {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  }
  if (!client) {
    client = new Stripe(CONFIG.STRIPE_SECRET_KEY, { apiVersion: STRIPE_API_VERSION });
  }
  return client;
}

/**
 * Whether a stored subscription id still corresponds to a live subscription at
 * Stripe.
 *
 * Anything that is not clearly live — cancelled, expired, or an id Stripe has
 * never heard of — counts as not live, so a stale row can never permanently
 * block a customer from either subscribing again or downgrading. Shared by the
 * checkout route (don't start a second subscription) and the downgrade guard
 * (don't strand a paying customer on the free tier).
 */
const LIVE_SUBSCRIPTION_STATUSES = ['active', 'trialing', 'past_due', 'unpaid', 'incomplete'];

/**
 * Which Stripe subscription statuses still mean "this customer is on the
 * hook". Split out from the lookup above so the rule itself can be tested
 * without a Stripe client, and so the test doubles in the billing specs can
 * delegate to it rather than restating the list and drifting from it.
 *
 * `past_due` and `unpaid` count as live deliberately: Stripe is still running
 * dunning, the subscription has not ended, and a customer in that state must
 * neither be double-billed by a second checkout nor quietly dropped to free
 * while their card is still being retried.
 */
export function isLiveSubscriptionStatus(status: string): boolean {
  return LIVE_SUBSCRIPTION_STATUSES.includes(status);
}

export async function isSubscriptionLiveAtStripe(subscriptionId: string): Promise<boolean> {
  try {
    const subscription = await getStripeClient().subscriptions.retrieve(subscriptionId);
    return isLiveSubscriptionStatus(subscription.status);
  } catch (err) {
    console.warn(
      `[Billing] could not verify subscription ${subscriptionId} at Stripe:`,
      err instanceof Error ? err.message : String(err)
    );
    return false;
  }
}
