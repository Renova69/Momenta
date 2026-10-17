import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

import { App } from '../../src/App';
import { router } from '../../src/router';
import { PRIVACY } from '../../src/components/legal/privacyContent';
import { i18n } from '../../src/i18n';

/**
 * The whole app, mounted. App.tsx is the wiring that decides which view shows
 * and who counts as the album's host; the coverage run found nothing
 * mounting it at all. These are smoke tests: that each address renders the
 * view it should, inside the real providers, without crashing.
 */

beforeEach(() => {
  localStorage.clear();
  // Nothing behind the API in a unit test: every call fails, and the app
  // must still render from what it has.
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.pushState({}, '', '/');
});

function at(path: string) {
  window.history.pushState({}, '', path);
  router.navigate(router.parseUrl(path).view, router.parseUrl(path).slug, undefined, { replace: true });
}

describe('the app, mounted', () => {
  it('shows the landing page at the root, with the legal links in the footer', async () => {
    at('/');
    render(<App />);

    expect(await screen.findByRole('contentinfo')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: i18n.t('legal.privacy') })).toHaveAttribute('href', '/privacy');
    expect(screen.getByRole('link', { name: i18n.t('legal.terms') })).toHaveAttribute('href', '/terms');
  });

  it('shows the privacy policy at /privacy', async () => {
    at('/privacy');
    render(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: PRIVACY.bg.title })).toBeInTheDocument();
  });

  it('shows the sign-in page at /host for a visitor with no account', async () => {
    at('/host');
    render(<App />);

    expect(await screen.findByRole('button', { name: i18n.t('host.signin_btn') })).toBeInTheDocument();
  });
});
