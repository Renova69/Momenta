import { Router } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { pool } from '../lib/db';
import { CONFIG } from '../lib/config';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { errorLabel } from '../lib/errors';
import { getStripeClient, isStripeConfigured, subscriptionLivenessAtStripe } from '../lib/stripe';
import { PAID_TIER_PRICING, PaidPlanTier, isPriceMapConfigured, priceIdForTier } from '../lib/stripePlans';
import { getEffectiveTierForUser } from '../middleware/tierGate';
import { TIER_WEIGHTS } from '../../shared/planCaps';

export const billingRouter = Router();

const CheckoutSessionSchema = z.object({
  tier: z.enum(['celebration_pass', 'deluxe_keepsake', 'pro_planner']),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
  /** N-169 — the album a one-time pass is bought for; the host's own only. */
  eventSlug: z.string().max(160).optional(),
});

/**
 * Origins a post-checkout redirect may land on. CORS_ORIGIN is the operator's
 * explicit browser allow-list, and PUBLIC_BASE_URL is always populated (it
 * falls back to localhost:PORT in config.ts), so the set is never empty and
 * a same-origin deployment that leaves CORS_ORIGIN blank still works.
 */
function allowedRedirectOrigins(): string[] {
  const configured = CONFIG.CORS_ORIGIN
    ? CONFIG.CORS_ORIGIN.toString().split(',').map((s) => s.trim()).filter(Boolean)
    : [];

  const origins = new Set<string>();
  for (const entry of [...configured, CONFIG.PUBLIC_BASE_URL]) {
    try {
      origins.add(new URL(entry).origin);
    } catch {
      // A malformed entry is skipped rather than fatal — it just never matches.
    }
  }
  return [...origins];
}

/**
 * The redirect targets are client-supplied, so pin them to a known-good
 * origin rather than trusting any URL.
 *
 * Default-deny matters more here than it looks: this used to allow *any*
 * origin whenever the allow-list came out empty, and .env.example ships
 * CORS_ORIGIN blank — so the shipped default let a payment on Stripe's own
 * hosted checkout page hand the customer straight to an attacker-controlled
 * site, with all the trust of having just completed a real purchase.
 */
function isAllowedRedirect(url: string): boolean {
  try {
    return allowedRedirectOrigins().includes(new URL(url).origin);
  } catch {
    return false;
  }
}

/**
 * How the line item is priced.
 *
 * With real Stripe Price IDs configured, use them: the Price is then a durable
 * record of what was sold, which the webhook reads back to decide the tier —
 * a far stronger claim than session metadata, which is editable from the
 * Dashboard. Without them, fall back to an ad-hoc `price_data` line item built
 * from PAID_TIER_PRICING, so the app sells correctly with no Dashboard setup
 * at all. See server/lib/stripePlans.ts.
 */
function lineItemForTier(tier: PaidPlanTier): Stripe.Checkout.SessionCreateParams.LineItem {
  if (isPriceMapConfigured()) {
    return { price: priceIdForTier(tier), quantity: 1 };
  }

  const pricing = PAID_TIER_PRICING[tier];
  return {
    price_data: {
      currency: 'eur',
      product_data: { name: pricing.productName },
      unit_amount: pricing.amountCents,
      ...(pricing.mode === 'subscription' ? { recurring: { interval: 'month' as const } } : {}),
    },
    quantity: 1,
  };
}

// POST /api/billing/checkout-session — creates a real Stripe Checkout
// Session for a paid tier. The tier is only ever written to the database
// from the webhook (routes/billingWebhook.ts), once Stripe confirms the
// payment actually happened — this route itself changes nothing in the
// database, and the price comes from the server (a configured Stripe Price,
// else PAID_TIER_PRICING) rather than from the client, which only names a tier.
billingRouter.post(
  '/checkout-session',
  requireAuth,
  validateBody(CheckoutSessionSchema),
  async (req, res) => {
    const { tier, successUrl, cancelUrl, eventSlug } = req.body as {
      tier: PaidPlanTier;
      successUrl: string;
      cancelUrl: string;
      eventSlug?: string;
    };

    // Validate the request's own shape before checking whether the feature
    // is enabled — a malformed/malicious request is rejected the same way
    // regardless of Stripe's configuration state, and this ordering also
    // means the check is exercisable by tests even without real keys.
    if (!isAllowedRedirect(successUrl) || !isAllowedRedirect(cancelUrl)) {
      // N-156 — reached by a host who opened the site at an address other
      // than PUBLIC_BASE_URL (www against the bare domain, say), so it needs
      // words they can read, not the English of a developer error.
      return res.status(400).json({ error: 'Invalid redirect URL', code: 'INVALID_REDIRECT' });
    }

    if (!isStripeConfigured()) {
      return res.status(503).json({
        error: 'Payments are not configured yet.',
        code: 'STRIPE_NOT_CONFIGURED',
      });
    }

    const pricing = PAID_TIER_PRICING[tier];
    const userId = req.user!.userId;

    try {
      const userRes = await pool.query('SELECT email FROM users WHERE id = $1', [userId]);
      if (userRes.rows.length === 0) return res.status(404).json({ error: 'User not found' });
      const email = userRes.rows[0].email as string;

      const existing = await pool.query(
        'SELECT stripe_customer_id, stripe_subscription_id FROM subscriptions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1',
        [userId]
      );
      const stripeCustomerId: string | undefined = existing.rows[0]?.stripe_customer_id || undefined;
      const storedSubscriptionId: string | null = existing.rows[0]?.stripe_subscription_id || null;

      // Asked once, used twice below: whether the subscription this account
      // has on file is still live at Stripe.
      const liveness = storedSubscriptionId ? await subscriptionLivenessAtStripe(storedSubscriptionId) : 'ended';
      // N-42 — both guards below read "could not ask" as "not live", which let
      // a second subscription start beside one Stripe could not see. Refuse
      // for now instead; checkout needs Stripe anyway.
      if (liveness === 'unknown' && pricing.mode === 'subscription') {
        return res.status(503).json({
          error: 'We could not check your subscription with our payment provider. Please try again in a few minutes.',
          code: 'BILLING_UNVERIFIABLE',
        });
      }
      // For a one-time pass, an unanswerable check counts as live: the stored
      // plan is then treated as a real entitlement, never as a stale row.
      const subscriptionLive = liveness !== 'ended';

      if (pricing.mode === 'subscription' && storedSubscriptionId) {
        if (subscriptionLive) {
          return res.status(400).json({
            error: 'You already have an active subscription. Manage it instead of starting a new one.',
            code: 'ALREADY_SUBSCRIBED',
          });
        }
        // A stored id that Stripe no longer recognises as live is stale (the
        // cancellation webhook was missed, say). Blocking on it would lock the
        // customer out of ever subscribing again, which is a worse failure
        // than the duplicate this check exists to prevent — so let it through.
        console.warn(
          `[Billing] user ${userId} has stored subscription ${storedSubscriptionId} that is not live at Stripe — allowing a new checkout`
        );
      }

      // Nothing to sell: this account already holds an equal or better plan.
      // Without this a Pro Planner subscriber could buy a one-time Celebration
      // Pass — €49 for less than they already have — and the tier write behind
      // it used to take the difference away.
      //
      // A stored tier whose subscription Stripe no longer calls live is not an
      // entitlement, it is a row that outlived it (a missed cancellation
      // webhook). Blocking on that would lock a returning customer out of ever
      // paying again, which is the same trap the guard above steps around.
      const currentTier = await getEffectiveTierForUser(userId);
      const entitlementIsStale = !!storedSubscriptionId && !subscriptionLive;
      if (!entitlementIsStale && (TIER_WEIGHTS[currentTier] ?? 0) >= (TIER_WEIGHTS[tier] ?? 0)) {
        return res.status(400).json({
          error: 'Your current plan already includes everything in this one.',
          code: 'ALREADY_ENTITLED',
          currentTier,
        });
      }

      // A one-time pass is for one album (N-169): the one the studio has open,
      // if it is this host's. The webhook records the pass there.
      const album = eventSlug
        ? await pool.query<{ id: string }>('SELECT id FROM events WHERE slug = $1 AND host_user_id = $2', [eventSlug, userId])
        : null;
      const eventId = album?.rows[0]?.id;

      const session = await getStripeClient().checkout.sessions.create({
        mode: pricing.mode,
        customer: stripeCustomerId,
        customer_email: stripeCustomerId ? undefined : email,
        line_items: [lineItemForTier(tier)],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: userId,
        metadata: { userId, tier, ...(eventId ? { eventId } : {}) },
        // Copied onto the subscription itself so a later cancellation event
        // — which carries the subscription, never the session — can still be
        // traced back to this account. billingWebhook.ts falls back to the
        // stored subscription id when this is missing.
        subscription_data: pricing.mode === 'subscription' ? { metadata: { userId, tier } } : undefined,
      });

      res.json({ url: session.url });
    } catch (err) {
      console.error('[Billing] checkout-session error:', errorLabel(err));
      res.status(500).json({ error: 'Failed to start checkout' });
    }
  }
);

/**
 * GET /api/billing/status — what the studio must tell the host about paying.
 *
 * N-152 — when a renewal fails, the webhook keeps the plan until
 * `past_due_grace_expiry` and the grace sweep ends it there. Nothing told the
 * host in between: no email can go out while SMTP is unset, and the studio
 * looked exactly as it did on a paid-up plan, so the first sign of trouble
 * was the plan disappearing a week later. Read from the database only, so
 * opening the studio never waits on Stripe.
 */
billingRouter.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT tier, past_due_grace_expiry, one_time_tier, lapsed_tier, stripe_subscription_id FROM subscriptions
        WHERE user_id = $1 AND status = 'active' ORDER BY updated_at DESC LIMIT 1`,
      [req.user!.userId]
    );
    const row = rows[0] as
      | {
          tier: string;
          past_due_grace_expiry: Date | null;
          one_time_tier: string | null;
          lapsed_tier: string | null;
          stripe_subscription_id: string | null;
        }
      | undefined;
    // N-164 — a one-time pass bought before a subscription is what the account
    // falls back to when the subscription ends, so leaving it is not leaving
    // everything.
    const keepsTier =
      row?.one_time_tier && row.one_time_tier !== 'free' && row.one_time_tier !== row.tier ? row.one_time_tier : null;
    res.json({
      tier: row?.tier ?? 'free',
      paymentFailed: !!row?.past_due_grace_expiry,
      planEndsAt: row?.past_due_grace_expiry ?? null,
      keepsTier,
      // Past the grace: the plan is parked in lapsed_tier, and a payment on
      // the subscription still on file brings it back (restoreLapsedTier).
      planSuspended: !!row?.lapsed_tier && !!row.stripe_subscription_id,
    });
  } catch (err) {
    console.error('[Billing] status error:', errorLabel(err));
    res.status(500).json({ error: 'Internal server error' });
  }
});

const PortalSessionSchema = z.object({
  returnUrl: z.string().url(),
});

/**
 * POST /api/billing/portal-session — a Stripe Billing Portal link.
 *
 * H7 — the self-service route no longer cancels a live subscription on the
 * customer's behalf, so there has to be somewhere to send them instead. The
 * Portal is where Stripe expects cancellation, plan changes and payment-method
 * updates to happen, and it means this app never has to hold the authority to
 * destroy a subscription from a non-billing endpoint.
 *
 * `returnUrl` is pinned to the same allow-list as the checkout redirects, for
 * the same reason: it is client-supplied and the customer arrives at it
 * carrying the trust of having just been on Stripe's own page.
 */
billingRouter.post('/portal-session', requireAuth, validateBody(PortalSessionSchema), async (req, res) => {
  const { returnUrl } = req.body as { returnUrl: string };

  if (!isAllowedRedirect(returnUrl)) {
    return res.status(400).json({ error: 'Invalid return URL', code: 'INVALID_REDIRECT' });
  }

  if (!isStripeConfigured()) {
    return res.status(503).json({ error: 'Payments are not configured yet.', code: 'STRIPE_NOT_CONFIGURED' });
  }

  try {
    const existing = await pool.query(
      'SELECT stripe_customer_id FROM subscriptions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1',
      [req.user!.userId]
    );
    const customerId = existing.rows[0]?.stripe_customer_id as string | undefined;
    if (!customerId) {
      return res.status(404).json({
        error: 'No billing account exists for this user yet.',
        code: 'NO_STRIPE_CUSTOMER',
      });
    }

    const session = await getStripeClient().billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error('[Billing] portal-session error:', errorLabel(err));
    res.status(500).json({ error: 'Failed to open the billing portal' });
  }
});
