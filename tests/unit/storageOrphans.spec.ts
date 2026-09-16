import { describe, it, expect } from 'vitest';
import { eventIdFromKey } from '../../scripts/storage-orphans';

/**
 * Which stored object belongs to which album.
 *
 * This one function decides what `npm run storage:orphans -- --delete` removes
 * from a live bucket, so the interesting cases are all the ones where it should
 * answer "I don't know". An orphan wrongly kept costs a few cents a year. An
 * object wrongly classified as an orphan is somebody's wedding, deleted, with
 * no copy anywhere — the bucket is the copy.
 *
 * So the rule the tests below pin is deliberately lopsided: anything not
 * clearly inside a recognised event-scoped layout returns null and is left
 * alone, whatever it looks like.
 */

const EVENT = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

describe('keys the scan must attribute to an event', () => {
  it('reads a public photo key', () => {
    expect(eventIdFromKey(`events/${EVENT}/wedding-photo-1789.jpg`)).toBe(EVENT);
  });

  it('reads a quarantined key, which lives one level deeper', () => {
    // Missing this prefix would leave every pending-moderation photo
    // unattributed — and, before the safe default below, deletable.
    expect(eventIdFromKey(`quarantine/events/${EVENT}/wedding-photo-1789.jpg`)).toBe(EVENT);
  });

  it('reads a key nested below the event folder', () => {
    expect(eventIdFromKey(`events/${EVENT}/originals/wedding-original-1789.jpg`)).toBe(EVENT);
  });

  it('reads an audio key, which shares the layout', () => {
    expect(eventIdFromKey(`events/${EVENT}/audio-message-1789.webm`)).toBe(EVENT);
  });
});

describe('keys the scan must refuse to attribute', () => {
  it('refuses a bare directory marker with no object under it', () => {
    // `events/<id>/` is a prefix, not a file to reclaim.
    expect(eventIdFromKey(`events/${EVENT}/`)).toBeNull();
  });

  it('refuses a key with no event segment', () => {
    expect(eventIdFromKey('events/')).toBeNull();
    expect(eventIdFromKey('events')).toBeNull();
  });

  it('refuses anything outside the events layout', () => {
    // Something else's bucket prefix, a backup, a stray upload — none of it is
    // this script's to delete.
    expect(eventIdFromKey('backups/2026-09-01.tar.gz')).toBeNull();
    expect(eventIdFromKey('exports/monika-and-alexander.zip')).toBeNull();
    expect(eventIdFromKey('favicon.ico')).toBeNull();
    expect(eventIdFromKey('')).toBeNull();
  });

  it('refuses a key that only mentions events further along', () => {
    // The anchor is deliberate: matching `events/` anywhere in the key would
    // attribute someone else's object to an album id it happens to contain.
    expect(eventIdFromKey(`archive/events/${EVENT}/photo.jpg`)).toBeNull();
    expect(eventIdFromKey(`someone-elses-events/${EVENT}/photo.jpg`)).toBeNull();
  });

  it('refuses a quarantine key that is not event-scoped', () => {
    expect(eventIdFromKey('quarantine/loose-file.jpg')).toBeNull();
    expect(eventIdFromKey('quarantine/events/')).toBeNull();
  });
});

describe('the shape of the answer', () => {
  it('returns the id exactly, without the surrounding path', () => {
    // The id is compared against `SELECT id FROM events` by string equality, so
    // a stray slash or prefix would make every object look unreferenced.
    const id = eventIdFromKey(`events/${EVENT}/wedding-photo.jpg`);

    expect(id).toBe(EVENT);
    expect(id).not.toContain('/');
    expect(id).not.toContain('events');
  });

  it('does not lowercase or otherwise rewrite the id', () => {
    // Postgres returns uuids lowercased; rewriting here would break the
    // comparison in one direction only, which is the hardest kind to notice.
    const mixed = 'A0EEBC99-9c0b-4ef8-bb6d-6bb9bd380a11';
    expect(eventIdFromKey(`events/${mixed}/photo.jpg`)).toBe(mixed);
  });
});
