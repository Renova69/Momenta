import { describe, it, expect, vi, beforeEach } from 'vitest';
import { i18n, TRANSLATIONS, SUPPORTED_LANGUAGES } from '../../src/i18n';
import fs from 'fs';
import path from 'path';
import { PLANS } from '../../src/config/plans';
import { ERROR_CODE_KEYS } from '../../src/api/apiClient';

describe('i18n Specification', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('supports all defined language configurations', () => {
    const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
    expect(codes).toContain('bg');
    expect(codes).toContain('en');
  });

  it('switches languages and persists to storage', () => {
    i18n.setLanguage('en');
    expect(i18n.getLanguage()).toBe('en');
    expect(i18n.t('app.title')).toBe('WedMoments');

    i18n.setLanguage('bg');
    expect(i18n.getLanguage()).toBe('bg');
    expect(i18n.t('app.title')).toBe('WedMoments');
  });

  it('provides complete parity between Bulgarian and English keys', () => {
    const bgKeys = Object.keys(TRANSLATIONS.bg || {}).sort();
    const enKeys = Object.keys(TRANSLATIONS.en || {}).sort();

    const missingInEn = bgKeys.filter((k) => !(k in (TRANSLATIONS.en || {})));
    const missingInBg = enKeys.filter((k) => !(k in (TRANSLATIONS.bg || {})));

    expect(missingInEn).toEqual([]);
    expect(missingInBg).toEqual([]);
  });

  it('returns fallback or key when translation is not found', () => {
    expect(i18n.t('unknown.key.123', 'Fallback Text')).toBe('Fallback Text');
    expect(i18n.t('unknown.key.456')).toBe('unknown.key.456');
  });

  it('interpolates {{placeholders}} from a params object', () => {
    expect(i18n.t('showcase.photos_count', { n: 42 })).toContain('42');
  });

  it('leaves a placeholder in place when no value is supplied for it', () => {
    // Better a visible {{n}} than the string "undefined" in front of a guest.
    expect(i18n.t('showcase.photos_count', {})).toContain('{{n}}');
  });

  it('survives localStorage being unavailable', () => {
    // A private window, Safari with cookies off, or an embedded webview throws
    // here. i18n is constructed at module scope and imported by App.tsx, so an
    // unguarded access does not degrade the switcher — it blanks the app.
    // Spying on Storage.prototype does not reach jsdom's localStorage instance,
    // so the accessors have to be replaced on the object the code actually
    // calls. Without that the test passes whether or not the guard exists.
    const real = window.localStorage;
    const deny = () => {
      throw new DOMException('denied', 'SecurityError');
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: { getItem: deny, setItem: deny, removeItem: deny, clear: deny, key: deny, length: 0 },
    });

    try {
      expect(() => i18n.setLanguage('en')).not.toThrow();
      expect(i18n.getLanguage()).toBe('en');
      expect(i18n.t('app.title')).toBe('WedMoments');
    } finally {
      Object.defineProperty(window, 'localStorage', { configurable: true, value: real });
      i18n.setLanguage('bg');
    }
  });

  it('uses {{double}} braces for every placeholder, which is what t() interpolates', () => {
    // Three keys once used single braces. t() only replaces /\{\{(\w+)\}\}/,
    // so the host was shown a literal "{count}" - and on the delete
    // confirmation, told to type "{slug}" rather than their album's address,
    // at the exact moment that safeguard matters most.
    const offenders: string[] = [];
    for (const [lang, table] of Object.entries(TRANSLATIONS)) {
      for (const [key, value] of Object.entries(table)) {
        // A single brace not paired into a double one.
        if (/(?<!\{)\{[a-zA-Z_]+\}(?!\})/.test(value)) offenders.push(`${lang}:${key}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('notifies subscribers on language change', () => {
    const listener = vi.fn();
    const unsub = i18n.subscribe(listener);

    i18n.setLanguage('en');
    expect(listener).toHaveBeenCalled();

    unsub();
    i18n.setLanguage('bg');
  });
});

/**
 * The plan catalogue is rendered at the point of sale.
 *
 * `PricingPlansModal` maps each plan's `features` array straight to `i18n.t()`,
 * so a key in that array with no translation renders the raw key — the literal
 * string `plan.pro.f4` — to someone deciding whether to pay. That is the exact
 * failure mode of removing a feature from the translation tables and forgetting
 * the array, which is how three unbuilt capabilities (white-label, custom
 * subdomains, archive hand-off) came to be advertised on a €49/mo plan.
 *
 * The assertion is over the whole catalogue rather than those three strings, so
 * it holds for the next feature added or withdrawn.
 */
describe('plan catalogue', () => {
  it('renders every advertised feature in both languages', () => {
    const missing: string[] = [];

    for (const [planId, plan] of Object.entries(PLANS)) {
      for (const key of plan.features) {
        for (const lang of ['bg', 'en'] as const) {
          const table = TRANSLATIONS[lang] || {};
          if (!(key in table)) missing.push(`${planId}.${key} [${lang}]`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('names every plan, badge and tagline in both languages', () => {
    const missing: string[] = [];

    for (const [planId, plan] of Object.entries(PLANS)) {
      for (const key of [plan.name, plan.shortName, plan.badge, plan.description].filter(Boolean)) {
        for (const lang of ['bg', 'en'] as const) {
          if (!(key in (TRANSLATIONS[lang] || {}))) missing.push(`${planId}.${key} [${lang}]`);
        }
      }
    }

    expect(missing).toEqual([]);
  });
});

/**
 * Error codes are a translation surface, and nobody was treating them as one.
 *
 * The server writes its error text in English and attaches a machine-readable
 * `code`; `apiClient` swaps in the translation for the active language when the
 * code is mapped, and shows the server's English otherwise. Five of the
 * fourteen codes were mapped. The other nine reached a Bulgarian host as
 * English — a guest told "Join the wedding before commenting", a host told
 * their subscription was "still active with our payment provider" (M-2).
 *
 * This reads the codes out of `server/` rather than listing them, so the tenth
 * one fails the build on the commit that adds it instead of surfacing in front
 * of a couple on their wedding day. Adding a code to the server now means
 * adding a line to ERROR_CODE_KEYS and a string to both tables.
 */
describe('server error codes', () => {
  /** Every `code: 'SOME_CODE'` literal under server/. */
  function emittedCodes(): string[] {
    const root = path.join(process.cwd(), 'server');
    const found = new Set<string>();

    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts')) {
          const source = fs.readFileSync(full, 'utf8');
          for (const match of source.matchAll(/code: *'([A-Z][A-Z0-9_]*)'/g)) {
            found.add(match[1]);
          }
        }
      }
    };

    walk(root);
    return [...found].sort();
  }

  it('finds the codes it is supposed to be checking', () => {
    // If the regex or the layout ever stops matching, every assertion below
    // passes over an empty list and this suite quietly stops testing anything.
    const codes = emittedCodes();

    expect(codes.length).toBeGreaterThanOrEqual(14);
    expect(codes).toContain('TIER_REQUIRED');
  });

  it('maps every code the server emits to a translation key', () => {
    const unmapped = emittedCodes().filter((code) => !(code in ERROR_CODE_KEYS));

    expect(unmapped).toEqual([]);
  });

  it('resolves every mapped key in both languages', () => {
    const missing: string[] = [];

    for (const [code, key] of Object.entries(ERROR_CODE_KEYS)) {
      for (const lang of ['bg', 'en'] as const) {
        if (!(key in (TRANSLATIONS[lang] || {}))) missing.push(`${code} -> ${key} [${lang}]`);
      }
    }

    expect(missing).toEqual([]);
  });

  it('gives each code its own message rather than one shared line', () => {
    // A table that maps nine codes onto one generic string would satisfy the
    // assertions above while telling the reader nothing about what went wrong.
    const keys = Object.values(ERROR_CODE_KEYS);

    expect(new Set(keys).size).toBe(keys.length);
  });
});

/**
 * N-111 — the landing page sold things the product does not have.
 *
 * H-1 took three unbuilt capabilities off the plan catalogue, but the landing
 * page has its own copy and kept selling one of them, alongside others: video
 * uploads, a lifetime archive on a plan that keeps albums a year, a moderator
 * the couple can appoint, and priority processing no tier has. Every string a
 * person can read is checked here, in both languages, so a claim withdrawn
 * from one place cannot survive in another — or come back.
 */
describe('sales claims (N-111)', () => {
  const UNBUILT: [RegExp, string][] = [
    [/видео|\bvideo\b/i, 'video uploads — guests share photos and voice messages only'],
    [/брандинг|branding|white.?label/i, 'custom branding — not built (U-3)'],
    [/доживот|безсроч|lifetime archive|indefinite/i, 'a permanent archive — albums are kept 7 days to a year'],
    [/модератор|moderator|nominate|best man/i, 'a moderator besides the host — only the host account moderates'],
    [/приоритетна облачна|priority cloud|\bCDN\b/i, 'priority processing — every tier shares one pipeline'],
  ];

  it('advertises nothing the product does not do, in either language', () => {
    const found: string[] = [];
    for (const lang of ['bg', 'en'] as const) {
      for (const [key, text] of Object.entries(TRANSLATIONS[lang] || {})) {
        for (const [pattern, why] of UNBUILT) {
          if (pattern.test(String(text))) found.push(`${lang}:${key} — ${why}`);
        }
      }
    }
    expect(found).toEqual([]);
  });
});
