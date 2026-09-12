/**
 * Bulgarian Cyrillic to Latin transliteration.
 *
 * Re-exported from the shared module so the client and server can never drift on
 * how a wedding slug is generated.
 */
export { transliterateBg, cleanSlug } from '../../shared/transliterate';
export { cleanSlug as generateEventSlug } from '../../shared/transliterate';
