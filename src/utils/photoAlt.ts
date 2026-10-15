import { i18n } from '../i18n';
import type { Photo } from '../types';

/**
 * What a screen reader says for a photo: its caption, or who took it (N-143).
 * Every photo was "Wedding moment", in English whatever the page's language,
 * so walking the feed by ear was one phrase over and over.
 */
export function photoAlt(photo: Pick<Photo, 'caption' | 'guestName'>): string {
  const caption = photo.caption?.trim();
  if (caption) return caption;
  return i18n.t('photo.alt_by', { name: photo.guestName?.trim() || i18n.t('guest.fallback_name') });
}
