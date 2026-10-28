// ══════════════════════════════════════════════════════════════════
// g2g-sandbox — synthetic portraits and signatures (ADR-047 §3.4)
//
// Generated placeholders, never real faces: a block-mosaic silhouette whose
// shades come from the persona's seed, and a signature-shaped dark band.
// ══════════════════════════════════════════════════════════════════

import { seededRng, seedOf } from '../prng.js';
import { encodeBlockJpeg } from './jpeg.js';

/** A 96×128 greyscale silhouette, base64. */
export function syntheticPortrait(personaKey: string): string {
  const rng = seededRng(seedOf(`portrait:${personaKey}`));
  const background = rng.int(170, 230);
  const figure = rng.int(40, 110);
  const wide = 12;
  const high = 16;
  const shades: number[] = [];
  for (let y = 0; y < high; y += 1) {
    for (let x = 0; x < wide; x += 1) {
      const head = ((x - 5.5) / 3.2) ** 2 + ((y - 5.5) / 4.2) ** 2 <= 1;
      const shoulders = y >= 11 && Math.abs(x - 5.5) <= 1.5 + (y - 11) * 1.3;
      shades.push(head || shoulders ? figure : background - y * 2);
    }
  }
  return encodeBlockJpeg(wide, high, shades).toString('base64');
}

/** A 200×48 greyscale "signature": a light field with a dark, wavy band. */
export function syntheticSignature(personaKey: string): string {
  const rng = seededRng(seedOf(`signature:${personaKey}`));
  const wide = 25;
  const high = 6;
  const phase = rng.next() * Math.PI * 2;
  const shades: number[] = [];
  for (let y = 0; y < high; y += 1) {
    for (let x = 0; x < wide; x += 1) {
      const band = 2.5 + 1.6 * Math.sin(phase + x / 2.2);
      shades.push(Math.abs(y - band) < 0.8 && x > 1 && x < wide - 2 ? 30 : 245);
    }
  }
  return encodeBlockJpeg(wide, high, shades).toString('base64');
}
