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
export function cleanSlug(text: string, dateStr?: string): string {
  const year = dateStr ? new Date(dateStr).getFullYear() || 2026 : 2026;
  if (!text) return `wedding-${year}`;

  const clean = transliterateBg(text.trim())
    .toLowerCase()
    .replace(/\s+и\s+/g, '-and-')
    .replace(/&/g, '-and-')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

  if (!clean) return `wedding-${year}`;
  return clean.includes(String(year)) ? clean : `${clean}-${year}`;
}
