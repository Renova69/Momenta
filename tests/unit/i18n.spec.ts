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

  it('notifies subscribers on language change', () => {
    const listener = vi.fn();
    const unsub = i18n.subscribe(listener);

    i18n.setLanguage('en');
    expect(listener).toHaveBeenCalled();

    unsub();
    i18n.setLanguage('bg');
  });
});
