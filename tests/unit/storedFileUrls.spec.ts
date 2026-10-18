import { describe, it, expect } from 'vitest';
import { isStoredAvatarUrl, isStoredCoverUrl, r2KeyFromUrl } from '../../server/lib/storage';

/**
 * N-188 — covers and selfies were recognised as an album's own files only
 * under the current PUBLIC_BASE_URL or R2_PUBLIC_URL. After a domain change,
 * one stored under the old address was never deleted when replaced, removed
 * or purged, and on R2 the old public address did not even map back to its
 * object key. What identifies the file is its path in the album's folder,
 * not the host in front of it.
 */

const EVENT = '3f2b6c1e-9a7d-4e21-8b5f-0c4d2e6a1b9f';
const OTHER = '7a1c2e3f-4b5d-4c6e-9f80-1a2b3c4d5e6f';

describe('an album file stored under an earlier address (N-188)', () => {
  it('is still this album’s cover or selfie, on local storage', () => {
    expect(isStoredCoverUrl(`https://old.example.com/uploads/events/${EVENT}/cover-1700000000000-abc123.jpg`, EVENT)).toBe(true);
    expect(isStoredAvatarUrl(`http://192.168.0.35:6501/uploads/events/${EVENT}/avatar-1700000000000-def456.jpg`, EVENT)).toBe(true);
  });

  it('is still this album’s cover, on R2', () => {
    expect(isStoredCoverUrl(`https://pub-old.r2.dev/events/${EVENT}/cover-1700000000000-abc123.jpg`, EVENT)).toBe(true);
  });

  it('is never another album’s file, or a file of another kind', () => {
    expect(isStoredCoverUrl(`https://old.example.com/uploads/events/${OTHER}/cover-1700000000000-abc123.jpg`, EVENT)).toBe(false);
    expect(isStoredCoverUrl(`https://old.example.com/uploads/events/${EVENT}/wedding-photo-1-abc.jpg`, EVENT)).toBe(false);
    expect(isStoredCoverUrl(`https://old.example.com/uploads/events/${EVENT}/../${OTHER}/cover-1-a.jpg`, EVENT)).toBe(false);
    expect(isStoredCoverUrl(`https://old.example.com/elsewhere/events/${EVENT}/cover-1700000000000-abc123.jpg`, EVENT)).toBe(false);
  });

  it('maps back to its R2 object key under any public host', () => {
    expect(r2KeyFromUrl(`https://pub-old.r2.dev/events/${EVENT}/cover-1-a.jpg`, 'https://pub-new.r2.dev')).toBe(
      `events/${EVENT}/cover-1-a.jpg`
    );
    expect(r2KeyFromUrl(`https://pub-new.r2.dev/quarantine/events/${EVENT}/p.jpg`, 'https://pub-new.r2.dev')).toBe(
      `quarantine/events/${EVENT}/p.jpg`
    );
    expect(r2KeyFromUrl(`events/${EVENT}/p.jpg`, 'https://pub-new.r2.dev')).toBe(`events/${EVENT}/p.jpg`);
  });
});
