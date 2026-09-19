import { describe, it, expect } from 'vitest';
import { generatedAvatarUrl, guestAvatarUrl } from '../../src/utils/avatar';

/**
 * A guest without a selfie is shown as a generated face, seeded by their name.
 * It must be the same face wherever they appear, which only holds while every
 * screen builds the URL through this module.
 */
describe('guest avatars', () => {
  it('gives the same generated face for the same name, every time', () => {
    expect(generatedAvatarUrl('Мария')).toBe(generatedAvatarUrl('Мария'));
    expect(generatedAvatarUrl('Мария')).not.toBe(generatedAvatarUrl('Иван'));
  });

  it('encodes the name, so spaces and Cyrillic cannot break the URL', () => {
    const url = new URL(generatedAvatarUrl('Мария & Иван'));
    expect(url.searchParams.get('seed')).toBe('Мария & Иван');
  });

  it("prefers the guest's own picture, and falls back to the generated face", () => {
    expect(guestAvatarUrl('https://cdn.example/me.jpg', 'Maria')).toBe('https://cdn.example/me.jpg');
    expect(guestAvatarUrl(null, 'Maria')).toBe(generatedAvatarUrl('Maria'));
    expect(guestAvatarUrl(undefined, 'Maria')).toBe(generatedAvatarUrl('Maria'));
    expect(guestAvatarUrl('', 'Maria')).toBe(generatedAvatarUrl('Maria'));
  });
});
