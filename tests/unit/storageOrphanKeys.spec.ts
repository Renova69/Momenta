import { describe, it, expect } from 'vitest';
import { eventIdFromR2Key } from '../../scripts/storage-orphan-sweep';

/**
 * Which R2 object keys the orphan sweep can see.
 *
 * `sweepR2` listed `Prefix: 'events/'` and nothing else, so every object under
 * `quarantine/events/...` was invisible to it — permanently. A photo saved
 * while pending moderation or disposable-locked (MED-03/SEC-M5) lives under
 * that prefix until it is promoted; if its event is deleted first, the objects
 * are orphaned somewhere nothing would ever look. On the development bucket
 * that was 446 objects the sweep could not see, against 12 it could, and on R2
 * they are billed for as long as they exist.
 *
 * The local disk sweep already walked both roots, which is what makes this an
 * oversight in the R2 path rather than a deliberate exclusion.
 *
 * The failure mode is silent in the worst direction: an object the sweep
 * cannot see is never reported, never cleaned, and nothing anywhere says so.
 * Only a test of the key handling itself catches a prefix going missing again.
 */
describe('eventIdFromR2Key', () => {
  const EVENT = 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11';

  it('reads the id from a public object key', () => {
    expect(eventIdFromR2Key(`events/${EVENT}/wedding-photo-123.jpg`)).toBe(EVENT);
  });

  it('reads the id from a quarantined object key', () => {
    // The case that was invisible.
    expect(eventIdFromR2Key(`quarantine/events/${EVENT}/wedding-photo-123.jpg`)).toBe(EVENT);
  });

  it('covers every key shape storage.ts actually writes', () => {
    // server/lib/storage.ts: `${quarantine ? 'quarantine/' : ''}events/${eventId}/${filename}`
    for (const name of ['wedding-photo-1.jpg', 'wedding-thumb-1.jpg', 'wedding-original-1.jpg', 'audio-message-1.webm']) {
      expect(eventIdFromR2Key(`events/${EVENT}/${name}`)).toBe(EVENT);
      expect(eventIdFromR2Key(`quarantine/events/${EVENT}/${name}`)).toBe(EVENT);
    }
  });

  it('refuses a segment that is not a UUID', () => {
    // Guard 4 — the development bucket holds 67 objects under a literal
    // `test-event-id` fixture segment. Refusing to resolve those is what stops
    // the sweep deleting anything whose path it does not actually understand.
    expect(eventIdFromR2Key('events/test-event-id/photo.jpg')).toBeNull();
    expect(eventIdFromR2Key('quarantine/events/not-a-uuid/photo.jpg')).toBeNull();
  });

  it('refuses keys outside the roots this app writes', () => {
    expect(eventIdFromR2Key(`somethingelse/${EVENT}/photo.jpg`)).toBeNull();
    expect(eventIdFromR2Key(`quarantine/other/${EVENT}/photo.jpg`)).toBeNull();
    expect(eventIdFromR2Key(`${EVENT}/photo.jpg`)).toBeNull();
    expect(eventIdFromR2Key('')).toBeNull();
  });

  it('does not mistake the quarantine prefix for an event id', () => {
    // `quarantine/events/<id>/` puts the id at index 2, not 1. Reading index 1
    // would yield the literal string "events", which is not a UUID and would
    // therefore be silently skipped — the exact shape of the original bug.
    expect(eventIdFromR2Key(`quarantine/events/${EVENT}/x.jpg`)).not.toBe('events');
    expect(eventIdFromR2Key(`quarantine/events/${EVENT}/x.jpg`)).toBe(EVENT);
  });
});
