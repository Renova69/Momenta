/**
 * Guest avatars.
 *
 * A guest who never took a selfie still gets a face, seeded by their name so
 * it is the same everywhere they appear — the feed, the audio guestbook, the
 * TV wall, the leaderboard. That only holds while every one of those places
 * builds it the same way, which is why this is the only place that does.
 *
 * It used to be `https://api.dicebear.com/7.x/micah/svg?seed=<name>`, and the
 * name in that URL is a real person at a real wedding. It was requested from
 * every device rendering the feed, and written into the guest's row — so it
 * was also stored in Postgres, broadcast over the socket to every other guest
 * and included in the album export. Nobody at the wedding agreed to their name
 * being sent to a third party to have a cartoon drawn, and the drawing is not
 * worth asking for. It was also one more external request on the guest's
 * critical path, over the venue's Wi-Fi, for something that can be drawn here.
 *
 * So it is drawn here: their initial on a colour derived from their name,
 * inline, offline, and identical on every screen showing them.
 */

/** The same six the comment avatars use, so one guest looks like themselves. */
const PALETTE = ['#D4AF37', '#D98991', '#84A784', '#8FA8C9', '#C98FBF', '#C9A17E'];

/** Dark enough on every colour above to stay readable at 24px. */
const INK = '#1A1817';

/** Deterministic: the same name is the same colour on every device, forever. */
export function avatarColorFor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return PALETTE[hash % PALETTE.length];
}

/**
 * One or two letters, from the first two words of the name.
 *
 * `toLocaleUpperCase` rather than `toUpperCase`: the guest list at a Bulgarian
 * wedding is Cyrillic, and a few scripts have casing rules that the invariant
 * version gets wrong.
 */
export function initialsFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '?';
  const letters = words.slice(0, 2).map((word) => [...word][0] ?? '');
  return letters.join('').toLocaleUpperCase();
}

/**
 * The generated face for a name, as an inline SVG.
 *
 * `data:` rather than a fetch: nothing to load, nothing to fail on a venue's
 * Wi-Fi, and the guest's name never leaves the device it was typed on.
 */
export function generatedAvatarUrl(name: string): string {
  const initials = initialsFor(name);
  const background = avatarColorFor(name);
  // viewBox units, not pixels: it is drawn at whatever size the card asks for.
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" role="img">` +
    `<rect width="64" height="64" rx="32" fill="${background}"/>` +
    `<text x="32" y="33" fill="${INK}" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" ` +
    `font-size="${initials.length > 1 ? 26 : 32}" font-weight="600" text-anchor="middle" ` +
    `dominant-baseline="central">${escapeForSvg(initials)}</text>` +
    `</svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * A guest's own picture, or the generated one.
 *
 * A stored dicebear URL is treated as no picture at all. Twenty-one of forty
 * rows in one development database already held one, and rewriting them would
 * need a migration that reached every deployment; ignoring them here means the
 * request is never made again from the moment this ships, whatever is in the
 * column. A guest's real selfie is untouched.
 */
export function guestAvatarUrl(avatarUrl: string | null | undefined, name: string): string {
  if (!avatarUrl || isGeneratedElsewhere(avatarUrl)) return generatedAvatarUrl(name);
  return avatarUrl;
}

/** True for the avatar service this app used to call out to. */
export function isGeneratedElsewhere(avatarUrl: string): boolean {
  return /(^|\.)dicebear\.com\//i.test(avatarUrl) || avatarUrl.includes('api.dicebear.com');
}

function escapeForSvg(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
