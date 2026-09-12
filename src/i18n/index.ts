/**
 * Translation lookup and the current-language singleton.
 *
 * The dictionaries themselves live in `./translations/`; this file is the
 * runtime. Bulgarian is the application's permanent default — the product is
 * sold to Bulgarian couples, and English is the alternative, not the base.
 */

import { bg } from './translations/bg';
import { en } from './translations/en';

export type SupportedLanguage = 'bg' | 'en';

export interface LanguageInfo {
  code: SupportedLanguage;
  name: string;
  nativeName: string;
  flag: string;
}

export const SUPPORTED_LANGUAGES: LanguageInfo[] = [
  { code: 'bg', name: 'Bulgarian', nativeName: 'Български', flag: 'BG' },
  { code: 'en', name: 'English', nativeName: 'English', flag: 'EN' },
];

export const TRANSLATIONS: Record<SupportedLanguage, Record<string, string>> = { bg, en };

class I18nManager {
  // Bulgarian is the permanent default language of the application
  private currentLanguage: SupportedLanguage = 'bg';
  private listeners: Set<() => void> = new Set();

  constructor() {
    this.detectLanguage();
  }

  /**
   * Every localStorage access here is wrapped, and that is load-bearing rather
   * than defensive habit: `detectLanguage` runs from the constructor, the
   * constructor runs at module scope (`export const i18n = new I18nManager()`),
   * and this module is imported by App.tsx and 35 other files. `getItem` throws
   * a SecurityError when site data is blocked — a private window, Safari with
   * cookies disabled, an embedded webview — so an unguarded call there does not
   * degrade the language switcher, it stops the module initialising and the app
   * renders nothing at all.
   *
   * The rest of the codebase already wraps localStorage this way
   * (`src/services/qrCanvasService.ts` and others); this was the one place that
   * did not, and the one place where it mattered most.
   */
  private detectLanguage() {
    if (typeof window === 'undefined') return;
    try {
      const saved = localStorage.getItem('wedmoments_lang') as SupportedLanguage | null;
      if (saved && TRANSLATIONS[saved]) {
        this.currentLanguage = saved;
        return;
      }
      localStorage.setItem('wedmoments_lang', 'bg');
    } catch {
      // No persistence available. Bulgarian is already the field's default, so
      // the app runs correctly; only the remembered choice is lost.
    }
    this.currentLanguage = 'bg';
  }

  public getLanguage(): SupportedLanguage {
    return this.currentLanguage;
  }

  public setLanguage(lang: SupportedLanguage) {
    if (TRANSLATIONS[lang]) {
      this.currentLanguage = lang;
      if (typeof window !== 'undefined') {
        try {
          localStorage.setItem('wedmoments_lang', lang);
        } catch {
          // Storage unavailable or full. The switch still applies for this
          // session; it just will not be remembered on the next visit, which
          // is a better outcome than refusing to change language at all.
        }
      }
      this.listeners.forEach((fn) => fn());
    }
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Look up a translation.
   *
   * The second argument may be a plain fallback string, or values to
   * interpolate into `{{placeholders}}`. Interpolation keeps sentences whole in
   * the dictionary rather than splitting them around a number, which is what
   * makes them translatable at all — word order differs between languages.
   */
  public t(key: string, fallbackOrParams?: string | Record<string, string | number>): string {
    const table = TRANSLATIONS[this.currentLanguage] || TRANSLATIONS.bg;
    const isParams = typeof fallbackOrParams === 'object' && fallbackOrParams !== null;
    const fallback = isParams ? undefined : fallbackOrParams;

    // `??` over a presence check, not `||`: a key deliberately translated to the
    // empty string is a real translation, and `||` would skip past it into
    // another language's text. Nothing is blank today; this keeps it correct if
    // something ever is.
    const template =
      table[key] ?? TRANSLATIONS.bg[key] ?? TRANSLATIONS.en[key] ?? fallback ?? key;
    if (!isParams) return template;

    return template.replace(/\{\{(\w+)\}\}/g, (match, name: string) => {
      const value = (fallbackOrParams as Record<string, string | number>)[name];
      return value === undefined ? match : String(value);
    });
  }
}

export const i18n = new I18nManager();
