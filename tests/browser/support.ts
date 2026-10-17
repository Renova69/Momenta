import fs from 'fs';
import os from 'os';
import path from 'path';
import type { APIRequestContext } from '@playwright/test';
import dotenv from 'dotenv';
import pg from 'pg';
import sharp from 'sharp';
import { bg } from '../../src/i18n/translations/bg';

/**
 * Shared set-up for the browser tests: hosts and albums made through the real
 * API, a few direct database writes for states a journey cannot reach in a
 * minute (an album past its deadline), and the app's own Bulgarian copy, so a
 * reworded label does not break a test that is about behaviour.
 */

dotenv.config({ quiet: true } as dotenv.DotenvConfigOptions);

/** The app's Bulgarian text for a key, with `{{placeholders}}` filled. */
export function t(key: string, params: Record<string, string | number> = {}): string {
  const template = bg[key];
  if (template === undefined) throw new Error(`No Bulgarian text for ${key}`);
  return template.replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(params[name] ?? `{{${name}}}`));
}

export interface TestHost {
  email: string;
  token: string;
  userId: string;
  eventId: string;
  slug: string;
}

/** A host and their first album, registered through the API. */
export async function registerHost(request: APIRequestContext, label: string): Promise<TestHost> {
  const email = `pw-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}@test.com`;
  const res = await request.post('/api/auth/register', {
    data: { fullName: 'Ана и Борис', email, password: 'Browser!2026' },
  });
  if (!res.ok()) throw new Error(`register failed: ${res.status()} ${await res.text()}`);
  const data = await res.json();
  return { email, token: data.token, userId: data.user.id, eventId: data.event.id, slug: data.event.slug };
}

let jpeg: Buffer | null = null;
async function photoBytes(): Promise<Buffer> {
  jpeg ??= await sharp({ create: { width: 320, height: 240, channels: 3, background: { r: 200, g: 150, b: 120 } } })
    .jpeg()
    .toBuffer();
  return jpeg;
}

/** A JPEG on disk, for a file input. */
export async function photoFile(): Promise<string> {
  const file = path.join(os.tmpdir(), `wedmoments-pw-${process.pid}.jpg`);
  fs.writeFileSync(file, await photoBytes());
  return file;
}

/** Upload `count` photos as different guests' phones, through the API. */
export async function uploadPhotos(request: APIRequestContext, eventId: string, count: number): Promise<void> {
  const fullUrl = `data:image/jpeg;base64,${(await photoBytes()).toString('base64')}`;
  for (let i = 0; i < count; i++) {
    const fingerprint = `pw-fill-${Date.now()}-${i}`;
    const res = await request.post('/api/photos', {
      headers: { 'x-device-fingerprint': fingerprint },
      data: { eventId, guestName: `Гост ${i}`, deviceFingerprint: fingerprint, fullUrl },
    });
    if (res.status() !== 201) throw new Error(`upload ${i} failed: ${res.status()} ${await res.text()}`);
  }
}

/** One query against the test database. */
export async function sql(text: string, params: unknown[] = []): Promise<pg.QueryResult> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    return await client.query(text, params);
  } finally {
    await client.end();
  }
}

/**
 * Remove a test host and everything of theirs, files first, as production
 * deletes. The address is in a test domain, so the unit suite's teardown
 * removes anything left behind as well.
 */
export async function removeHost(host: TestHost | undefined): Promise<void> {
  if (!host) return;
  const { deleteEventFixturesForHost } = await import('../helpers/cleanup');
  await deleteEventFixturesForHost(host.userId);
  await sql('DELETE FROM users WHERE id = $1', [host.userId]);
}
