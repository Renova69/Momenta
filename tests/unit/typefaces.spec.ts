import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * N-149 — the body typeface, Plus Jakarta Sans, has no basic Cyrillic: its
 * fonts declare latin, latin-ext, cyrillic-ext and vietnamese, and the
 * Bulgarian alphabet (U+0410–U+044F) is in none of them. Bulgarian is the
 * app's default language, so every line of body text was the phone's own
 * system font while only the headings rendered as designed.
 *
 * Checked from what ships: the first family of each font stack in the
 * stylesheet's Tailwind theme (`--font-sans`, `--font-serif` in src/index.css)
 * must be declared by a stylesheet src/main.tsx imports, with a unicode-range
 * that covers the alphabet.
 */

const ROOT = path.resolve(__dirname, '../..');
const BULGARIAN = [...'АБВГДЕЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЬЮЯабвгдежзийклмнопрстуфхцчшщъьюя'].map((c) => c.codePointAt(0)!);

/** Every @font-face the entry point pulls in, as family and covered ranges. */
function shippedFaces(): { family: string; ranges: [number, number][] }[] {
  const entry = fs.readFileSync(path.join(ROOT, 'src/main.tsx'), 'utf8');
  const sheets = [...entry.matchAll(/^import '(@fontsource[^']+)';/gm)].map(([, spec]) => {
    const file = spec.endsWith('.css') ? spec : `${spec}/index.css`;
    return fs.readFileSync(path.join(ROOT, 'node_modules', file), 'utf8');
  });
  return sheets.flatMap((css) =>
    [...css.matchAll(/@font-face\s*{([^}]*)}/g)].map(([, body]) => {
      const family = /font-family:\s*'([^']+)'/.exec(body)?.[1] ?? '';
      const rangeText = /unicode-range:\s*([^;]+);/.exec(body)?.[1];
      const ranges: [number, number][] = rangeText
        ? rangeText.split(',').map((r) => {
            const [from, to] = r.trim().replace(/^U\+/i, '').split('-');
            return [parseInt(from, 16), parseInt(to ?? from, 16)];
          })
        : [[0, 0x10ffff]];
      return { family, ranges };
    })
  );
}

function coversBulgarian(family: string): boolean {
  const ranges = shippedFaces()
    .filter((face) => face.family === family)
    .flatMap((face) => face.ranges);
  return BULGARIAN.every((code) => ranges.some(([from, to]) => code >= from && code <= to));
}

/** The first family of a font stack in the Tailwind theme, without quotes. */
function firstFamily(name: 'sans' | 'serif'): string {
  const css = fs.readFileSync(path.join(ROOT, 'src/index.css'), 'utf8');
  const stack = new RegExp(`--font-${name}:\\s*([^;]+);`).exec(css)?.[1] ?? '';
  return stack.split(',')[0].trim().replace(/^["']|["']$/g, '');
}

describe('the typefaces, in Bulgarian', () => {
  it('the body typeface ships the Bulgarian alphabet', () => {
    expect(coversBulgarian(firstFamily('sans'))).toBe(true);
  });

  it('so does the heading typeface', () => {
    expect(coversBulgarian(firstFamily('serif'))).toBe(true);
  });
});
