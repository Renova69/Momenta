import { describe, it, expect } from 'vitest';
import {
  avatarColorFor,
  generatedAvatarUrl,
  guestAvatarUrl,
  initialsFor,
  isGeneratedElsewhere,
} from '../../src/utils/avatar';

/**
 * A guest without a selfie is shown a generated face, seeded by their name.
 * It must be the same face wherever they appear, which only holds while every
 * screen builds it through this module.
 *
 * And it must be drawn here. It used to be fetched from dicebear.com with the
 * guest's name in the query string — a real person at a real wedding, sent to
 * a third party from every device rendering the feed, then stored in their
 * row, broadcast over the socket and included in the album export.
 */
describe('guest avatars', () => {
  it('never leaves the device', () => {
    // The whole point. A generated avatar that is a URL is a request, and a
    // request carries the name.
    const url = generatedAvatarUrl('Мария Петрова');
    expect(url.startsWith('data:image/svg+xml')).toBe(true);
    expect(url).not.toMatch(/^https?:/);
    expect(url).not.toContain('dicebear');
  });

  it('gives the same face for the same name, every time', () => {
    expect(generatedAvatarUrl('Мария')).toBe(generatedAvatarUrl('Мария'));
    expect(generatedAvatarUrl('Мария')).not.toBe(generatedAvatarUrl('Иван'));
  });

  it('gives the same colour on every screen a guest appears on', () => {
    // The feed, the TV wall and the leaderboard each draw their own copy.
    expect(avatarColorFor('Мария')).toBe(avatarColorFor('Мария'));
    expect(avatarColorFor('Мария')).toMatch(/^#[0-9A-F]{6}$/i);
  });

  it('reads initials from the first two words', () => {
    expect(initialsFor('Мария Петрова')).toBe('МП');
    expect(initialsFor('Ivan')).toBe('I');
    expect(initialsFor('  ana   maria  petrova ')).toBe('AM');
  });

  it('still draws something for a guest with no usable name', () => {
    // registerGuest defaults an empty name, but a broadcast from an older
    // client, or a row from before that default, must not render a blank disc.
    expect(initialsFor('   ')).toBe('?');
    expect(generatedAvatarUrl('')).toContain('data:image/svg+xml');
  });

  it('escapes a name that would otherwise break the SVG', () => {
    const decoded = decodeURIComponent(generatedAvatarUrl('<script>&'));
    expect(decoded).not.toContain('<script>');
    expect(decoded).toContain('&lt;');
  });

  it("prefers the guest's own picture", () => {
    expect(guestAvatarUrl('https://cdn.example/me.jpg', 'Maria')).toBe('https://cdn.example/me.jpg');
    expect(guestAvatarUrl(null, 'Maria')).toBe(generatedAvatarUrl('Maria'));
    expect(guestAvatarUrl(undefined, 'Maria')).toBe(generatedAvatarUrl('Maria'));
    expect(guestAvatarUrl('', 'Maria')).toBe(generatedAvatarUrl('Maria'));
  });

  it('ignores a dicebear URL already stored against a guest', () => {
    // Rows written before this change still hold one. Treating it as "no
    // picture" stops the request being made from the moment this ships,
    // without a migration that would have to reach every deployment.
    const stored = 'https://api.dicebear.com/7.x/micah/svg?seed=%D0%9C%D0%B0%D1%80%D0%B8%D1%8F';
    expect(guestAvatarUrl(stored, 'Мария')).toBe(generatedAvatarUrl('Мария'));
    expect(isGeneratedElsewhere(stored)).toBe(true);
    expect(isGeneratedElsewhere('https://cdn.example/selfie.jpg')).toBe(false);
  });
});
