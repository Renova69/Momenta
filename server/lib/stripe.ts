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

/**
 * `live`, `ended`, or `unknown` when Stripe could not be asked.
 *
 * N-42 — this used to be a boolean that answered false on any error. Its
 * callers allow a downgrade or a new checkout on false, so a timeout, a 429 or
 * a Stripe outage at the wrong moment let a host drop to free while the
 * subscription went on billing — the H7 outcome by a transient error. Unknown
 * is not "no": callers refuse for now and ask the customer to retry.
 *
 * An id Stripe has never heard of is `ended`, not `unknown`. That is the stale
 * row a missed cancellation webhook leaves behind, and treating it as unknown
 * would block that customer from downgrading or subscribing again for good.
 */
export type SubscriptionLiveness = 'live' | 'ended' | 'unknown';

function isMissingResource(err: unknown): boolean {
  const e = err as { code?: string; statusCode?: number } | null;
  return e?.code === 'resource_missing' || e?.statusCode === 404;
}

/**
 * The subscription as Stripe holds it now, or null when Stripe has no such
 * subscription. Throws on anything else — a caller that cannot learn the
 * current state must not quietly fall back to a stale one (N-44).
 */
export async function retrieveSubscriptionOrNull(subscriptionId: string): Promise<Stripe.Subscription | null> {
  try {
    return await getStripeClient().subscriptions.retrieve(subscriptionId);
  } catch (err) {
    if (isMissingResource(err)) return null;
    throw err;
  }
}

export async function subscriptionLivenessAtStripe(subscriptionId: string): Promise<SubscriptionLiveness> {
  try {
    const subscription = await getStripeClient().subscriptions.retrieve(subscriptionId);
    return isLiveSubscriptionStatus(subscription.status) ? 'live' : 'ended';
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (isMissingResource(err)) {
      console.warn(`[Billing] Stripe has no subscription ${subscriptionId} — treating the stored id as stale:`, reason);
      return 'ended';
    }
    console.warn(`[Billing] could not verify subscription ${subscriptionId} at Stripe:`, reason);
    return 'unknown';
  }
}
