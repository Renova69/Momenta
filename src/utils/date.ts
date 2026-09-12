/**
 * European (EU) date formatting utilities.
 *
 * Numeric dates stay DD.MM.YYYY in every language - that is the European
 * convention the product targets. Long-form dates follow the active language,
 * so switching to English no longer renders Bulgarian month names.
 */
import { i18n } from '../i18n';

const LOCALES: Record<string, string> = {
  bg: 'bg-BG',
  en: 'en-GB',
};

function activeLocale(): string {
  return LOCALES[i18n.getLanguage()] || LOCALES.bg;
}

function toDate(dateVal: string | Date): Date {
  return typeof dateVal === 'string' ? new Date(dateVal) : dateVal;
}

/**
 * Formats any ISO string, Date object or YYYY-MM-DD string into European format DD.MM.YYYY
 * Example: '2026-09-18' -> '18.09.2026'
 */
export function formatEuDate(dateVal: string | Date | undefined | null): string {
  if (!dateVal) return '';

  if (typeof dateVal === 'string') {
    const trimmed = dateVal.trim();
    // If it is already in DD.MM.YYYY format
    if (/^\d{2}\.\d{2}\.\d{4}$/.test(trimmed)) {
      return trimmed;
    }
    // Match simple YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
      const [year, month, day] = trimmed.split('-');
      return `${day}.${month}.${year}`;
    }
  }

  const d = toDate(dateVal);
  if (isNaN(d.getTime())) {
    return typeof dateVal === 'string' ? dateVal : '';
  }

  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();

  return `${day}.${month}.${year}`;
}

/**
 * Long-form date in the active language.
 * Bulgarian: '18 септември 2026 г.' — English: '18 September 2026'.
 */
export function formatEuDateLong(dateVal: string | Date | undefined | null): string {
  if (!dateVal) return '';

  const d = toDate(dateVal);
  if (isNaN(d.getTime())) {
    return formatEuDate(dateVal);
  }

  // Intl carries the month names for every supported language, so they never
  // have to be duplicated in the translation dictionaries.
  try {
    return new Intl.DateTimeFormat(activeLocale(), {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
    }).format(d);
  } catch {
    return formatEuDate(d);
  }
}

/** Relative "time ago" (just now / 5m ago / 3h ago / 2d ago) for feed-style timestamps. */
export function formatTimeAgo(dateVal: string | Date | undefined | null): string {
  if (!dateVal) return '';
  const d = toDate(dateVal);
  if (isNaN(d.getTime())) return '';

  const seconds = Math.floor((Date.now() - d.getTime()) / 1000);
  if (seconds < 60) return i18n.t('feed.just_now');
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return i18n.t('feed.mins_ago', { n: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return i18n.t('feed.hours_ago', { n: hours });
  const days = Math.floor(hours / 24);
  return i18n.t('feed.days_ago', { n: days });
}

/** Date and time in the active language: '18.09.2026, 16:30'. */
export function formatEuDateTime(dateVal: string | Date | undefined | null): string {
  if (!dateVal) return '';

  const d = toDate(dateVal);
  if (isNaN(d.getTime())) {
    return formatEuDate(dateVal);
  }

  const dateFormatted = formatEuDate(d);
  const hours = String(d.getHours()).padStart(2, '0');
  const mins = String(d.getMinutes()).padStart(2, '0');
  const suffix = i18n.getLanguage() === 'bg' ? ' ч.' : '';

  return `${dateFormatted}, ${hours}:${mins}${suffix}`;
}
