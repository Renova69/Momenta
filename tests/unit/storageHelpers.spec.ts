import { describe, it, expect } from 'vitest';
import {
  decodeDataUrl,
  storagePathBelongsToEvent,
  isQuarantined,
  toStoragePath,
  toAbsoluteUrl,
} from '../../server/lib/storage';
import { CONFIG } from '../../server/lib/config';

/**
 * The pure helpers every storage path runs through.
 *
 * Two of these are security boundaries rather than conveniences.
 * `storagePathBelongsToEvent` is what stops one album's request reaching
 * another album's object, and `isQuarantined` is what decides whether a photo
 * awaiting moderation may be served at all (MED-03/SEC-M5). Both work by
 * substring, which is cheap and correct for the paths the adapters generate —
 * and worth pinning precisely because a substring test is easy to widen by
 * accident.
 */

describe('decodeDataUrl', () => {
  const jpegPayload = Buffer.from('hello').toString('base64');

  it('returns null for anything that is not a data URL', () => {
    expect(decodeDataUrl(null)).toBeNull();
    expect(decodeDataUrl(undefined)).toBeNull();
    expect(decodeDataUrl('')).toBeNull();
    expect(decodeDataUrl('https://cdn.example.com/photo.jpg')).toBeNull();
    expect(decodeDataUrl(42 as unknown as string)).toBeNull();
  });

  it('returns null for a data URL with no comma to split on', () => {
    expect(decodeDataUrl('data:image/jpeg;base64')).toBeNull();
  });

  it('returns null when the payload decodes to nothing', () => {
    // An empty body is not a photo, and must not be written as one.
    expect(decodeDataUrl('data:image/jpeg;base64,')).toBeNull();
  });

  it('defaults to JPEG', () => {
    const out = decodeDataUrl(`data:image/jpeg;base64,${jpegPayload}`);
    expect(out).toMatchObject({ ext: '.jpg', mimetype: 'image/jpeg' });
    expect(out!.buffer.toString()).toBe('hello');
  });

  it('recognises PNG', () => {
    expect(decodeDataUrl(`data:image/png;base64,${jpegPayload}`)).toMatchObject({
      ext: '.png',
      mimetype: 'image/png',
    });
  });

  it('recognises WebP', () => {
    expect(decodeDataUrl(`data:image/webp;base64,${jpegPayload}`)).toMatchObject({
      ext: '.webp',
      mimetype: 'image/webp',
    });
  });

  it('recognises the audio-guestbook formats', () => {
    for (const header of ['data:audio/webm;base64', 'data:audio/ogg;base64', 'data:video/webm;base64']) {
      expect(decodeDataUrl(`${header},${jpegPayload}`)).toMatchObject({
        ext: '.webm',
        mimetype: 'audio/webm',
      });
    }
  });

  it('falls back to JPEG for a type it does not know', () => {
    expect(decodeDataUrl(`data:image/avif;base64,${jpegPayload}`)).toMatchObject({ ext: '.jpg' });
  });
});

describe('storagePathBelongsToEvent', () => {
  const EVENT = 'aaaaaaaa-1111-4222-8333-444455556666';
  const OTHER = 'bbbbbbbb-2222-4333-8444-555566667777';

  it('is false for an absent path rather than throwing', () => {
    expect(storagePathBelongsToEvent(null, EVENT)).toBe(false);
    expect(storagePathBelongsToEvent(undefined, EVENT)).toBe(false);
    expect(storagePathBelongsToEvent('', EVENT)).toBe(false);
  });

  it('accepts a path under this event', () => {
    expect(storagePathBelongsToEvent(`/uploads/events/${EVENT}/wedding-photo-1.jpg`, EVENT)).toBe(true);
  });

  it('accepts a quarantined path under this event', () => {
    expect(
      storagePathBelongsToEvent(`/uploads/quarantine/events/${EVENT}/wedding-photo-1.jpg`, EVENT)
    ).toBe(true);
  });

  it('refuses another album, which is the whole point', () => {
    expect(storagePathBelongsToEvent(`/uploads/events/${OTHER}/wedding-photo-1.jpg`, EVENT)).toBe(false);
  });

  it('refuses an id that merely appears in the filename', () => {
    // The separators matter: the id has to be a path segment, not a substring
    // of one, or a crafted filename would pass the check.
    expect(storagePathBelongsToEvent(`/uploads/events/${OTHER}/${EVENT}.jpg`, EVENT)).toBe(false);
  });

  it('refuses a path with no events segment at all', () => {
    expect(storagePathBelongsToEvent(`/uploads/${EVENT}/photo.jpg`, EVENT)).toBe(false);
  });
});

describe('isQuarantined', () => {
  it('is false for an absent path', () => {
    expect(isQuarantined(null)).toBe(false);
    expect(isQuarantined(undefined)).toBe(false);
    expect(isQuarantined('')).toBe(false);
  });

  it('recognises the local disk layout', () => {
    expect(isQuarantined('/uploads/quarantine/events/e1/photo.jpg')).toBe(true);
  });

  it('recognises an R2 key with no leading slash', () => {
    expect(isQuarantined('quarantine/events/e1/photo.jpg')).toBe(true);
  });

  it('is false for an ordinary public object', () => {
    // A false positive here hides an approved photo from the feed; a false
    // negative serves one that is still awaiting moderation.
    expect(isQuarantined('/uploads/events/e1/photo.jpg')).toBe(false);
    expect(isQuarantined('events/e1/photo.jpg')).toBe(false);
  });

  it('is not fooled by the word appearing in a filename', () => {
    expect(isQuarantined('/uploads/events/e1/quarantine.jpg')).toBe(false);
  });
});

describe('toStoragePath', () => {
  it('returns null for an absent value', () => {
    expect(toStoragePath(null)).toBeNull();
    expect(toStoragePath(undefined)).toBeNull();
    expect(toStoragePath('')).toBeNull();
  });

  it('strips an absolute origin down to the stored path', () => {
    // Some columns hold a path and some a full URL; every delete path needs
    // both to resolve to the same object, or the bytes leak silently.
    expect(toStoragePath('https://cdn.example.com/uploads/events/e1/p.jpg')).toBe(
      '/uploads/events/e1/p.jpg'
    );
  });

  it('leaves an already-relative path alone', () => {
    expect(toStoragePath('/uploads/events/e1/p.jpg')).toBe('/uploads/events/e1/p.jpg');
  });

  it('passes through a value carrying no uploads segment', () => {
    expect(toStoragePath('events/e1/p.jpg')).toBe('events/e1/p.jpg');
  });
});

describe('toAbsoluteUrl', () => {
  it('prefixes the configured public base', () => {
    expect(toAbsoluteUrl('/uploads/events/e1/p.jpg')).toBe(
      `${CONFIG.PUBLIC_BASE_URL}/uploads/events/e1/p.jpg`
    );
  });

  it('leaves an already-absolute URL untouched', () => {
    // R2 hands back a full URL; prefixing it again would produce nonsense.
    const r2 = 'https://cdn.example.com/events/e1/p.jpg';
    expect(toAbsoluteUrl(r2)).toBe(r2);
  });

  it('leaves an empty value alone rather than emitting a bare origin', () => {
    expect(toAbsoluteUrl('')).toBe('');
  });

  it('leaves a path that is not under uploads alone', () => {
    expect(toAbsoluteUrl('/other/p.jpg')).toBe('/other/p.jpg');
  });
});
