import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';

/**
 * The price-authoritative path: with real Stripe Price IDs configured, the
 * purchased tier is decided by the Price the customer was actually charged
 * against, and the session's `metadata.tier` is only a cross-check.
 *
 * That distinction is the whole point — metadata is a free-form string
 * editable from the Stripe Dashboard, while the Price is the record the money
 * moved against. These specs pin both halves: the Price decides, and a
 * disagreement grants nothing rather than picking a winner.
 */
const PRICE_IDS = vi.hoisted(() => {
  const ids = {
    celebration_pass: 'price_test_celebration',
    deluxe_keepsake: 'price_test_deluxe',
    pro_planner: 'price_test_pro',
  };
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_billing_price_map_spec';
  process.env.STRIPE_PRICE_CELEBRATION_PASS = ids.celebration_pass;
  process.env.STRIPE_PRICE_DELUXE_KEEPSAKE = ids.deluxe_keepsake;
  process.env.STRIPE_PRICE_PRO_PLANNER = ids.pro_planner;
  return ids;
});

/** Line items Stripe will report for a session id, set per test. */
const lineItemsBySession = new Map<string, string[]>();

vi.mock('../../server/lib/stripe', () => ({
  isStripeConfigured: () => true,
  getStripeClient: () => ({
    webhooks: {
      constructEvent: (body: Buffer) => JSON.parse(body.toString()),
    },
    checkout: {
      sessions: {
        listLineItems: (sessionId: string) => ({
          data: (lineItemsBySession.get(sessionId) ?? []).map((price) => ({ price: { id: price } })),
        }),
      },
    },
  }),
}));

import { authRouter } from '../../server/routes/auth';
import { handleStripeWebhook } from '../../server/routes/billingWebhook';
import { isPriceMapConfigured, tierForPriceId } from '../../server/lib/stripePlans';
import { query } from '../../server/lib/db';

const TEST_PORT = 6628;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

function uniqueId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

async function registerHost(): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `pricemap-${uniqueId('u')}@test.com`,
      fullName: 'Price Map Host',
      password: 'Password123!',
    }),
  });
  return (await res.json()).user.id as string;
}

async function tierOf(userId: string): Promise<string> {
  const res = await query("SELECT tier FROM subscriptions WHERE user_id = $1 AND status = 'active'", [userId]);
  return res.rows[0].tier;
}

/** Posts a paid checkout session whose Stripe line items carry `prices`. */
async function postPaidSession(
  userId: string,
  prices: string[],
  metadataTier?: string
): Promise<Response> {
  const sessionId = uniqueId('cs');
  lineItemsBySession.set(sessionId, prices);

  return fetch(`${BASE_URL}/api/billing/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'stripe-signature': 't=1,v1=stubbed' },
    body: JSON.stringify({
      id: uniqueId('evt'),
      type: 'checkout.session.completed',
      data: {
        object: {
          id: sessionId,
          mode: 'payment',
          payment_status: 'paid',
          amount_total: 8900,
          customer: uniqueId('cus'),
          metadata: metadataTier === undefined ? { userId } : { userId, tier: metadataTier },
        },
      },
    }),
  });
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  if (server) server.close();
});

describe('price map configuration', () => {
  it('is active only when every paid tier has a Price ID', () => {
    expect(isPriceMapConfigured()).toBe(true);
  });

  it('maps each configured Price back to its tier, and unknown prices to null', () => {
    expect(tierForPriceId(PRICE_IDS.deluxe_keepsake)).toBe('deluxe_keepsake');
    expect(tierForPriceId(PRICE_IDS.pro_planner)).toBe('pro_planner');
    expect(tierForPriceId('price_someone_made_by_hand')).toBeNull();
    expect(tierForPriceId(null)).toBeNull();
  });
});

describe('tier resolution from the Stripe Price', () => {
  it('grants the tier the Price sells', async () => {
    const userId = await registerHost();

    await postPaidSession(userId, [PRICE_IDS.deluxe_keepsake], 'deluxe_keepsake');

    expect(await tierOf(userId)).toBe('deluxe_keepsake');
  });

  it('grants from the Price even when the session carries no tier metadata at all', async () => {
    const userId = await registerHost();

    await postPaidSession(userId, [PRICE_IDS.celebration_pass]);

    expect(await tierOf(userId)).toBe('celebration_pass');
  });

  it('grants NOTHING when metadata contradicts the Price that was charged', async () => {
    const userId = await registerHost();

    // Metadata is editable from the Stripe Dashboard; the Price is what the
    // money moved against. A disagreement means something is misconfigured,
    // and quietly picking either one would be a pricing bug that bills wrong.
    const res = await postPaidSession(userId, [PRICE_IDS.celebration_pass], 'pro_planner');

    expect(res.status).toBe(200);
    expect(await tierOf(userId)).toBe('free');
  });

  it('grants nothing for a Price this app does not sell', async () => {
    const userId = await registerHost();

    await postPaidSession(userId, ['price_left_over_from_old_pricing'], 'deluxe_keepsake');

    expect(await tierOf(userId)).toBe('free');
  });

  it('grants nothing when a session mixes two known tiers', async () => {
    const userId = await registerHost();

    await postPaidSession(userId, [PRICE_IDS.celebration_pass, PRICE_IDS.pro_planner]);

    expect(await tierOf(userId)).toBe('free');
  });
});
