import { describe, it, expect, vi, beforeEach } from 'vitest';
import { i18n, TRANSLATIONS, SUPPORTED_LANGUAGES } from '../../src/i18n';

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
