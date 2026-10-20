import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';

/**
 * N-168 and N-169 — who may move an album's closing date.
 *
 * N-168: editing the wedding date recomputed `expires_at` from the new date,
 * so a host could reopen a closed album, or keep any album open for as long
 * as they liked, without paying. Setting the date to 2099 kept a free album
 * open until 2099; a date that was not a date answered 500.
 *
 * N-169: a plan bought for an older wedding counted its days from the
 * wedding, so a €49 pass for a wedding four months gone left the album closed.
 *
 * The owner's rule (2026-10-18): the plan decides. Editing the date never
 * reopens a closed album; only a purchase does, and a plan gives its days
 * from the wedding or from the purchase, whichever is later. A wedding date
 * must be a real date, at most two years ahead.
 */

// Payment paths run without Stripe; nothing here may reach it.
vi.mock('../../server/lib/stripe', () => ({
  isStripeConfigured: () => false,
  getStripeClient: () => {
    throw new Error('Stripe is not configured (STRIPE_SECRET_KEY missing)');
  },
}));

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { query } from '../../server/lib/db';
import { applyTierUpgrade, retireSpentPass } from '../../server/lib/subscriptionUpgrade';
import { getEffectiveTierForEvent } from '../../server/middleware/tierGate';
import { isAcceptableWeddingDate } from '../../shared/eventLimits';
import { refreshExpiryDates } from '../../server/lib/retention';
import { deleteEventFixtures } from '../helpers/cleanup';

const TEST_PORT = 6687;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const DAY = 24 * 60 * 60 * 1000;
let server: ReturnType<typeof createServer>;
const createdEvents: string[] = [];

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
      email: `deadline-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Deadline Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

const putEvent = (host: Host, body: unknown) =>
  fetch(`${BASE_URL}/api/events/${host.eventId}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
    body: JSON.stringify(body),
  });

/** A free album whose wedding was `daysAgo` days ago, closed since a week after it. */
async function closedAlbum(host: Host, daysAgo: number): Promise<Date> {
  const { rows } = await query<{ expires_at: Date }>(
    `UPDATE events
        SET event_date = NOW() - make_interval(days => $2),
            created_at = NOW() - make_interval(days => $2 + 10),
            expires_at = NOW() - make_interval(days => $2) + INTERVAL '7 days'
      WHERE id = $1 RETURNING expires_at`,
    [host.eventId, daysAgo]
  );
  return rows[0].expires_at;
}

const albumRow = async (eventId: string) =>
  (
    await query<{ expires_at: Date | null; pass_tier: string | null; pass_started_at: Date | null }>(
      'SELECT expires_at, pass_tier, pass_started_at FROM events WHERE id = $1',
      [eventId]
    )
  ).rows[0];

const isoDaysFromNow = (days: number) => new Date(Date.now() + days * DAY).toISOString();

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json());
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  if (server) server.close();
});

describe('editing the wedding date (N-168)', () => {
  it('leaves a closed album closed', async () => {
    const host = await registerHost();
    const closedAt = await closedAlbum(host, 30);

    const res = await putEvent(host, { eventDate: isoDaysFromNow(0) });

    expect(res.status).toBe(200);
    expect((await albumRow(host.eventId)).expires_at?.getTime()).toBe(closedAt.getTime());
  });

  it('is not undone by a later recompute either', async () => {
    const host = await registerHost();
    const closedAt = await closedAlbum(host, 30);
    await query('UPDATE events SET event_date = NOW() WHERE id = $1', [host.eventId]);

    await refreshExpiryDates(host.userId);

    expect((await albumRow(host.eventId)).expires_at?.getTime()).toBe(closedAt.getTime());
  });

  it('still moves the deadline of an album that is open', async () => {
    const host = await registerHost();
    const date = isoDaysFromNow(60);

    expect((await putEvent(host, { eventDate: date })).status).toBe(200);

    const expiresAt = (await albumRow(host.eventId)).expires_at!.getTime();
    expect(Math.abs(expiresAt - (Date.parse(date) + 7 * DAY))).toBeLessThan(60_000);
  });

  it('refuses a wedding more than two years ahead', async () => {
    const host = await registerHost();
    const res = await putEvent(host, { eventDate: '2099-06-01T12:00:00.000Z' });
    expect(res.status).toBe(400);
  });

  it('refuses a date that is not a date, instead of failing', async () => {
    const host = await registerHost();
    const res = await putEvent(host, { eventDate: 'not-a-date' });
    expect(res.status).toBe(400);
  });

  // N-194 — the check read the string with JavaScript's parser and Postgres
  // stored it with its own. They disagree on two-digit years: '12/31/69' is
  // 1969 to one and 2069 to the other, so a free album stayed open 43 years.
  it.each(['12/31/69', '1/1/50', 'Jan 1 50'])(
    'refuses %s, which the database would read as another year (N-194)',
    async (eventDate) => {
      const host = await registerHost();
      const before = (await albumRow(host.eventId)).expires_at?.getTime();

      expect((await putEvent(host, { eventDate })).status).toBe(400);
      expect((await albumRow(host.eventId)).expires_at?.getTime()).toBe(before);
    }
  );

  it('refuses a day that does not exist, instead of failing (N-194)', async () => {
    const host = await registerHost();
    expect((await putEvent(host, { eventDate: '2026-02-30' })).status).toBe(400);
  });
});

// N-200 — the owner's rule (2026-10-20): two calendar years, so the same day
// two years on is allowed whatever 29 February falls between.
describe('the two-year limit (N-200)', () => {
  const at = (iso: string) => Date.parse(iso);

  it('allows the same day two years on, across a 29 February', () => {
    const now = at('2026-10-20T08:00:00.000Z');
    expect(isAcceptableWeddingDate('2028-10-19T12:00:00.000Z', now)).toBe(true);
    expect(isAcceptableWeddingDate('2028-10-20T12:00:00.000Z', now)).toBe(true);
    expect(isAcceptableWeddingDate('2028-10-21T12:00:00.000Z', now)).toBe(false);
  });

  it('allows that day at any hour, not only before the current time', () => {
    const now = at('2029-03-10T08:00:00.000Z');
    expect(isAcceptableWeddingDate('2031-03-10T14:00:00.000Z', now)).toBe(true);
  });

  it('counts two years from 29 February as reaching 1 March', () => {
    const now = at('2028-02-29T10:00:00.000Z');
    expect(isAcceptableWeddingDate('2030-03-01T10:00:00.000Z', now)).toBe(true);
    expect(isAcceptableWeddingDate('2030-03-02T10:00:00.000Z', now)).toBe(false);
  });
});

describe('buying a plan (N-169)', () => {
  it("opens an old wedding's album for the plan's days from the purchase", async () => {
    const host = await registerHost();
    await closedAlbum(host, 120);

    await applyTierUpgrade(host.userId, 'celebration_pass', {
      billingType: 'one_time',
      amountPaidCents: 4900,
      purchase: { eventId: host.eventId },
    });

    const album = await albumRow(host.eventId);
    expect(album.pass_tier).toBe('celebration_pass');
    expect(album.pass_started_at).not.toBeNull();
    expect(Math.abs(album.expires_at!.getTime() - (Date.now() + 90 * DAY))).toBeLessThan(60_000);
  });

  it('counts from the wedding when it is still ahead', async () => {
    const host = await registerHost();
    const { rows } = await query<{ event_date: Date }>(
      "UPDATE events SET event_date = NOW() + INTERVAL '30 days' WHERE id = $1 RETURNING event_date",
      [host.eventId]
    );

    await applyTierUpgrade(host.userId, 'celebration_pass', { billingType: 'one_time', purchase: {} });

    const album = await albumRow(host.eventId);
    expect(album.pass_tier).toBe('celebration_pass');
    expect(Math.abs(album.expires_at!.getTime() - (rows[0].event_date.getTime() + 90 * DAY))).toBeLessThan(60_000);
  });

  it('is not a purchase when a subscription ends and falls back to free', async () => {
    const host = await registerHost();
    const closedAt = await closedAlbum(host, 30);

    // A lowering write (what a cancellation does) carries no purchase.
    await applyTierUpgrade(host.userId, 'free', { allowLowerTier: true });

    const album = await albumRow(host.eventId);
    expect(album.pass_tier).toBeNull();
    expect(album.expires_at?.getTime()).toBe(closedAt.getTime());
  });

  // N-193 — the owner's rule (2026-10-20): a cheaper pass bought for an album
  // closed under a dearer one reopens it as the pass bought. It used to keep
  // the dearer pass and restart its window, so €49 bought a year of Deluxe.
  it('reopens a closed Deluxe album as the Celebration Pass bought for it (N-193)', async () => {
    const host = await registerHost();
    await applyTierUpgrade(host.userId, 'deluxe_keepsake', {
      billingType: 'one_time',
      amountPaidCents: 8900,
      purchase: { eventId: host.eventId },
    });
    await closedAlbum(host, 400);
    expect(await retireSpentPass(host.userId)).toBe(true);

    await applyTierUpgrade(host.userId, 'celebration_pass', {
      billingType: 'one_time',
      amountPaidCents: 4900,
      purchase: { eventId: host.eventId },
    });

    const album = await albumRow(host.eventId);
    expect(album.pass_tier).toBe('celebration_pass');
    expect(Math.abs(album.expires_at!.getTime() - (Date.now() + 90 * DAY))).toBeLessThan(60_000);
    expect(await getEffectiveTierForEvent(host.eventId)).toBe('celebration_pass');
  });

  it("keeps an open album's dearer pass, and when its days started (N-193)", async () => {
    const host = await registerHost();
    await applyTierUpgrade(host.userId, 'deluxe_keepsake', {
      billingType: 'one_time',
      amountPaidCents: 8900,
      purchase: { eventId: host.eventId },
    });
    const before = await albumRow(host.eventId);

    await applyTierUpgrade(host.userId, 'celebration_pass', {
      billingType: 'one_time',
      amountPaidCents: 4900,
      purchase: { eventId: host.eventId },
    });

    const after = await albumRow(host.eventId);
    expect(after.pass_tier).toBe('deluxe_keepsake');
    expect(after.pass_started_at?.getTime()).toBe(before.pass_started_at?.getTime());
    expect(after.expires_at?.getTime()).toBe(before.expires_at?.getTime());
  });
});
