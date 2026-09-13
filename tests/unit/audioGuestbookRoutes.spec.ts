import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer } from 'http';
import express from 'express';
import { authRouter } from '../../server/routes/auth';
import { audioRouter } from '../../server/routes/audio';
import { pool, query } from '../../server/lib/db';

const TEST_PORT = 6646;
const BASE_URL = `http://localhost:${TEST_PORT}`;
let server: ReturnType<typeof createServer>;

/**
 * The audio guestbook's identity and privacy rules.
 *
 * `audioGuestbook.spec.tsx` covers the recorder in the browser and
 * `exportAndAudioRoutes.spec.ts` the listing's refusals. This covers the two
 * decisions the endpoint makes that nobody can see from a 201:
 *
 *   Who a message is attributed to. A guestId is public — it travels in the
 *   URL and sits in every other guest's copy of the feed — so it cannot on its
 *   own be enough to post as that person. An unproven id must mint a fresh
 *   guest rather than sign someone else's name to a voice message that gets
 *   played out loud at a reception (SEC-A2/SEC-D3).
 *
 *   Who may hear them yet. Disposable mode exists so nobody sees anything
 *   until the couple's reveal moment. Photos respect that gate; voice messages
 *   are stored in a different table with no per-row status, and the same rule
 *   has to be enforced here or the link is a way around the whole feature
 *   (SEC-07).
 */

/** WebM/Matroska magic bytes, so the upload passes the content check. */
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(2048, 7)]);

function multipartAudio(
  bytes: Buffer,
  fields: Record<string, string>,
  filename = 'message.webm',
  contentType = 'audio/webm'
): { body: BodyInit; contentType: string } {
  const boundary = `----AudioSpec${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
  const parts: Buffer[] = [
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="${filename}"\r\n` +
        `Content-Type: ${contentType}\r\n\r\n`
    ),
    bytes,
    Buffer.from('\r\n'),
  ];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${key}"\r\n\r\n${value}\r\n`)
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    body: Buffer.concat(parts) as unknown as BodyInit,
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

/**
 * Every call carries its own device fingerprint, as a real guest's phone does.
 *
 * The upload limiter allows twenty a minute per device and falls back to the
 * caller's IP when it cannot identify one — and it runs before multer, so a
 * fingerprint inside the multipart body is invisible to it. Without the header
 * every request in this file would share one budget and the later tests would
 * fail as 429s that look like missing rows. That is not a detail of the test:
 * it is the same fallback that would have given an entire wedding reception,
 * behind one NAT address, twenty recordings between them.
 */
function postAudio(
  bytes: Buffer,
  fields: Record<string, string>,
  filename?: string,
  mime?: string
): Promise<Response> {
  const { body, contentType } = multipartAudio(bytes, fields, filename, mime);
  return fetch(`${BASE_URL}/api/audio`, {
    method: 'POST',
    headers: {
      'Content-Type': contentType,
      'x-device-fingerprint': `audio-spec-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
    },
    body,
  });
}

interface Host {
  token: string;
  userId: string;
  eventId: string;
}

async function registerHost(): Promise<Host> {
  const email = `audio-spec-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const res = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, fullName: 'Audio Spec Host', password: 'Password123!' }),
  });
  const data = await res.json();
  return { token: data.token, userId: data.user.id, eventId: data.event.id };
}

let host: Host;

beforeAll(async () => {
  const app = express();
  server = createServer(app);
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/auth', authRouter);
  app.use('/api/audio', audioRouter);
  await new Promise<void>((resolve) => server.listen(TEST_PORT, () => resolve()));

  host = await registerHost();
  // The guestbook is gated to deluxe_keepsake and above.
  await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [host.userId]);
}, 30_000);

afterAll(async () => {
  if (server) server.close();
  await query('DELETE FROM events WHERE id = $1', [host.eventId]).catch(() => undefined);
});

describe('refusing a bad recording', () => {
  it('rejects a request with no event id', async () => {
    const res = await postAudio(WEBM, {});
    expect([400, 403]).toContain(res.status);
  });

  it('rejects a malformed event id rather than hitting the database with it', async () => {
    const res = await postAudio(WEBM, { eventId: 'not-a-uuid' });
    expect([400, 403]).toContain(res.status);
  });

  it('rejects an empty file', async () => {
    const res = await postAudio(Buffer.alloc(0), { eventId: host.eventId });
    expect(res.status).toBe(400);
  });

  it('rejects bytes that are not audio, whatever the client called them', async () => {
    // The declared type comes from the uploader. Checking it instead of the
    // bytes is how a script gets stored and served from the album's own
    // origin (SEC-M3).
    const res = await postAudio(Buffer.from('<script>alert(1)</script>'), {
      eventId: host.eventId,
    });
    expect(res.status).toBe(400);
  });

  it('is a 404 for an album that does not exist', async () => {
    const res = await postAudio(WEBM, { eventId: '00000000-0000-4000-8000-000000000000' });
    expect([403, 404]).toContain(res.status);
  });
});

describe('who a message is attributed to', () => {
  it('mints a guest when none was supplied', async () => {
    const res = await postAudio(WEBM, { eventId: host.eventId, guestName: 'Ana' });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.guestId).toBeTruthy();
    expect(body.guestName).toBe('Ana');
  }, 20_000);

  it('hands back a token so the next message is provably the same guest', async () => {
    const res = await postAudio(WEBM, { eventId: host.eventId, guestName: 'Boris' });
    const body = await res.json();

    expect(typeof body.guestToken).toBe('string');
    expect(body.guestToken.length).toBeGreaterThan(10);
  }, 20_000);

  it('accepts a returning guest who proves the id with their token', async () => {
    const first = await (await postAudio(WEBM, { eventId: host.eventId, guestName: 'Silvia' })).json();

    const second = await postAudio(WEBM, {
      eventId: host.eventId,
      guestId: first.guestId,
      guestToken: first.guestToken,
      guestName: 'Silvia',
    });

    expect(second.status).toBe(201);
    expect((await second.json()).guestId).toBe(first.guestId);
  }, 30_000);

  it('refuses to sign someone else’s name to a message on a bare guest id', async () => {
    // The attack this closes: a guest id is public, so without the token any
    // guest in the room could post a voice message as the bride.
    const victim = await (
      await postAudio(WEBM, { eventId: host.eventId, guestName: 'The Bride' })
    ).json();

    const impostor = await postAudio(WEBM, {
      eventId: host.eventId,
      guestId: victim.guestId,
      guestName: 'The Bride',
    });

    expect(impostor.status).toBe(201);
    // A fresh guest row, not the one that was named.
    expect((await impostor.json()).guestId).not.toBe(victim.guestId);
  }, 30_000);

  it('refuses a token minted for a different album', async () => {
    const other = await registerHost();
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [
      other.userId,
    ]);
    const theirs = await (
      await postAudio(WEBM, { eventId: other.eventId, guestName: 'Elsewhere' })
    ).json();

    const res = await postAudio(WEBM, {
      eventId: host.eventId,
      guestId: theirs.guestId,
      guestToken: theirs.guestToken,
      guestName: 'Elsewhere',
    });

    expect(res.status).toBe(201);
    expect((await res.json()).guestId).not.toBe(theirs.guestId);

    await query('DELETE FROM events WHERE id = $1', [other.eventId]).catch(() => undefined);
  }, 30_000);

  it('falls back to a generic name when none was given', async () => {
    const res = await postAudio(WEBM, { eventId: host.eventId });
    expect((await res.json()).guestName).toBe('Guest');
  }, 20_000);
});

describe('the message itself', () => {
  it('stores a note, and stores null rather than an empty one', async () => {
    const withNote = await (
      await postAudio(WEBM, { eventId: host.eventId, guestName: 'Ana', note: '  Congratulations  ' })
    ).json();
    const blank = await (
      await postAudio(WEBM, { eventId: host.eventId, guestName: 'Ana', note: '   ' })
    ).json();

    expect(withNote.note).toBe('Congratulations');
    expect(blank.note).toBeNull();
  }, 30_000);

  it('treats an unparseable duration as zero rather than NaN', async () => {
    // NaN reaches the column as null at best and breaks the player at worst.
    const res = await postAudio(WEBM, {
      eventId: host.eventId,
      guestName: 'Ana',
      durationSeconds: 'not-a-number',
    });

    expect((await res.json()).durationSeconds).toBe(0);
  }, 20_000);

  it('echoes the client’s local id so an optimistic entry can be reconciled', async () => {
    const res = await postAudio(WEBM, {
      eventId: host.eventId,
      guestName: 'Ana',
      localId: 'temp-123',
    });

    expect((await res.json()).localId).toBe('temp-123');
  }, 20_000);

  it('picks the file extension from the recording’s own type', async () => {
    // Safari records mp4 where Chrome records webm, and the stored object has
    // to keep an extension the browser will play back.
    const res = await postAudio(WEBM, { eventId: host.eventId, guestName: 'Ana' }, 'take.mp4', 'audio/mp4');

    expect(res.status).toBe(201);
    expect((await res.json()).audioUrl).toMatch(/\.mp4$/);
  }, 20_000);

  it('falls back to webm for a type it does not recognise', async () => {
    const res = await postAudio(
      WEBM,
      { eventId: host.eventId, guestName: 'Ana' },
      'take.bin',
      'application/octet-stream'
    );

    expect(res.status).toBe(201);
    expect((await res.json()).audioUrl).toMatch(/\.webm$/);
  }, 20_000);
});

describe('who may hear the messages', () => {
  async function setDisposable(eventId: string, revealAt: string | null) {
    await pool.query('UPDATE events SET is_disposable_mode = true, reveal_at = $2 WHERE id = $1', [
      eventId,
      revealAt,
    ]);
  }

  it('withholds every message from a guest before the reveal moment', async () => {
    // SEC-07. Photos already respect this gate; audio lives in another table
    // with no per-row status, so the same rule has to be enforced here.
    const locked = await registerHost();
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [
      locked.userId,
    ]);
    await postAudio(WEBM, { eventId: locked.eventId, guestName: 'Ana' });
    await setDisposable(locked.eventId, new Date(Date.now() + 3600_000).toISOString());

    const res = await fetch(`${BASE_URL}/api/audio?eventId=${locked.eventId}`);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([]);

    await query('DELETE FROM events WHERE id = $1', [locked.eventId]).catch(() => undefined);
  }, 30_000);

  it('still shows them to the host, who set the reveal in the first place', async () => {
    const locked = await registerHost();
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [
      locked.userId,
    ]);
    await postAudio(WEBM, { eventId: locked.eventId, guestName: 'Ana' });
    await setDisposable(locked.eventId, new Date(Date.now() + 3600_000).toISOString());

    const res = await fetch(`${BASE_URL}/api/audio?eventId=${locked.eventId}`, {
      headers: { Authorization: `Bearer ${locked.token}` },
    });

    expect(res.status).toBe(200);
    expect((await res.json()).length).toBeGreaterThan(0);

    await query('DELETE FROM events WHERE id = $1', [locked.eventId]).catch(() => undefined);
  }, 30_000);

  it('opens up once the reveal moment has passed', async () => {
    const revealed = await registerHost();
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [
      revealed.userId,
    ]);
    await postAudio(WEBM, { eventId: revealed.eventId, guestName: 'Ana' });
    await setDisposable(revealed.eventId, new Date(Date.now() - 1000).toISOString());

    const res = await fetch(`${BASE_URL}/api/audio?eventId=${revealed.eventId}`);

    expect((await res.json()).length).toBeGreaterThan(0);

    await query('DELETE FROM events WHERE id = $1', [revealed.eventId]).catch(() => undefined);
  }, 30_000);

  it('is a 404 for an album that does not exist', async () => {
    const res = await fetch(`${BASE_URL}/api/audio?eventId=00000000-0000-4000-8000-000000000000`);
    expect(res.status).toBe(404);
  });

  it('returns the newest message first', async () => {
    const ordered = await registerHost();
    await query("UPDATE subscriptions SET tier = 'deluxe_keepsake' WHERE user_id = $1", [
      ordered.userId,
    ]);
    await postAudio(WEBM, { eventId: ordered.eventId, guestName: 'First', note: 'one' });
    await postAudio(WEBM, { eventId: ordered.eventId, guestName: 'Second', note: 'two' });

    const rows = await (await fetch(`${BASE_URL}/api/audio?eventId=${ordered.eventId}`)).json();

    expect(rows[0].note).toBe('two');

    await query('DELETE FROM events WHERE id = $1', [ordered.eventId]).catch(() => undefined);
  }, 30_000);
});
