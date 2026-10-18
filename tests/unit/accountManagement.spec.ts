import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';
import fs from 'fs';
import path from 'path';

/**
 * N-122 — a host could not change their password or delete their account.
 * `authRouter` had only register, login, me and logout: a host whose password
 * leaked could not replace it, and nobody could exercise the right to erasure
 * short of writing to the operator.
 *
 * Changing the password asks for the current one, keeps this session and ends
 * every other. Deleting the account asks for the password, cancels a live plan
 * at Stripe first (and deletes nothing if Stripe cannot be reached, rather than
 * leave a customer billed for an account that no longer exists), then erases
 * every album the way deleting one album does: files first, then rows.
 */

// The Stripe SDK itself is faked, and a key pinned, so every real code path
// runs and nothing can reach Stripe whatever .env holds (as in
// stripeLivenessFailure.spec.ts).
const stripe = vi.hoisted(() => ({
  retrieve: vi.fn(),
  cancel: vi.fn(),
  listSessions: vi.fn(async () => ({ data: [] as { id: string }[] })),
  expireSession: vi.fn(async (id: string) => ({ id, status: 'expired' })),
}));

vi.mock('stripe', () => ({
  default: class {
    subscriptions = { retrieve: stripe.retrieve, cancel: stripe.cancel };
    checkout = { sessions: { list: stripe.listSessions, expire: stripe.expireSession } };
  },
}));

vi.mock('../../server/lib/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../server/lib/config')>();
  return { ...actual, CONFIG: { ...actual.CONFIG, STRIPE_SECRET_KEY: 'sk_test_account_spec' } };
});

import { authRouter } from '../../server/routes/auth';
import { photosRouter } from '../../server/routes/photos';
import { CONFIG } from '../../server/lib/config';
import { query } from '../../server/lib/db';
import { resetPasswordByEmail } from '../../server/lib/passwordReset';
import { deleteEventFixtures } from '../helpers/cleanup';

const TEST_PORT = 6681;
const BASE_URL = `http://localhost:${TEST_PORT}`;
const PASSWORD = 'Password123!';
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];

interface Host {
  token: string;
  userId: string;
  eventId: string;
  email: string;
}

async function registerHost(): Promise<Host> {
  const email = `account-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName: 'Account Spec Host', password: PASSWORD }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id, email };
}

const send = (method: string, url: string, token: string | null, body?: unknown) =>
  fetch(`${BASE_URL}${url}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const login = (email: string, password: string) => send('POST', '/api/auth/login', null, { email, password });

/** The account's plan, as a Stripe checkout leaves it (registration made the row). */
const givePlan = (userId: string, subscriptionId: string) =>
  query(
    "UPDATE subscriptions SET tier = 'celebration_pass', billing_type = 'monthly', stripe_subscription_id = $2 WHERE user_id = $1",
    [userId, subscriptionId]
  );

async function photoFile(eventId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Account Spec Guest',
      deviceFingerprint: `account-fp-${Math.random().toString(36).slice(2, 10)}`,
      fullUrl: jpegDataUrl,
    }),
  });
  if (res.status !== 201) throw new Error(`photo upload failed: ${res.status}`);
  const { rows } = await query<{ storage_path: string }>('SELECT storage_path FROM photos WHERE event_id = $1 LIMIT 1', [eventId]);
  return path.join(CONFIG.UPLOADS_DIR, rows[0].storage_path.replace(/^\/uploads\//, ''));
}

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '20mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/photos', photosRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  const jpeg = await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 90, g: 140, b: 200 } } })
    .jpeg()
    .toBuffer();
  jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
});

afterAll(async () => {
  await deleteEventFixtures(createdEvents);
  if (server) server.close();
});

beforeEach(() => {
  stripe.retrieve.mockReset();
  stripe.retrieve.mockResolvedValue({ status: 'active' });
  stripe.cancel.mockReset();
  stripe.cancel.mockResolvedValue({ status: 'canceled' });
});

describe('changing the password (N-122)', () => {
  it('asks for the current password', async () => {
    const host = await registerHost();

    const res = await send('POST', '/api/auth/password', host.token, { currentPassword: 'wrong-one', newPassword: 'NewPassword456!' });

    expect(res.status).toBe(401);
    expect((await res.json()).code).toBe('INVALID_CREDENTIALS');
    expect((await login(host.email, PASSWORD)).status).toBe(200);
  });

  it('holds the new password to the rules registration does', async () => {
    const host = await registerHost();

    const res = await send('POST', '/api/auth/password', host.token, { currentPassword: PASSWORD, newPassword: 'abc' });

    expect(res.status).toBe(400);
  });

  it('replaces the password, keeps this session and ends every other', async () => {
    const host = await registerHost();
    const otherDevice = (await (await login(host.email, PASSWORD)).json()).token as string;

    const res = await send('POST', '/api/auth/password', host.token, { currentPassword: PASSWORD, newPassword: 'NewPassword456!' });

    expect(res.status).toBe(200);
    const { token } = await res.json();
    expect((await send('GET', '/api/auth/me', token)).status).toBe(200);
    expect((await send('GET', '/api/auth/me', otherDevice)).status).toBe(401);
    expect((await login(host.email, PASSWORD)).status).toBe(401);
    expect((await login(host.email, 'NewPassword456!')).status).toBe(200);
  });
});

describe('deleting the account (N-122)', () => {
  it('asks for the password, and deletes nothing without it', async () => {
    const host = await registerHost();

    const res = await send('DELETE', '/api/auth/account', host.token, { password: 'wrong-one' });

    expect(res.status).toBe(401);
    expect((await query('SELECT 1 FROM users WHERE id = $1', [host.userId])).rows).toHaveLength(1);
  });

  it('erases the account, its albums and their files', async () => {
    const host = await registerHost();
    const file = await photoFile(host.eventId);
    expect(fs.existsSync(file)).toBe(true);

    const res = await send('DELETE', '/api/auth/account', host.token, { password: PASSWORD });

    expect(res.status).toBe(200);
    expect((await query('SELECT 1 FROM users WHERE id = $1', [host.userId])).rows).toHaveLength(0);
    expect((await query('SELECT 1 FROM events WHERE id = $1', [host.eventId])).rows).toHaveLength(0);
    expect(fs.existsSync(file)).toBe(false);
    expect((await login(host.email, PASSWORD)).status).toBe(401);
  });

  // N-173 — a checkout still open could be paid after the account was gone.
  it('closes a checkout still open for the account, so it cannot be paid afterwards', async () => {
    const host = await registerHost();
    await query("UPDATE subscriptions SET stripe_customer_id = 'cus_account_spec' WHERE user_id = $1", [host.userId]);
    stripe.listSessions.mockResolvedValueOnce({ data: [{ id: 'cs_open_one' }] });

    const res = await send('DELETE', '/api/auth/account', host.token, { password: PASSWORD });

    expect(res.status).toBe(200);
    expect(stripe.listSessions).toHaveBeenCalledWith(expect.objectContaining({ customer: 'cus_account_spec', status: 'open' }));
    expect(stripe.expireSession).toHaveBeenCalledWith('cs_open_one');
  });

  it('keeps a record that an album was deleted, naming nobody', async () => {
    const host = await registerHost();

    await send('DELETE', '/api/auth/account', host.token, { password: PASSWORD });

    const { rows } = await query<{ host_user_id: string | null }>('SELECT host_user_id FROM event_deletions WHERE event_id = $1', [host.eventId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].host_user_id).toBeNull();
  });

  it('leaves everyone else alone', async () => {
    const host = await registerHost();
    const other = await registerHost();

    await send('DELETE', '/api/auth/account', host.token, { password: PASSWORD });

    expect((await query('SELECT 1 FROM events WHERE id = $1', [other.eventId])).rows).toHaveLength(1);
    expect((await send('GET', '/api/auth/me', other.token)).status).toBe(200);
  });

  it('cancels a live plan at Stripe before erasing anything', async () => {
    const host = await registerHost();
    await givePlan(host.userId, 'sub_account_spec');

    const res = await send('DELETE', '/api/auth/account', host.token, { password: PASSWORD });

    expect(res.status).toBe(200);
    expect(stripe.cancel).toHaveBeenCalledWith('sub_account_spec');
  });

  it('deletes nothing while Stripe cannot be reached to cancel a plan', async () => {
    const host = await registerHost();
    await givePlan(host.userId, 'sub_unreachable');
    stripe.retrieve.mockRejectedValue(Object.assign(new Error('Connection error'), { statusCode: 503 }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await send('DELETE', '/api/auth/account', host.token, { password: PASSWORD });

    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('BILLING_UNVERIFIABLE');
    expect((await query('SELECT 1 FROM users WHERE id = $1', [host.userId])).rows).toHaveLength(1);
    expect((await query('SELECT 1 FROM events WHERE id = $1', [host.eventId])).rows).toHaveLength(1);
  });

  it('deletes nothing when Stripe refuses to cancel', async () => {
    const host = await registerHost();
    await givePlan(host.userId, 'sub_refused');
    stripe.cancel.mockRejectedValue(Object.assign(new Error('Internal error'), { statusCode: 500 }));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const res = await send('DELETE', '/api/auth/account', host.token, { password: PASSWORD });

    expect(res.status).toBe(503);
    expect((await query('SELECT 1 FROM users WHERE id = $1', [host.userId])).rows).toHaveLength(1);
  });

  it('goes ahead when Stripe no longer has the plan', async () => {
    const host = await registerHost();
    await givePlan(host.userId, 'sub_gone');
    stripe.retrieve.mockRejectedValue(Object.assign(new Error('No such subscription'), { code: 'resource_missing', statusCode: 404 }));
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const res = await send('DELETE', '/api/auth/account', host.token, { password: PASSWORD });

    expect(res.status).toBe(200);
    expect(stripe.cancel).not.toHaveBeenCalled();
  });
});

describe('the operator reset, until email can carry one (N-122)', () => {
  it('sets a temporary password and ends every session', async () => {
    const host = await registerHost();

    const temporary = await resetPasswordByEmail(host.email.toUpperCase());

    expect(temporary).toMatch(/^[A-Za-z0-9_-]{12,}$/);
    expect((await login(host.email, temporary!)).status).toBe(200);
    expect((await login(host.email, PASSWORD)).status).toBe(401);
    expect((await send('GET', '/api/auth/me', host.token)).status).toBe(401);
  });

  it('answers null for an address with no account', async () => {
    expect(await resetPasswordByEmail('nobody-here@test.com')).toBeNull();
  });
});
