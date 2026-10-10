/**
 * Bulgarian Cyrillic to Latin transliteration.
 * Implements the official Bulgarian State Standard (Streamlined System).
 *
 * Shared by the client (slug previews) and the server (slug generation) so the
 * two can never disagree about what a given wedding's URL should be.
 */

const BG_TO_LATIN_MAP: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'е': 'e', 'ж': 'zh',
  'з': 'z', 'и': 'i', 'й': 'y', 'к': 'k', 'л': 'l', 'м': 'm', 'н': 'n',
  'о': 'o', 'п': 'p', 'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f',
  'х': 'h', 'ц': 'ts', 'ч': 'ch', 'ш': 'sh', 'щ': 'sht', 'ъ': 'a', 'ь': 'y',
  'ю': 'yu', 'я': 'ya',
  'А': 'a', 'Б': 'b', 'В': 'v', 'Г': 'g', 'Д': 'd', 'Е': 'e', 'Ж': 'zh',
  'З': 'z', 'И': 'i', 'Й': 'y', 'К': 'k', 'Л': 'l', 'М': 'm', 'Н': 'n',
  'О': 'o', 'П': 'p', 'Р': 'r', 'С': 's', 'Т': 't', 'У': 'u', 'Ф': 'f',
  'Х': 'h', 'Ц': 'ts', 'Ч': 'ch', 'Ш': 'sh', 'Щ': 'sht', 'Ъ': 'a', 'Ь': 'y',
  'Ю': 'yu', 'Я': 'ya',
};

export function transliterateBg(text: string): string {
  if (!text) return '';
  let result = '';
  for (const char of text) {
    result += BG_TO_LATIN_MAP[char] !== undefined ? BG_TO_LATIN_MAP[char] : char;
  }
  return result;
}

/** Build a URL-safe wedding slug, suffixed with the event year. */
/** The longest album address: the `events.slug` column is VARCHAR(100). */
export const SLUG_MAX_LENGTH = 100;

/**
 * How much of a name a generated address keeps (N-87). What is appended to it
 * must still fit the column: the year, a timestamp and a random part on
 * registration, a variant suffix when the address is taken. A 100-character
 * Bulgarian name transliterates to far more (щ becomes "sht"), and used whole
 * it overflowed the column with a 500.
 */
const GENERATED_SLUG_BASE_MAX = 60;

export function cleanSlug(text: string, dateStr?: string): string {
  const year = dateStr ? new Date(dateStr).getFullYear() || 2026 : 2026;
  if (!text) return `wedding-${year}`;

  const clean = transliterateBg(text.trim())
    .toLowerCase()
    .replace(/\s+и\s+/g, '-and-')
    .replace(/&/g, '-and-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  const base = clean.slice(0, GENERATED_SLUG_BASE_MAX).replace(/-+$/, '');
  if (!base) return `wedding-${year}`;
  return base.includes(String(year)) ? base : `${base}-${year}`;
}
