import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';

/**
 * A one-time pass is for one wedding (the owner's rule, 2026-10-18).
 *
 * A pass never lapsed, and the one-album limit only counted albums that
 * existed, so a host could delete the album after the wedding and make a new
 * one with a fresh 90 or 365 days: one €49 pass, any number of weddings.
 *
 * Now the account's pass is used up once the album it was bought for closes
 * or is deleted. The album keeps the pass for looking and downloading; a new
 * wedding needs a new pass, and buying one again is what reopens a closed
 * album.
 */

vi.mock('../../server/lib/stripe', () => ({
  isStripeConfigured: () => false,
  getStripeClient: () => {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  },
  subscriptionLivenessAtStripe: async () => 'ended',
}));

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { subscriptionsRouter } from '../../server/routes/subscriptions';
import { query } from '../../server/lib/db';
import { applyTierUpgrade, applyTierDowngradeToFree, retireSpentPass } from '../../server/lib/subscriptionUpgrade';
import { getEffectiveTierForEvent } from '../../server/middleware/tierGate';
import { deleteEventFixtures, deleteEventFixturesForHost } from '../helpers/cleanup';

const TEST_PORT = 6688;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const PASSWORD = 'Password123!';
let server: ReturnType<typeof createServer>;
const hosts: string[] = [];

interface Host {
  token: string;
  userId: string;
  eventId: string;
  slug: string;
  email: string;
}

const send = (method: string, url: string, token: string | null, body?: unknown) =>
  fetch(`${BASE_URL}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function hostWithPass(): Promise<Host> {
  const email = `pass-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const data = await (await send('POST', '/api/auth/register', null, { email, fullName: 'Pass Spec Host', password: PASSWORD })).json();
  hosts.push(data.user.id);
  await applyTierUpgrade(data.user.id, 'celebration_pass', {
    billingType: 'one_time',
    amountPaidCents: 4900,
    purchase: { eventId: data.event.id },
  });
  return { token: data.token, userId: data.user.id, eventId: data.event.id, slug: data.event.slug, email };
}

const account = async (userId: string) =>
  (
    await query<{ tier: string; one_time_tier: string | null; event_limit: number }>(
      "SELECT tier, one_time_tier, event_limit FROM subscriptions WHERE user_id = $1 AND status = 'active'",
      [userId]
    )
  ).rows[0];

const closeAlbum = (eventId: string) =>
  query("UPDATE events SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [eventId]);

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/subscriptions', subscriptionsRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  for (const userId of hosts) await deleteEventFixturesForHost(userId);
  if (server) server.close();
});

describe('one wedding per pass', () => {
  it('is used up when its album is deleted, so the next album is free', async () => {
    const host = await hostWithPass();

    const del = await send('DELETE', `/api/events/${host.eventId}`, host.token, { confirmSlug: host.slug });
    expect(del.status).toBe(200);

    expect(await account(host.userId)).toMatchObject({ tier: 'free', one_time_tier: null, event_limit: 1 });

    const created = await send('POST', '/api/events', host.token, { hostName: 'Second Wedding' });
    expect(created.status).toBe(201);
    const next = await created.json();
    await deleteEventFixtures([next.id]);
    expect(next.planTier).toBe('free');
  });

  it('is used up once its album has closed, and the album keeps what was paid for', async () => {
    const host = await hostWithPass();
    await closeAlbum(host.eventId);

    expect(await retireSpentPass(host.userId)).toBe(true);

    expect(await account(host.userId)).toMatchObject({ tier: 'free', one_time_tier: null });
    // Looking and downloading stay: the ZIP export needs the pass.
    expect(await getEffectiveTierForEvent(host.eventId)).toBe('celebration_pass');
  });

  it('is not spent while no album holds it, and the next album takes it', async () => {
    const host = await hostWithPass();
    // As if bought while the account had no album: held, but on no album.
    await query('UPDATE events SET pass_tier = NULL WHERE id = $1', [host.eventId]);
    await deleteEventFixtures([host.eventId]);

    expect(await retireSpentPass(host.userId)).toBe(false);
    expect((await account(host.userId)).one_time_tier).toBe('celebration_pass');

    const created = await (await send('POST', '/api/events', host.token, { hostName: 'First Album' })).json();
    const { rows } = await query<{ pass_tier: string | null }>('SELECT pass_tier FROM events WHERE id = $1', [created.id]);
    expect(rows[0].pass_tier).toBe('celebration_pass');
  });

  it('stays while its album is open', async () => {
    const host = await hostWithPass();
    expect(await retireSpentPass(host.userId)).toBe(false);
    expect((await account(host.userId)).tier).toBe('celebration_pass');
  });

  it('can be bought again for the same album, which reopens it', async () => {
    const host = await hostWithPass();
    await closeAlbum(host.eventId);

    // The fallback purchase route (no Stripe here) is refused nothing.
    const res = await send('POST', '/api/subscriptions/upgrade', host.token, {
      tier: 'celebration_pass',
      eventSlug: host.slug,
    });
    expect(res.status).toBe(200);

    const { rows } = await query<{ open: boolean }>('SELECT expires_at > NOW() AS open FROM events WHERE id = $1', [
      host.eventId,
    ]);
    expect(rows[0].open).toBe(true);
  });

  it('leaves a subscription in place: only the pass under it is used up', async () => {
    const host = await hostWithPass();
    await applyTierUpgrade(host.userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: `sub_${host.userId}` });

    const del = await send('DELETE', `/api/events/${host.eventId}`, host.token, { confirmSlug: host.slug });
    expect(del.status).toBe(200);

    expect(await account(host.userId)).toMatchObject({ tier: 'pro_planner', one_time_tier: null });
  });

  it('is not what a subscription falls back to once its album has closed', async () => {
    const host = await hostWithPass();
    await applyTierUpgrade(host.userId, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: `sub_${host.userId}` });
    await closeAlbum(host.eventId);

    await applyTierDowngradeToFree(host.userId);

    expect(await account(host.userId)).toMatchObject({ tier: 'free', one_time_tier: null });
  });
});

describe('the album made at sign-in for a host who has none (N-185)', () => {
  it("takes its deadline from the host's plan, not from the free plan", async () => {
    const email = `pass-login-${Date.now()}@test.com`;
    const data = await (await send('POST', '/api/auth/register', null, { email, fullName: 'Login Spec', password: PASSWORD })).json();
    hosts.push(data.user.id);
    await applyTierUpgrade(data.user.id, 'pro_planner', { billingType: 'monthly', stripeSubscriptionId: `sub_${data.user.id}` });
    await deleteEventFixtures([data.event.id]);

    const login = await (await send('POST', '/api/auth/login', null, { email, password: PASSWORD })).json();

    const { rows } = await query<{ expires_at: Date | null }>('SELECT expires_at FROM events WHERE id = $1', [login.event.id]);
    expect(rows[0].expires_at).toBeNull();
  });
});
