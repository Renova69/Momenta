import { test, expect, type Page } from '@playwright/test';
import { registerHost, removeHost, uploadPhotos, photoFile, sql, t, type TestHost } from './support';

/**
 * A guest on a phone, at an album reached by its QR code. These are the
 * journeys the running-app passes walked by hand (§3i, §3k), and the three
 * places guests met something that looked fine and was not: a photo refused
 * by a full album shown as sent (N-150), the couple's upsell (N-151), and an
 * album past its deadline still taking photos (N-159).
 */

let host: TestHost | undefined;

test.afterEach(async () => {
  await removeHost(host);
  host = undefined;
});

/** Open the album and join it as a guest. */
async function joinAlbum(page: Page, slug: string, name: string): Promise<void> {
  await page.goto(`/e/${slug}`);
  const join = page.getByRole('dialog');
  await join.getByPlaceholder(t('profile.name_placeholder')).fill(name);
  await join.getByRole('button', { name: t('profile.save_btn') }).click();
  await expect(join).toBeHidden();
}

/** Pick a photo from the gallery in the camera and send it. */
async function sendPhoto(page: Page): Promise<void> {
  await page.getByRole('button', { name: t('hero.take_photo') }).first().click();
  await page.locator('input[type=file]').last().setInputFiles(await photoFile());
  await page.getByRole('button', { name: t('camera.share_button') }).click();
}

test('a guest joins, sends a photo, and sees it in the album', async ({ page, request }) => {
  host = await registerHost(request, 'guest-send');
  // The content security policy was tightened after a scan (WebSockets to the
  // page's own host only): nothing the album needs may be blocked by it.
  const blocked: string[] = [];
  page.on('console', (msg) => {
    if (/Content Security Policy|violates the following/i.test(msg.text())) blocked.push(msg.text());
  });
  const socket = page.waitForEvent('websocket');

  await joinAlbum(page, host.slug, 'Мария');
  await sendPhoto(page);
  await page.keyboard.press('Escape');

  await expect(page.getByRole('img', { name: /Мария/ }).first()).toBeVisible();
  // The phone shows it at once and sends it after: wait for the server's copy.
  await expect
    .poll(async () => (await (await request.get(`/api/photos?eventId=${host!.eventId}&limit=10`)).json()).length)
    .toBe(1);
  expect((await socket).url()).toMatch(/^ws:\/\/localhost:\d+/);
  expect(blocked).toEqual([]);
});

test('a guest is told a full album took no photo, and nothing waits to retry (N-150)', async ({ page, request }) => {
  host = await registerHost(request, 'guest-full');
  await uploadPhotos(request, host.eventId, 50);

  await joinAlbum(page, host.slug, 'Петър');
  // The guest's notice, not the couple's upsell (N-151).
  await expect(page.getByText(t('feed.album_full_guest', { max: 50 }))).toBeVisible();
  await expect(page.getByRole('button', { name: t('ui.live_feed.2') })).toHaveCount(0);

  await sendPhoto(page);

  await expect(page.getByText(t('upload.album_full'))).toBeVisible();
  await expect(page.getByText(t('common.syncing'))).toHaveCount(0);
  const feed = await (await request.get(`/api/photos?eventId=${host.eventId}&limit=100`)).json();
  expect(feed).toHaveLength(50);
});

test('a closed album says so, and its camera does not open (N-159)', async ({ page, request }) => {
  host = await registerHost(request, 'guest-closed');
  await sql("UPDATE events SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [host.eventId]);

  await joinAlbum(page, host.slug, 'Елена');

  const closedOn = (await sql('SELECT expires_at FROM events WHERE id = $1', [host.eventId])).rows[0].expires_at as Date;
  const date = [closedOn.getDate(), closedOn.getMonth() + 1].map((n) => String(n).padStart(2, '0')).join('.') + `.${closedOn.getFullYear()}`;
  await expect(page.getByText(t('album.closed_guest', { date })).first()).toBeVisible();
  await page.getByRole('button', { name: t('hero.take_photo') }).first().click();
  await expect(page.getByRole('heading', { name: t('album.closed_camera_title') })).toBeVisible();
  await expect(page.locator('input[type=file]')).toHaveCount(0);
});
