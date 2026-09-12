import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

/**
 * The MEDIUM query-shape findings from the 2026-09-11 review.
 *
 *   M5 — GET /api/events resolved the plan tier once per event, sequentially,
 *        inside a `for` loop. The tier is a property of the *host*, and every
 *        row in that response belongs to the one authenticated host, so the
 *        answer is identical for all of them.
 *   M6 — GET /api/photos carried three correlated subqueries per row
 *        (comments with a join, likes, reactions). At the maximum limit of 200
 *        that is 600 subquery executions to render one feed page.
 *   M7 — the Stripe webhook called checkout.sessions.listLineItems (a network
 *        round trip to Stripe) from inside the open transaction, while holding
 *        both a pooled connection and the per-customer advisory lock.
 */

const STRIPE_CALLS: string[] = [];
const TX_EVENTS: string[] = [];

vi.mock('../../server/lib/stripe', () => ({
  isStripeConfigured: () => true,
  getStripeClient: () => ({
    webhooks: {
      constructEvent: (body: Buffer) => JSON.parse(body.toString()),
    },
    checkout: {
      sessions: {
        listLineItems: async () => {
          STRIPE_CALLS.push('listLineItems');
          TX_EVENTS.push('stripe:listLineItems');
          return { data: [{ price: { id: 'price_celebration_test' } }] };
        },
      },
    },
  }),
}));

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { handleStripeWebhook } from '../../server/routes/billingWebhook';
import { CONFIG } from '../../server/lib/config';
import { pool, query } from '../../server/lib/db';

const TEST_PORT = 6636;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];
const createdUsers: string[] = [];

interface Host {
  token: string;
  userId: string;
  eventId: string;
}

async function registerHost(): Promise<Host> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `shape-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Query Shape Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  createdUsers.push(data.user.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

/** Count the SQL statements issued on the pool while `fn` runs. */
async function countQueries(fn: () => Promise<void>): Promise<string[]> {
  const statements: string[] = [];
  const realQuery = pool.query.bind(pool);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const spy = vi.spyOn(pool, 'query').mockImplementation(((...args: any[]) => {
    const text = typeof args[0] === 'string' ? args[0] : args[0]?.text;
    if (typeof text === 'string') statements.push(text);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (realQuery as any)(...args);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any);
  try {
    await fn();
  } finally {
    spy.mockRestore();
  }
  return statements;
}

describe('query shape (MEDIUM)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.post('/api/billing/webhook', express.raw({ type: 'application/json' }), handleStripeWebhook);
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const jpeg = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 210, g: 190, b: 150 } },
    })
      .jpeg()
      .toBuffer();
    jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(() => undefined);
    await query('DELETE FROM users WHERE id = ANY($1::uuid[])', [createdUsers]).catch(() => undefined);
    if (server) server.close();
  });

  afterEach(() => {
    STRIPE_CALLS.length = 0;
    TX_EVENTS.length = 0;
  });

  describe('M5 — host event list resolves the tier once', () => {
    it('does not scale tier lookups with the number of events', async () => {
      const host = await registerHost();
      // Pro Planner allows 10 events, so the host can actually own several.
      await query(
        "UPDATE subscriptions SET tier = 'pro_planner', event_limit = 10 WHERE user_id = $1 AND status = 'active'",
        [host.userId]
      );
      for (let i = 0; i < 4; i++) {
        const res = await fetch(`${BASE_URL}/api/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
          body: JSON.stringify({ hostName: `Shape Host ${i}` }),
        });
        expect(res.status).toBe(201);
        createdEvents.push((await res.json()).id);
      }

      let listed: unknown[] = [];
      const statements = await countQueries(async () => {
        const res = await fetch(`${BASE_URL}/api/events`, {
          headers: { Authorization: `Bearer ${host.token}` },
        });
        listed = await res.json();
      });

      expect(listed.length).toBe(5);
      // getEffectiveTierForEvent reads the tier through `JOIN subscriptions`,
      // so match either shape rather than assuming the FROM clause.
      const tierLookups = statements.filter(
        (sql) => /(?:FROM|JOIN)\s+subscriptions/i.test(sql) && /\btier\b/i.test(sql)
      );
      expect(tierLookups.length).toBeLessThanOrEqual(1);
    });

    it('still reports the correct tier on every row', async () => {
      const host = await registerHost();
      await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1 AND status = 'active'", [
        host.userId,
      ]);

      const res = await fetch(`${BASE_URL}/api/events`, { headers: { Authorization: `Bearer ${host.token}` } });
      const events = (await res.json()) as { planTier: string }[];

      expect(events.length).toBeGreaterThan(0);
      for (const ev of events) expect(ev.planTier).toBe('deluxe_keepsake');
    });
  });

  describe('M6 — photo feed aggregates without per-row subqueries', () => {
    async function seedPhoto(host: Host): Promise<{ photoId: string; guestId: string; guestToken: string }> {
      const res = await fetch(`${BASE_URL}/api/photos`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          eventId: host.eventId,
          guestName: 'Shape Guest',
          deviceFingerprint: `shape-fp-${Math.random().toString(36).slice(2, 8)}`,
          fullUrl: jpegDataUrl,
        }),
      });
      const body = await res.json();
      return { photoId: body.id, guestId: body.guestId, guestToken: body.guestToken };
    }

    it('keeps the statement count flat as the album grows', async () => {
      const host = await registerHost();
      for (let i = 0; i < 6; i++) await seedPhoto(host);

      const statements = await countQueries(async () => {
        const res = await fetch(`${BASE_URL}/api/photos?eventId=${host.eventId}`);
        expect((await res.json()).length).toBe(6);
      });

      // Whatever the aggregation strategy, it must not be per-row.
      expect(statements.length).toBeLessThanOrEqual(8);
      const correlated = statements.filter((sql) => /json_agg|array_agg/i.test(sql) && /WHERE\s+\w+\.photo_id\s*=\s*p\.id/i.test(sql));
      expect(correlated).toEqual([]);
    });

    it('returns comments, likes and reactions with the same shape as before', async () => {
      const host = await registerHost();
      const { photoId, guestId, guestToken } = await seedPhoto(host);

      await fetch(`${BASE_URL}/api/photos/${photoId}/like`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ guestId, guestToken }),
      });
      await fetch(`${BASE_URL}/api/photos/${photoId}/reactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reaction: 'clap', guestId, guestToken }),
      });
      for (const text of ['first wish', 'second wish']) {
        await fetch(`${BASE_URL}/api/photos/${photoId}/comments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ guestId, guestToken, guestName: 'Shape Guest', commentText: text }),
        });
      }

      const res = await fetch(`${BASE_URL}/api/photos?eventId=${host.eventId}`);
      const [photo] = await res.json();

      expect(photo.likedByGuestIds).toEqual([guestId]);
      expect(photo.reactions).toEqual([{ reaction: 'clap', guestId }]);
      expect(photo.comments).toHaveLength(2);
      // Oldest first, matching the previous ORDER BY c.created_at ASC.
      expect(photo.comments.map((c: { commentText: string }) => c.commentText)).toEqual(['first wish', 'second wish']);
      expect(photo.comments[0]).toMatchObject({ photoId, guestId, guestName: 'Shape Guest' });
    });

    it('returns empty aggregates, not nulls, for a photo with no activity', async () => {
      const host = await registerHost();
      await seedPhoto(host);

      const res = await fetch(`${BASE_URL}/api/photos?eventId=${host.eventId}`);
      const [photo] = await res.json();

      expect(photo.likedByGuestIds).toEqual([]);
      expect(photo.reactions).toEqual([]);
      expect(photo.comments).toEqual([]);
    });
  });

  describe('M7 — Stripe is not called from inside the transaction', () => {
    it('resolves the purchased tier before opening the transaction', async () => {
      const host = await registerHost();
      CONFIG.STRIPE_WEBHOOK_SECRET = 'whsec_shape_test';
      CONFIG.STRIPE_PRICE_CELEBRATION_PASS = 'price_celebration_test';
      CONFIG.STRIPE_PRICE_DELUXE_KEEPSAKE = 'price_deluxe_test';
      CONFIG.STRIPE_PRICE_PRO_PLANNER = 'price_pro_test';

      const realConnect = pool.connect.bind(pool);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const connectSpy = vi.spyOn(pool, 'connect').mockImplementation(((...args: unknown[]) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (args.length > 0) return (realConnect as any)(...args);
        return realConnect().then((client) => {
          const realQuery = client.query.bind(client);
          const realRelease = client.release.bind(client);
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).query = (...q: any[]) => {
            const text = typeof q[0] === 'string' ? q[0] : q[0]?.text;
            if (typeof text === 'string' && /^\s*(BEGIN|COMMIT|ROLLBACK)/i.test(text)) {
              TX_EVENTS.push(`tx:${text.trim().split(/\s/)[0].toUpperCase()}`);
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (realQuery as any)(...q);
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (client as any).release = (...r: any[]) => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (client as any).query = realQuery;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (client as any).release = realRelease;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            return (realRelease as any)(...r);
          };
          return client;
        });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      }) as any);

      try {
        const event = {
          id: `evt_shape_${Date.now()}`,
          type: 'checkout.session.completed',
          data: {
            object: {
              id: `cs_shape_${Date.now()}`,
              payment_status: 'paid',
              mode: 'payment',
              amount_total: 4900,
              customer: `cus_shape_${Date.now()}`,
              metadata: { userId: host.userId, tier: 'celebration_pass' },
            },
          },
        };

        const res = await fetch(`${BASE_URL}/api/billing/webhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'stripe-signature': 'test' },
          body: JSON.stringify(event),
        });
        expect(res.status).toBe(200);
      } finally {
        connectSpy.mockRestore();
      }

      expect(STRIPE_CALLS).toContain('listLineItems');
      const stripeAt = TX_EVENTS.indexOf('stripe:listLineItems');
      const beginAt = TX_EVENTS.indexOf('tx:BEGIN');
      expect(stripeAt).toBeGreaterThanOrEqual(0);
      expect(beginAt).toBeGreaterThanOrEqual(0);
      // A network round trip must not happen while a pooled connection and the
      // per-customer advisory lock are both held.
      expect(stripeAt).toBeLessThan(beginAt);

      const sub = await query<{ tier: string }>(
        "SELECT tier FROM subscriptions WHERE user_id = $1 AND status = 'active'",
        [host.userId]
      );
      expect(sub.rows[0].tier).toBe('celebration_pass');
    });
  });
});
