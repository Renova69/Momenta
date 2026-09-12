import { Router } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { pool } from '../lib/db';
import { CONFIG } from '../lib/config';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { errorLabel } from '../lib/errors';
import { getStripeClient, isStripeConfigured, isSubscriptionLiveAtStripe } from '../lib/stripe';
import { PAID_TIER_PRICING, PaidPlanTier, isPriceMapConfigured, priceIdForTier } from '../lib/stripePlans';

export const billingRouter = Router();

const CheckoutSessionSchema = z.object({
  tier: z.enum(['celebration_pass', 'deluxe_keepsake', 'pro_planner']),
  successUrl: z.string().url(),
  cancelUrl: z.string().url(),
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
    const { tier, successUrl, cancelUrl } = req.body as {
      tier: PaidPlanTier;
      successUrl: string;
      cancelUrl: string;
    };

    // Validate the request's own shape before checking whether the feature
    // is enabled — a malformed/malicious request is rejected the same way
    // regardless of Stripe's configuration state, and this ordering also
    // means the check is exercisable by tests even without real keys.
    if (!isAllowedRedirect(successUrl) || !isAllowedRedirect(cancelUrl)) {
      return res.status(400).json({ error: 'Invalid redirect URL' });
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

      if (pricing.mode === 'subscription' && storedSubscriptionId) {
        if (await isSubscriptionLiveAtStripe(storedSubscriptionId)) {
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

      const session = await getStripeClient().checkout.sessions.create({
        mode: pricing.mode,
        customer: stripeCustomerId,
        customer_email: stripeCustomerId ? undefined : email,
        line_items: [lineItemForTier(tier)],
        success_url: successUrl,
        cancel_url: cancelUrl,
        client_reference_id: userId,
        metadata: { userId, tier },
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
    return res.status(400).json({ error: 'Invalid return URL' });
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
