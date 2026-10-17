import { test, expect } from '@playwright/test';
import { registerHost, removeHost, sql, t, type TestHost } from './support';

/**
 * The couple's side, and a visitor deciding whether to become one.
 */

let host: TestHost | undefined;

test.afterEach(async () => {
  await removeHost(host);
  host = undefined;
});

test('a couple signs up and their album opens in the studio', async ({ page }) => {
  const email = `pw-signup-${Date.now()}@test.com`;

  await page.goto('/host');
  await page.getByRole('button', { name: t('host.signup') }).click();
  await page.getByLabel(t('host.couple_names')).fill('Ива и Петър');
  await page.getByLabel(t('host.email')).fill(email);
  await page.getByLabel(t('host.password')).fill('Browser!2026');
  await page.getByRole('button', { name: t('host.signup_btn') }).click();

  await expect(page.getByRole('heading', { level: 2, name: t('host.settings') })).toBeVisible();
  const user = await sql('SELECT id FROM users WHERE email = $1', [email]);
  const event = await sql('SELECT id, slug FROM events WHERE host_user_id = $1', [user.rows[0].id]);
  host = { email, token: '', userId: user.rows[0].id, eventId: event.rows[0].id, slug: event.rows[0].slug };
});

test('a welcome message the couple writes is what guests read', async ({ page, browser, request }) => {
  host = await registerHost(request, 'studio-welcome');

  await page.goto('/host');
  await page.getByLabel(t('host.email')).fill(host.email);
  await page.getByLabel(t('host.password')).fill('Browser!2026');
  await page.getByRole('button', { name: t('host.signin_btn') }).click();
  const field = page.getByLabel(t('ui.host_dashboard.14'));
  await field.fill('Добре дошли! Снимайте всичко.');
  await expect
    .poll(async () => (await sql('SELECT welcome_message FROM events WHERE id = $1', [host!.eventId])).rows[0].welcome_message)
    .toBe('Добре дошли! Снимайте всичко.');

  const guest = await browser.newPage();
  await guest.goto(`/e/${host.slug}`);
  await expect(guest.getByText('Добре дошли! Снимайте всичко.')).toBeVisible();
  await guest.close();
});

test('a visitor who picks a plan is taken to sign up, not to a checkout (N-151)', async ({ page }) => {
  await page.goto('/pricing');
  await page.getByRole('button', { name: t('pricing.choose_plan') }).nth(1).click();

  await expect(page.getByRole('button', { name: t('host.signup_btn') })).toBeVisible();
});

test('the privacy policy and the terms are one click from any page (N-163)', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('contentinfo').getByRole('link', { name: t('legal.privacy') }).click();
  await expect(page.getByRole('heading', { level: 1, name: t('legal.privacy') })).toBeVisible();

  await page.getByRole('contentinfo').getByRole('link', { name: t('legal.terms') }).click();
  await expect(page.getByRole('heading', { level: 1, name: t('legal.terms') })).toBeVisible();
});
