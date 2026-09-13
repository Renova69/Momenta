import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { questsRouter } from '../../server/routes/quests';
import { audioRouter } from '../../server/routes/audio';
import { pool, query } from '../../server/lib/db';
import { FEATURE_GATES } from '../../src/config/tierGating';
import { TIER_GATED_EVENT_FIELDS } from '../../server/routes/events/shared';

const TEST_PORT = 6648;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

/**
 * Does the paywall actually hold?
 *
 * `tierGating.spec.ts` checks the configuration and the middleware against a
 * mocked pool; this drives every gated endpoint over real HTTP, against a real
 * database, at every tier — because the question a paywall has to answer is not
 * "does the middleware compute the right boolean" but "can a free-tier host
 * reach this feature by any route that exists".
 *
 * Two properties matter more than the individual gates:
 *
 *   The `subscriptions` table is the only source of truth. `events.plan_tier`
 *   is a denormalized column that the API itself returns to the client, and it
 *   is writable by the event-update path. If entitlement were read from it, a
 *   host could sell themselves a plan. Every gate below is re-checked with that
 *   column set to `pro_planner` on a free account.
 *
 *   Refusals must be asymmetric. A host whose plan lapsed keeps whatever they
 *   already created and must always be able to switch a paid setting *off* —
 *   otherwise a cancelled subscription leaves moderation permanently stuck on,
 *   with no way back for the person whose wedding it is.
 */

const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(512, 7)]);

interface Host {
  token: string;
  userId: string;
  eventId: string;
}

const createdEvents: string[] = [];

/**
 * Registrations are deliberately scarce here.
 *
 * `authLimiter` allows 25 registrations per IP per fifteen minutes, and every
 * request in this file comes from the same address. A host-per-test would run
 * past that budget and fail as a rate limit wearing the costume of a broken
 * paywall — the one failure this spec must never produce, because a refused
 * registration reads exactly like a gate that let someone through. So the gate
 * matrix drives one shared host whose tier is rewritten per case.
 */
async function registerHost(): Promise<Host> {
  const email = `tier-e2e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName: 'Tier E2E Host', password: 'Password123!' }),
  });
  if (res.status !== 201 && res.status !== 200) {
    throw new Error(`registration failed with ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

async function setTier(host: Host, tier: string): Promise<void> {
  await query("UPDATE subscriptions SET tier = $2 WHERE user_id = $1 AND status = 'active'", [
    host.userId,
    tier,
  ]);
}

/** Every server-enforced gate, as a request that only an entitled host may make. */
interface Gate {
  name: string;
  /** The lowest tier that may perform it. */
  required: 'celebration_pass' | 'deluxe_keepsake';
  call: (host: Host) => Promise<Response>;
}

function authed(host: Host, extra: Record<string, string> = {}): Record<string, string> {
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}`, ...extra };
}

const GATES: Gate[] = [
  {
    name: 'mint a ZIP export ticket',
    required: 'celebration_pass',
    call: (host) =>
      fetch(`${BASE_URL}/api/events/${host.eventId}/export-token`, {
        method: 'POST',
        headers: authed(host),
      }),
  },
  {
    name: 'download the ZIP export',
    required: 'celebration_pass',
    call: (host) =>
      fetch(`${BASE_URL}/api/events/${host.eventId}/export-zip`, { headers: authed(host) }),
  },
  {
    name: 'save a QR print-studio layout',
    required: 'celebration_pass',
    call: (host) =>
      fetch(`${BASE_URL}/api/events/${host.eventId}/qr-config`, {
        method: 'PUT',
        headers: authed(host),
        body: JSON.stringify({ canvasSize: 'A3', frameStyle: 'art_deco' }),
      }),
  },
  {
    name: 'create a scavenger quest',
    required: 'celebration_pass',
    call: (host) =>
      fetch(`${BASE_URL}/api/quests/events/${host.eventId}/quests`, {
        method: 'POST',
        headers: authed(host),
        body: JSON.stringify({ title: 'Find the cake', points: 10 }),
      }),
  },
  {
    name: 'switch photo moderation on',
    required: 'celebration_pass',
    call: (host) =>
      fetch(`${BASE_URL}/api/events/${host.eventId}`, {
        method: 'PUT',
        headers: authed(host),
        body: JSON.stringify({ isModerationEnabled: true }),
      }),
  },
  {
    name: 'choose a custom theme',
    required: 'celebration_pass',
    call: (host) =>
      fetch(`${BASE_URL}/api/events/${host.eventId}`, {
        method: 'PUT',
        headers: authed(host),
        body: JSON.stringify({ themePalette: 'blush_rose' }),
      }),
  },
  {
    name: 'switch disposable-camera mode on',
    required: 'deluxe_keepsake',
    call: (host) =>
      fetch(`${BASE_URL}/api/events/${host.eventId}`, {
        method: 'PUT',
        headers: authed(host),
        body: JSON.stringify({ isDisposableMode: true }),
      }),
  },
  {
    name: 'set a reveal time',
    required: 'deluxe_keepsake',
    call: (host) =>
      fetch(`${BASE_URL}/api/events/${host.eventId}`, {
        method: 'PUT',
        headers: authed(host),
        body: JSON.stringify({ revealAt: new Date(Date.now() + 86_400_000).toISOString() }),
      }),
  },
  {
    name: 'post to the audio guestbook',
    required: 'deluxe_keepsake',
    call: (host) => {
      const boundary = `----TierE2E${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
      const body = Buffer.concat([
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="m.webm"\r\n` +
            'Content-Type: audio/webm\r\n\r\n'
        ),
        WEBM,
        Buffer.from(
          `\r\n--${boundary}\r\nContent-Disposition: form-data; name="eventId"\r\n\r\n${host.eventId}\r\n--${boundary}--\r\n`
        ),
      ]);
      return fetch(`${BASE_URL}/api/audio`, {
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'x-device-fingerprint': `tier-e2e-${Math.random().toString(36).slice(2, 9)}`,
        },
        body: body as unknown as BodyInit,
      });
    },
  },
];

/** The tiers strictly below the one a gate requires. */
const BELOW: Record<Gate['required'], string[]> = {
  celebration_pass: ['free'],
  deluxe_keepsake: ['free', 'celebration_pass'],
};

/** The tiers at or above it. */
const ATOROVE: Record<Gate['required'], string[]> = {
  celebration_pass: ['celebration_pass', 'deluxe_keepsake', 'pro_planner'],
  deluxe_keepsake: ['deluxe_keepsake', 'pro_planner'],
};

/** Reused across the gate matrix; its tier is rewritten per case. */
let shared: Host;

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/quests', questsRouter);
  app.use('/api/audio', audioRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

  shared = await registerHost();
}, 30_000);

afterAll(async () => {
  if (server) server.close();
  await query('DELETE FROM events WHERE id = ANY($1::uuid[])', [createdEvents]).catch(
    () => undefined
  );
});

describe.each(GATES)('$name', (gate) => {
  it.each(BELOW[gate.required])('is refused on %s', async (tier) => {
    await setTier(shared, tier);

    const res = await gate.call(shared);

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('TIER_REQUIRED');
  }, 30_000);

  it.each(ATOROVE[gate.required])('is allowed on %s', async (tier) => {
    await setTier(shared, tier);

    const res = await gate.call(shared);

    // Anything but a tier refusal: the point is that the gate let it through,
    // not that every downstream validation also passed.
    expect(res.status).not.toBe(403);
  }, 30_000);
});

describe('the source of truth', () => {
  it.each(GATES.map((g) => [g.name, g] as const))(
    'ignores a forged events.plan_tier for %s',
    async (_name, gate) => {
      // events.plan_tier is denormalized, returned to the client, and written
      // by the event-update path. If entitlement were read from it, a host
      // could sell themselves a plan. Only `subscriptions` decides.
      await setTier(shared, 'free');
      await pool.query("UPDATE events SET plan_tier = 'pro_planner' WHERE id = $1", [shared.eventId]);

      const res = await gate.call(shared);

      expect(res.status).toBe(403);
    },
    30_000
  );

  it('drops to free when the subscription is no longer active', async () => {
    // A cancelled or expired row must stop entitling anything. The query joins
    // on status = 'active' precisely so this cannot be forgotten.
    await setTier(shared, 'pro_planner');
    await query("UPDATE subscriptions SET status = 'canceled' WHERE user_id = $1", [shared.userId]);

    const res = await fetch(`${BASE_URL}/api/events/${shared.eventId}/export-token`, {
      method: 'POST',
      headers: authed(shared),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).currentTier).toBe('free');

    // Shared row: put it back, or every later case runs against a host with no
    // active subscription and passes for the wrong reason.
    await query("UPDATE subscriptions SET status = 'active' WHERE user_id = $1", [shared.userId]);
  }, 30_000);

  it('reports the tier from the subscription, not from the event column', async () => {
    await setTier(shared, 'celebration_pass');
    await pool.query("UPDATE events SET plan_tier = 'free' WHERE id = $1", [shared.eventId]);

    const res = await fetch(`${BASE_URL}/api/events/${shared.eventId}/export-token`, {
      method: 'POST',
      headers: authed(shared),
    });

    expect(res.status).toBe(200);
  }, 30_000);
});

describe('refusals are asymmetric', () => {
  it('lets a lapsed host switch moderation back off', async () => {
    // Otherwise a cancelled subscription leaves moderation stuck on forever,
    // and the person whose wedding it is cannot undo a setting they are no
    // longer paying for.
    await setTier(shared, 'celebration_pass');
    const on = await fetch(`${BASE_URL}/api/events/${shared.eventId}`, {
      method: 'PUT',
      headers: authed(shared),
      body: JSON.stringify({ isModerationEnabled: true }),
    });
    expect(on.status).toBe(200);

    await setTier(shared, 'free');
    const off = await fetch(`${BASE_URL}/api/events/${shared.eventId}`, {
      method: 'PUT',
      headers: authed(shared),
      body: JSON.stringify({ isModerationEnabled: false }),
    });

    expect(off.status).toBe(200);
  }, 40_000);

  it('lets a lapsed host clear a reveal time', async () => {
    await setTier(shared, 'deluxe_keepsake');
    await fetch(`${BASE_URL}/api/events/${shared.eventId}`, {
      method: 'PUT',
      headers: authed(shared),
      body: JSON.stringify({ revealAt: new Date(Date.now() + 86_400_000).toISOString() }),
    });

    await setTier(shared, 'free');
    const cleared = await fetch(`${BASE_URL}/api/events/${shared.eventId}`, {
      method: 'PUT',
      headers: authed(shared),
      body: JSON.stringify({ revealAt: null }),
    });

    expect(cleared.status).toBe(200);
  }, 40_000);

  it('never gates publishing or withdrawing an album', async () => {
    // A privacy control, not a paid feature. A free host must be able to take
    // their own wedding off the public showcase.
    await setTier(shared, 'free');

    const published = await fetch(`${BASE_URL}/api/events/${shared.eventId}`, {
      method: 'PUT',
      headers: authed(shared),
      body: JSON.stringify({ isPublic: true }),
    });
    const withdrawn = await fetch(`${BASE_URL}/api/events/${shared.eventId}`, {
      method: 'PUT',
      headers: authed(shared),
      body: JSON.stringify({ isPublic: false }),
    });

    expect(published.status).toBe(200);
    expect(withdrawn.status).toBe(200);
  }, 40_000);
});

describe('how many weddings a plan carries', () => {
  it('holds a single-event host to one', async () => {
    await setTier(shared, 'deluxe_keepsake');
    await query('UPDATE subscriptions SET event_limit = 1 WHERE user_id = $1', [shared.userId]);

    const res = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: authed(shared),
      body: JSON.stringify({ hostName: 'Second Wedding' }),
    });

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe('EVENT_LIMIT_REACHED');
  }, 30_000);

  it('lets a planner run several at once', async () => {
    // pro_planner is the only tier whose allowance is pooled across weddings,
    // and event_limit is written by the upgrade path rather than read from
    // PLAN_LIMITS — so this is checking that those two agree.
    await setTier(shared, 'pro_planner');
    await query("UPDATE subscriptions SET event_limit = 10 WHERE user_id = $1", [shared.userId]);

    const res = await fetch(`${BASE_URL}/api/events`, {
      method: 'POST',
      headers: authed(shared),
      body: JSON.stringify({ hostName: 'Second Wedding' }),
    });

    expect(res.status).toBe(201);
    createdEvents.push((await res.json()).id);
  }, 30_000);
});

describe('the client and the server agree', () => {
  it('gates every event setting the client hides at the same tier', () => {
    // The client decides what to show behind a paywall; the server decides
    // what to allow. A disagreement either sells a feature that is then
    // refused, or hides one the customer has paid for.
    expect(TIER_GATED_EVENT_FIELDS.isModerationEnabled).toBe(
      FEATURE_GATES.photo_moderation.minimumTier
    );
    expect(TIER_GATED_EVENT_FIELDS.isDisposableMode).toBe(
      FEATURE_GATES.disposable_camera.minimumTier
    );
  });

  it('gates the export, the QR studio, the quests and the guestbook at the tier the client advertises', () => {
    // These live in route middleware rather than a table, so they are asserted
    // against the same constants the pricing page renders from.
    const advertised = {
      'mint a ZIP export ticket': FEATURE_GATES.zip_export.minimumTier,
      'download the ZIP export': FEATURE_GATES.zip_export.minimumTier,
      'save a QR print-studio layout': FEATURE_GATES.qr_print_studio.minimumTier,
      'create a scavenger quest': FEATURE_GATES.scavenger_quests.minimumTier,
      'post to the audio guestbook': FEATURE_GATES.audio_guestbook.minimumTier,
    } as Record<string, string>;

    for (const gate of GATES) {
      if (gate.name in advertised) {
        expect(`${gate.name}: ${gate.required}`).toBe(`${gate.name}: ${advertised[gate.name]}`);
      }
    }
  });
});
