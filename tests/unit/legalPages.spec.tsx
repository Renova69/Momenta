import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import React from 'react';

import { LegalPage } from '../../src/components/legal/LegalPage';
import { LegalNotice } from '../../src/components/legal/LegalLinks';
import { fillOperatorDetails } from '../../src/components/legal/legalTypes';
import { PRIVACY } from '../../src/components/legal/privacyContent';
import { TERMS } from '../../src/components/legal/termsContent';
import { OPERATOR } from '../../src/config/operator';
import { AppRouter } from '../../src/router';
import { i18n } from '../../src/i18n';

/**
 * N-163 — the privacy policy and the terms. Until the operator fills in
 * src/config/operator.ts, every missing detail must show as a placeholder,
 * never as a blank or a stray `{{token}}`.
 */

afterEach(() => {
  cleanup();
  i18n.setLanguage('bg');
});

describe('filling in the operator details', () => {
  it('shows a placeholder for a detail not given yet, in the page language', () => {
    const empty = { ...OPERATOR, email: '' };
    expect(fillOperatorDetails('Пишете на {{email}}', 'bg', empty)).toBe('Пишете на [ПОПЪЛНЕТЕ: имейл за контакт]');
    expect(fillOperatorDetails('Write to {{email}}', 'en', empty)).toBe('Write to [TO FILL IN: contact email]');
  });

  it('uses a detail once it is given', () => {
    const filled = { ...OPERATOR, email: 'privacy@example.org' };
    expect(fillOperatorDetails('Write to {{email}}', 'en', filled)).toBe('Write to privacy@example.org');
  });

  it('names only details that exist: every token in the texts is a known one', () => {
    for (const doc of [PRIVACY, TERMS]) {
      for (const lang of ['bg', 'en'] as const) {
        const all = [doc[lang].summary, ...doc[lang].sections.flatMap((s) => [...(s.paragraphs ?? []), ...(s.items ?? [])])];
        for (const text of all) {
          expect(fillOperatorDetails(text, lang)).not.toMatch(/\{\{|\}\}/);
        }
      }
    }
  });

  it('has the same sections in both languages', () => {
    for (const doc of [PRIVACY, TERMS]) {
      expect(doc.en.sections).toHaveLength(doc.bg.sections.length);
    }
  });
});

describe('LegalPage', () => {
  it('shows the privacy policy in Bulgarian, every section titled', () => {
    render(<LegalPage doc="privacy" />);

    expect(screen.getByRole('heading', { level: 1, name: PRIVACY.bg.title })).toBeInTheDocument();
    for (const section of PRIVACY.bg.sections) {
      expect(screen.getByRole('heading', { level: 2, name: section.heading })).toBeInTheDocument();
    }
    expect(document.body.textContent).not.toMatch(/\{\{/);
  });

  it('shows the terms in English when the app is in English, and links the other page', () => {
    i18n.setLanguage('en');
    render(<LegalPage doc="terms" />);

    expect(screen.getByRole('heading', { level: 1, name: TERMS.en.title })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: i18n.t('legal.privacy') })).toHaveAttribute('href', '/privacy');
  });
});

describe('where the pages are linked from a form', () => {
  it('names both documents when an account is created', () => {
    render(<LegalNotice kind="signup" />);

    expect(screen.getByRole('link', { name: i18n.t('legal.terms_link') })).toHaveAttribute('href', '/terms');
    expect(screen.getByRole('link', { name: i18n.t('legal.privacy_link') })).toHaveAttribute('href', '/privacy');
  });

  it('opens them in a new tab, so a half-filled form survives', () => {
    render(<LegalNotice kind="guest" />);

    const link = screen.getByRole('link', { name: i18n.t('legal.privacy_link') });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });
});

describe('the addresses of the legal pages', () => {
  it('route to their own views', () => {
    const router = new AppRouter();
    expect(router.parseUrl('/privacy')).toEqual({ view: 'privacy' });
    expect(router.parseUrl('/terms')).toEqual({ view: 'terms' });
  });
});
