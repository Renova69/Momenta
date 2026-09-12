import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { query } from '../../server/lib/db';

/**
 * SEC-D7 — events.host_user_id was ON DELETE SET NULL, so deleting a host
 * account orphaned their events (still live, still public) instead of
 * cleaning them up. No account-deletion feature exists in the app yet, but
 * the FK policy itself needed fixing before one gets built on top of it.
 * Migration 011 switches it to ON DELETE CASCADE.
 */

const TEST_PORT = 6609;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

async function registerHost(): Promise<{ userId: string; eventId: string }> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `cascade-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Cascade Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  return { userId: data.user.id, eventId: data.event.id };
}

describe('Host account deletion cascades to their events (SEC-D7)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '10mb' }));
    app.use('/api/auth', authRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));
  });

  afterAll(() => {
    if (server) server.close();
  });

  it('deletes the event (and everything under it) instead of orphaning it', async () => {
    const { userId, eventId } = await registerHost();

    const before = await query('SELECT id FROM events WHERE id = $1', [eventId]);
    expect(before.rows.length).toBe(1);

    await query('DELETE FROM users WHERE id = $1', [userId]);

    const after = await query('SELECT id, host_user_id FROM events WHERE id = $1', [eventId]);
    expect(after.rows.length).toBe(0);
  });
});
