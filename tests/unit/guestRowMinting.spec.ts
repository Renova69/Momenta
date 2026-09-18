import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import sharp from 'sharp';

import { authRouter } from '../../server/routes/auth';
import { eventsRouter } from '../../server/routes/events';
import { photosRouter } from '../../server/routes/photos';
import { questsRouter } from '../../server/routes/quests';
import { guestsRouter } from '../../server/routes/guests';
import { query } from '../../server/lib/db';
import { deleteEventFixtures } from '../helpers/cleanup';

/**
 * H8 — unauthenticated, unthrottled guest-row minting.
 *
 * POST /api/photos/:id/comments and POST /api/quests/:id/complete both
 * accepted a request carrying no credential at all and INSERTed a fresh
 * `guests` row on every single call. Comments had no rate limiter beyond the
 * global apiLimiter (3000/min/IP), and `guests` has no quota of any kind.
 *
 * Anyone with a public event slug could therefore create unbounded guest rows:
 * the host's guest list fills with ghosts, the showcase guest count inflates,
 * and the table grows without bound. Minting on *every* unproven request is
 * the defect — not anonymous participation itself, which stays supported.
 *
 * Resolution is now the same ladder the photo-upload path already uses:
 * a verified token identifies the guest; failing that a device fingerprint
 * attributes the action to the row that device already owns; failing that one
 * row is created for that device. A caller offering neither is asked to
 * identify itself rather than handed a brand-new identity.
 *
 * The SEC-03 rule carries over too: a fingerprint is client-generated and not
 * secret, so matching one is enough to attribute an action but never enough to
 * be issued a durable credential for that identity.
 */

const TEST_PORT = 6634;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;
let jpegDataUrl = '';
const createdEvents: string[] = [];

interface Host {
  token: string;
  eventId: string;
}

async function registerHost(): Promise<Host> {
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: `minting-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`,
      fullName: 'Guest Minting Spec Host',
      password: 'Password123!',
    }),
  });
  const data = await res.json();
  createdEvents.push(data.event.id);
  return { token: data.token, eventId: data.event.id };
}

async function uploadPhoto(eventId: string): Promise<string> {
  const res = await fetch(`${BASE_URL}/api/photos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      eventId,
      guestName: 'Minting Spec Guest',
      deviceFingerprint: `mint-owner-${Math.random().toString(36).slice(2, 8)}`,
      fullUrl: jpegDataUrl,
    }),
  });
  return (await res.json()).id as string;
}

async function guestCount(eventId: string): Promise<number> {
  const res = await query<{ count: string }>('SELECT COUNT(*)::int AS count FROM guests WHERE event_id = $1', [
    eventId,
  ]);
  return Number(res.rows[0].count);
}

function postComment(photoId: string, body: Record<string, unknown>) {
  return fetch(`${BASE_URL}/api/photos/${photoId}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commentText: 'Lovely shot!', ...body }),
  });
}

function completeQuest(questId: string, body: Record<string, unknown>) {
  return fetch(`${BASE_URL}/api/quests/${questId}/complete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function firstQuestId(eventId: string): Promise<string> {
  const res = await query<{ id: string }>('SELECT id FROM scavenger_quests WHERE event_id = $1 LIMIT 1', [eventId]);
  return res.rows[0].id;
}

describe('guest rows are not minted per request (H8)', () => {
  beforeAll(async () => {
    const app = express();
    server = createServer(app);
    app.use(express.json({ limit: '20mb' }));
    app.use('/api/auth', authRouter);
    app.use('/api/events', eventsRouter);
    app.use('/api/photos', photosRouter);
    app.use('/api/guests', guestsRouter);
    app.use('/api', questsRouter);
    await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

    const jpeg = await sharp({
      create: { width: 200, height: 150, channels: 3, background: { r: 200, g: 170, b: 120 } },
    })
      .jpeg()
      .toBuffer();
    jpegDataUrl = `data:image/jpeg;base64,${jpeg.toString('base64')}`;
  });

  afterAll(async () => {
    await deleteEventFixtures(createdEvents);
    if (server) server.close();
  });

  describe('POST /api/photos/:id/comments', () => {
    it('refuses a caller offering neither a token nor a fingerprint', async () => {
      const host = await registerHost();
      const photoId = await uploadPhoto(host.eventId);
      const before = await guestCount(host.eventId);

      const res = await postComment(photoId, { guestId: 'not-a-uuid', guestName: 'Ghost' });

      expect(res.status).toBe(401);
      expect(await guestCount(host.eventId)).toBe(before);
    });

    it('creates at most one row for a device, however many comments it posts', async () => {
      const host = await registerHost();
      const photoId = await uploadPhoto(host.eventId);
      const before = await guestCount(host.eventId);
      const fingerprint = `mint-fp-${Math.random().toString(36).slice(2, 8)}`;

      for (let i = 0; i < 5; i++) {
        const res = await postComment(photoId, {
          guestId: 'unknown',
          guestName: 'Repeat',
          deviceFingerprint: fingerprint,
        });
        expect(res.status).toBe(201);
      }

      expect(await guestCount(host.eventId)).toBe(before + 1);
    });

    it('issues a token for a genuinely new device, but not for a fingerprint-only match (SEC-03)', async () => {
      const host = await registerHost();
      const photoId = await uploadPhoto(host.eventId);
      const fingerprint = `mint-fp-${Math.random().toString(36).slice(2, 8)}`;

      const first = await postComment(photoId, {
        guestId: 'unknown',
        guestName: 'Newcomer',
        deviceFingerprint: fingerprint,
      });
      const firstBody = await first.json();
      expect(first.status).toBe(201);
      expect(typeof firstBody.guestToken).toBe('string');

      const second = await postComment(photoId, {
        guestId: 'unknown',
        guestName: 'Newcomer',
        deviceFingerprint: fingerprint,
      });
      const secondBody = await second.json();
      expect(second.status).toBe(201);
      expect(secondBody.guestId).toBe(firstBody.guestId);
      expect(secondBody.guestToken).toBeUndefined();
    });

    it('attributes the comment to the token holder without creating a row', async () => {
      const host = await registerHost();
      const photoId = await uploadPhoto(host.eventId);
      const fingerprint = `mint-fp-${Math.random().toString(36).slice(2, 8)}`;

      const seed = await postComment(photoId, {
        guestId: 'unknown',
        guestName: 'Tokened',
        deviceFingerprint: fingerprint,
      });
      const { guestId, guestToken } = await seed.json();

      const before = await guestCount(host.eventId);
      const res = await postComment(photoId, { guestId, guestToken });
      const body = await res.json();

      expect(res.status).toBe(201);
      expect(body.guestId).toBe(guestId);
      expect(await guestCount(host.eventId)).toBe(before);
    });

    it('is rate limited per device, not merely by the global API ceiling', async () => {
      const host = await registerHost();
      const photoId = await uploadPhoto(host.eventId);
      const fingerprint = `mint-flood-${Math.random().toString(36).slice(2, 8)}`;

      // Fired together rather than in a sequential loop. The limiter allows 20
      // per minute per device, so 25 requests must produce at least one 429
      // whatever order they arrive in — the assertion stays deterministic
      // while the test stops depending on 40 round trips finishing inside the
      // timeout, which stopped being reliable as the suite grew and more spec
      // files competed for the machine.
      const responses = await Promise.all(
        Array.from({ length: 25 }, () => postComment(photoId, { guestId: 'unknown', deviceFingerprint: fingerprint }))
      );

      expect(responses.some((res) => res.status === 429)).toBe(true);
      // An explicit budget rather than the 5s default. What this test asserts
      // is deterministic — 25 requests against a 20-per-minute limiter must
      // produce a 429 — but it needs a register, an upload and 25 round trips
      // to get there, and it is racing every other spec file for the machine.
      // Parallelising the requests bought it some room once already; the
      // suite has since grown past that too. Widening the clock does not
      // weaken the assertion, and leaves a failure here meaning the limiter
      // is broken rather than that the runner was busy.
    }, 20_000);
  });

  /**
   * The defaults a quest is created with.
   *
   * `description?.trim() || null, iconName || 'camera', points || 10` — three
   * fallbacks on one line, none of them asserted. Turning any `||` into `&&`
   * nulls the value and the response still looks right, because the route
   * returns the row it just wrote. A host creates a quest and it silently has
   * no icon, or is worth nothing.
   */
  describe('POST /api/quests/events/:id/quests defaults', () => {
    /** The quests router is mounted at `/api` in this file, not `/api/quests`. */
    async function createQuest(host: Host, body: Record<string, unknown>) {
      const res = await fetch(`${BASE_URL}/api/events/${host.eventId}/quests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${host.token}` },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }

    async function paidHost(): Promise<Host> {
      const host = await registerHost();
      createdEvents.push(host.eventId);
      // Scavenger quests are gated at celebration_pass.
      await query(
        "UPDATE subscriptions SET tier = 'celebration_pass' WHERE user_id = (SELECT host_user_id FROM events WHERE id = $1)",
        [host.eventId]
      );
      return host;
    }

    it('fills in an icon and a point value when the host gives none', async () => {
      const host = await paidHost();

      const { status, body } = await createQuest(host, { title: 'Find the cake' });

      expect(status).toBe(201);
      expect(body.iconName).toBe('camera');
      expect(body.points).toBe(10);
      expect(body.description).toBeNull();
    }, 20_000);

    it('keeps what the host did give', async () => {
      // The other half: a defaulting expression that ignored its input would
      // satisfy the test above.
      const host = await paidHost();

      const { body } = await createQuest(host, {
        title: 'Toast the couple',
        description: '  raise a glass  ',
        iconName: 'wine',
        points: 25,
      });

      expect(body.iconName).toBe('wine');
      expect(body.points).toBe(25);
      expect(body.description).toBe('raise a glass');
    }, 20_000);
  });

  describe('POST /api/quests/:id/complete', () => {
    it('refuses a caller offering neither a token nor a fingerprint', async () => {
      const host = await registerHost();
      const questId = await firstQuestId(host.eventId);
      const before = await guestCount(host.eventId);

      const res = await completeQuest(questId, { guestId: 'not-a-uuid' });

      expect(res.status).toBe(401);
      expect(await guestCount(host.eventId)).toBe(before);
    });

    it('stores no photo reference when the one supplied is not a uuid', async () => {
      // `photoId && isValidUuid(photoId) ? photoId : null`. With `||` the
      // malformed value is kept and handed to a uuid column, which raises
      // 22P02 and surfaces as a 500 — on a route a guest hits by tapping a
      // quest tile.
      const host = await registerHost();
      const questId = await firstQuestId(host.eventId);

      const res = await completeQuest(questId, {
        guestId: 'unknown',
        deviceFingerprint: `badphoto-${Math.random().toString(36).slice(2, 8)}`,
        photoId: 'not-a-uuid',
      });

      expect(res.status).toBe(200);
      const { rows } = await query<{ photo_id: string | null }>(
        'SELECT photo_id FROM guest_quest_completions WHERE quest_id = $1 ORDER BY completed_at DESC LIMIT 1',
        [questId]
      );
      expect(rows[0].photo_id).toBeNull();
    }, 20_000);

    it('creates at most one row for a device across repeated completions', async () => {
      const host = await registerHost();
      const questId = await firstQuestId(host.eventId);
      const before = await guestCount(host.eventId);
      const fingerprint = `mint-q-${Math.random().toString(36).slice(2, 8)}`;

      for (let i = 0; i < 4; i++) {
        const res = await completeQuest(questId, { guestId: 'unknown', deviceFingerprint: fingerprint });
        expect(res.status).toBe(200);
      }

      expect(await guestCount(host.eventId)).toBe(before + 1);
    });

    it('does not hand a credential to a fingerprint-only match (SEC-03)', async () => {
      const host = await registerHost();
      const questId = await firstQuestId(host.eventId);
      const fingerprint = `mint-q-${Math.random().toString(36).slice(2, 8)}`;

      const first = await (await completeQuest(questId, { guestId: 'unknown', deviceFingerprint: fingerprint })).json();
      expect(typeof first.guestToken).toBe('string');

      const second = await (
        await completeQuest(questId, { guestId: 'unknown', deviceFingerprint: fingerprint })
      ).json();
      expect(second.guestId).toBe(first.guestId);
      expect(second.guestToken).toBeUndefined();
    });
  });

  it('still rejects a reserved device fingerprint on these paths', async () => {
    const host = await registerHost();
    const photoId = await uploadPhoto(host.eventId);

    const res = await postComment(photoId, { guestId: 'unknown', deviceFingerprint: 'photographer' });

    expect(res.status).toBe(400);
  });

  /**
   * The token version a resolved identity carries.
   *
   * `resolveGuestIdentity` returns `tokenVersion`, and its only consumer is
   * `issueGuestToken(guestId, eventId, tokenVersion)` on the comment, quest and
   * upload paths. Both places that produce it read
   * `Number(row.token_version) || 0`, and mutation testing found that forcing
   * either to 0 changed nothing any test could see.
   *
   * Forcing it to 0 is not a cosmetic bug. A host who uses "reset guest sessions"
   * bumps every row's `token_version` to 1 (M10); a guest who then comments would
   * be issued a token minted at 0, which `verifyGuestToken` rejects against the
   * row's 1 — for ever, on every subsequent request. A feature meant to log other
   * people out would permanently lock the remaining guests out instead, and the
   * suite would not have said a word.
   */

  describe('resolveGuestIdentity carries the row’s token version', () => {
    let tvHost: Host;

    beforeAll(async () => {
      tvHost = await registerHost();
      createdEvents.push(tvHost.eventId);
    }, 30_000);

    async function seedGuest(version: number): Promise<{ guestId: string; fingerprint: string }> {
      const fingerprint = `tv-fp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const { rows } = await query<{ id: string }>(
        `INSERT INTO guests (event_id, name, device_fingerprint, token_version)
         VALUES ($1, 'Token Version Guest', $2, $3) RETURNING id`,
        [tvHost.eventId, fingerprint, version]
      );
      return { guestId: rows[0].id, fingerprint };
    }

    it('returns the stored version when a token proves the identity', async () => {
      const { resolveGuestIdentity } = await import('../../server/lib/guestIdentity');
      const { issueGuestToken } = await import('../../server/lib/guestAuth');
      const { guestId } = await seedGuest(2);

      const identity = await resolveGuestIdentity({
        eventId: tvHost.eventId,
        guestId,
        guestToken: issueGuestToken(guestId, tvHost.eventId, 2),
      });

      expect(identity).not.toBeNull();
      expect(identity!.identityProven).toBe(true);
      expect(identity!.tokenVersion).toBe(2);
    }, 30_000);

    it('returns the stored version when the device fingerprint matches', async () => {
      // The other producer of the same value, written out separately in the
      // source, so it needs asserting separately too.
      const { resolveGuestIdentity } = await import('../../server/lib/guestIdentity');
      const { guestId, fingerprint } = await seedGuest(3);

      const identity = await resolveGuestIdentity({
        eventId: tvHost.eventId,
        deviceFingerprint: fingerprint,
      });

      expect(identity).not.toBeNull();
      expect(identity!.guestId).toBe(guestId);
      expect(identity!.tokenVersion).toBe(3);
    }, 30_000);

    it('mints a token the verifier then accepts, after a session reset', async () => {
      // The end-to-end consequence, and the one that matters: a guest recognised
      // after a reset must receive a token that still works.
      const { resolveGuestIdentity } = await import('../../server/lib/guestIdentity');
      const { issueGuestToken, verifyGuestToken } = await import('../../server/lib/guestAuth');
      const { guestId, fingerprint } = await seedGuest(0);

      await query('UPDATE guests SET token_version = token_version + 1 WHERE id = $1', [guestId]);

      const identity = await resolveGuestIdentity({
        eventId: tvHost.eventId,
        deviceFingerprint: fingerprint,
      });
      const minted = issueGuestToken(guestId, tvHost.eventId, identity!.tokenVersion);

      expect(verifyGuestToken(minted, guestId, tvHost.eventId, 1)).toBe(true);
    }, 30_000);

    it('treats a brand-new guest as version zero', async () => {
      // The default, and the reason `|| 0` is there at all: a fresh row has no
      // history to carry.
      const { resolveGuestIdentity } = await import('../../server/lib/guestIdentity');

      const identity = await resolveGuestIdentity({
        eventId: tvHost.eventId,
        deviceFingerprint: `tv-new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        fallbackName: 'Fresh Guest',
      });

      expect(identity!.tokenVersion).toBe(0);
      expect(identity!.identityProven).toBe(true);
    }, 30_000);
  });

  /**
   * What POST /api/guests actually stores.
   *
   * The join form sends a name, an optional table number and an optional
   * avatar. Both optionals are written with `x || fallback`, and mutation
   * testing found neither asserted: turning either `||` into `&&` makes the
   * value null on every join, and the response still looks right because the
   * route returns the row it just wrote. A guest joins, the seating chart
   * loses their table, and their avatar quietly becomes the default — visible
   * to everyone on every photo they take.
   */
  describe('POST /api/guests stores what the guest supplied', () => {
    let joinHost: Host;

    beforeAll(async () => {
      joinHost = await registerHost();
      createdEvents.push(joinHost.eventId);
    }, 30_000);

    async function join(body: Record<string, unknown>) {
      const res = await fetch(`${BASE_URL}/api/guests`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ eventId: joinHost.eventId, ...body }),
      });
      return { status: res.status, body: await res.json().catch(() => ({})) };
    }

    it('keeps the table number, trimmed', async () => {
      const { status, body } = await join({
        name: 'Ana',
        tableNumber: '  12  ',
        deviceFingerprint: `table-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      });

      expect(status).toBe(201);
      expect(body.tableNumber).toBe('12');

      // Asserted against the row, not only the response: the route returns
      // what it wrote, so a response-shape check cannot tell you it persisted.
      const { rows } = await query<{ table_number: string | null }>('SELECT table_number FROM guests WHERE id = $1', [
        body.id,
      ]);
      expect(rows[0].table_number).toBe('12');
    }, 20_000);

    it('leaves the table number null when none was given', async () => {
      const { body } = await join({
        name: 'Boris',
        deviceFingerprint: `notable-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      });

      const { rows } = await query<{ table_number: string | null }>('SELECT table_number FROM guests WHERE id = $1', [
        body.id,
      ]);
      // null, not the empty string — "no table" has to stay a question the
      // column can answer.
      expect(rows[0].table_number).toBeNull();
    }, 20_000);

    it('keeps the avatar the guest chose', async () => {
      const chosen = 'https://example.com/ana.png';
      const { body } = await join({
        name: 'Ana',
        avatarUrl: chosen,
        deviceFingerprint: `avatar-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      });

      expect(body.avatarUrl).toBe(chosen);
    }, 20_000);

    it('generates one from the name when the guest chose none', async () => {
      // The fallback is the other half of the same expression; a test that only
      // covered the supplied case would pass with the fallback deleted.
      const { body } = await join({
        name: 'Silvia',
        deviceFingerprint: `noavatar-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      });

      expect(typeof body.avatarUrl).toBe('string');
      expect(body.avatarUrl).toContain('Silvia');
    }, 20_000);
  });
});
