import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth';
import { validateBody } from '../middleware/validate';
import { errorLabel } from '../lib/errors';
import { BackendPlanTier } from '../middleware/tierGate';
import { applyTierUpgrade } from '../lib/subscriptionUpgrade';
import { isStripeConfigured, isSubscriptionLiveAtStripe } from '../lib/stripe';
import { pool } from '../lib/db';

export const subscriptionsRouter = Router();

const UpgradeSchema = z.object({
  tier: z.enum(['free', 'celebration_pass', 'deluxe_keepsake', 'pro_planner']),
});

// POST /api/subscriptions/upgrade — set the caller's plan tier directly,
// with no payment behind it.
//
// This is the pre-Stripe fallback, not the primary path: server/routes/billing.ts
// creates a real Stripe Checkout Session and the tier is written only from a
// verified webhook. This route stays reachable for two reasons — (1) it is
// what the pricing modal falls back to automatically while
// STRIPE_SECRET_KEY is unset (server/lib/stripe.ts), so local dev and demos
// keep working with zero setup, and (2) a free-tier "downgrade" never needs
// a payment step regardless of Stripe's configuration.
//
// It originally existed to close a worse bug: the client was already
// showing confetti and a "your plan is now X" UI for a PUT /api/events/:id
// request the server silently ignored, then reverting on next load. See
// OPEN_ITEMS.md for that history.
subscriptionsRouter.post('/upgrade', requireAuth, validateBody(UpgradeSchema), async (req, res) => {
  const { tier } = req.body as { tier: BackendPlanTier };
  const userId = req.user!.userId;

  // SECURITY — this route grants a tier with no payment behind it, which is
  // only defensible while there is no payment processor to route through.
  // The "fallback" framing above was previously just a comment: nothing
  // enforced it, so the moment real keys were added, any authenticated user
  // could POST {"tier":"pro_planner"} straight here and skip checkout
  // entirely. The client preferring Stripe is not a control — this is.
  // Downgrading to free involves no payment, so it stays open either way.
  if (tier !== 'free' && isStripeConfigured()) {
    return res.status(403).json({
      error: 'Paid plans must be purchased through checkout',
      code: 'CHECKOUT_REQUIRED',
    });
  }

  try {
    // H7 — downgrading to free needs no payment step, which is why this route
    // stayed open for it. What it never did was tell Stripe. The stored
    // subscription id was cleared locally while the subscription itself stayed
    // live, so the card kept being charged for a plan the account no longer
    // had; the next invoice.paid then found tier=free, failed isPaidTier, and
    // did nothing at all with the money. Retention was recomputed at the free
    // tier in the same breath.
    //
    // Cancelling at Stripe from here would fix the divergence but hand a
    // non-billing endpoint the authority to destroy a subscription on a single
    // request. Refusing and pointing at the Billing Portal — where Stripe
    // expects cancellation to happen — keeps that authority where it belongs.
    // A stale id that Stripe no longer recognises must not strand the customer,
    // so only a genuinely live subscription blocks.
    if (tier === 'free' && isStripeConfigured()) {
      const existing = await pool.query(
        'SELECT stripe_subscription_id FROM subscriptions WHERE user_id = $1 ORDER BY updated_at DESC LIMIT 1',
        [userId]
      );
      const subscriptionId = existing.rows[0]?.stripe_subscription_id as string | null | undefined;

      if (subscriptionId && (await isSubscriptionLiveAtStripe(subscriptionId))) {
        return res.status(409).json({
          error:
            'Your subscription is still active with our payment provider. ' +
            'Cancel it in the billing portal so you stop being charged.',
          code: 'MANAGE_SUBSCRIPTION_IN_PORTAL',
        });
      }
    }

    const result = await applyTierUpgrade(userId, tier);
    res.json(result);
  } catch (err) {
    console.error('[Subscriptions] upgrade error:', errorLabel(err));
    res.status(500).json({ error: 'Failed to update plan' });
  }
});
