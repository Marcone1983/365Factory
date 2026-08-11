import type { Raster, Point } from './raster';
import type { Rgb } from './color';

/**
 * Geometric stroke typeface used for generated wordmarks and monograms.
 *
 * Each glyph is a set of polylines on a 4 x 6 unit em-box (origin top-left).
 * Strokes are rendered with round joins by the raster surface, so the same
 * outlines scale from a 48 px favicon to a 1024 px store icon without artefacts
 * and without shipping a font binary.
 */

const GLYPHS: Record<string, string> = {
  A: '0,6 2,0 4,6|0.8,4.2 3.2,4.2',
  B: '0,0 0,6|0,0 2.8,0 3.8,1 2.8,2.8 0,2.8|0,2.8 3,2.8 4,4.2 3,6 0,6',
  C: '4,1.2 2.6,0 1.4,0 0,1.5 0,4.5 1.4,6 2.6,6 4,4.8',
  D: '0,0 0,6|0,0 2.6,0 4,1.8 4,4.2 2.6,6 0,6',
  E: '4,0 0,0 0,6 4,6|0,3 3.2,3',
  F: '4,0 0,0 0,6|0,3 3.2,3',
  G: '4,1.2 2.6,0 1.4,0 0,1.5 0,4.5 1.4,6 2.8,6 4,4.6 4,3.4 2.4,3.4',
  H: '0,0 0,6|4,0 4,6|0,3 4,3',
  I: '2,0 2,6|0.8,0 3.2,0|0.8,6 3.2,6',
  J: '3.4,0 3.4,4.6 2.2,6 1,6 0,4.8',
  K: '0,0 0,6|4,0 0.2,3.2|1.4,2.2 4,6',
  L: '0,0 0,6 4,6',
  M: '0,6 0,0 2,3 4,0 4,6',
  N: '0,6 0,0 4,6 4,0',
  O: '2,0 0.4,1.4 0.4,4.6 2,6 3.6,4.6 3.6,1.4 2,0',
  P: '0,6 0,0 2.8,0 4,1.5 2.8,3.2 0,3.2',
  Q: '2,0 0.4,1.4 0.4,4.6 2,6 3.6,4.6 3.6,1.4 2,0|2.6,4.4 4.2,6.4',
  R: '0,6 0,0 2.8,0 4,1.5 2.8,3.2 0,3.2|1.8,3.2 4,6',
  S: '4,1.2 2.6,0 1.4,0 0,1.4 1.2,2.8 2.8,3.2 4,4.4 2.8,6 1.2,6 0,4.8',
  T: '0,0 4,0|2,0 2,6',
  U: '0,0 0,4.4 1.6,6 2.4,6 4,4.4 4,0',
  V: '0,0 2,6 4,0',
  W: '0,0 1,6 2,2.6 3,6 4,0',
  X: '0,0 4,6|4,0 0,6',
  Y: '0,0 2,3 4,0|2,3 2,6',
  Z: '0,0 4,0 0,6 4,6',
  '0': '2,0 0.4,1.4 0.4,4.6 2,6 3.6,4.6 3.6,1.4 2,0|0.8,4.8 3.2,1.2',
  '1': '0.8,1.4 2,0 2,6|0.8,6 3.2,6',
  '2': '0.2,1.4 1.6,0 2.8,0 4,1.4 3.6,2.8 0.2,6 4,6',
  '3': '0.2,0.8 1.6,0 3,0 4,1.2 2.8,2.8|2.8,2.8 4,4.4 2.8,6 1.4,6 0.2,5.2',
  '4': '3,0 0.2,4.2 4,4.2|3,2.6 3,6',
  '5': '4,0 0.6,0 0.2,2.8 2.6,2.4 4,3.6 3.2,6 1.2,6 0.2,5.2',
  '6': '3.6,0.6 2.4,0 1,0.6 0.3,3 0.4,5 1.8,6 3,6 4,4.8 3.4,3.4 2,3 0.6,3.6',
  '7': '0,0 4,0 1.6,6',
  '8': '2,0 0.6,1 0.6,2.2 2,3 3.4,2.2 3.4,1 2,0|2,3 0.4,4 0.4,5.2 2,6 3.6,5.2 3.6,4 2,3',
  '9': '0.4,1.2 1,0 2.2,0 3.6,1.2 3.7,3 3.4,5.4 2,6 0.8,5.4',
  '.': '1.9,5.6 2.1,5.6 2.1,6 1.9,6',
  '-': '0.6,3 3.4,3',
  '+': '2,1.2 2,4.8|0.4,3 3.6,3',
};

const EM_WIDTH = 4;
const EM_HEIGHT = 6;
const TRACKING = 1.5;
const SPACE_ADVANCE = 2.6;

function parseGlyph(spec: string): Point[][] {
  return spec.split('|').map((poly) =>
    poly
      .trim()
      .split(/\s+/)
      .map((pair) => {
        const [x, y] = pair.split(',').map(Number);
        return { x: x ?? 0, y: y ?? 0 };
      }),
  );
}

export function isRenderable(char: string): boolean {
  return char === ' ' || char.toUpperCase() in GLYPHS;
}

/** Width in surface units of `text` rendered at the given cap height. */
export function measureText(text: string, capHeight: number): number {
  const unit = capHeight / EM_HEIGHT;
  let width = 0;
  for (const raw of text) {
    const char = raw.toUpperCase();
    if (char === ' ') {
      width += SPACE_ADVANCE * unit;
      continue;
    }
    if (!(char in GLYPHS)) continue;
    width += (EM_WIDTH + TRACKING) * unit;
  }
  return Math.max(0, width - TRACKING * unit);
}

export interface TextOptions {
  readonly capHeight: number;
  readonly weight?: number;
  readonly color: Rgb;
  readonly alpha?: number;
  readonly align?: 'left' | 'center' | 'right';
}

/** Draws `text` with its baseline box top-left at (x, y) in surface units. */
export function drawText(surface: Raster, text: string, x: number, y: number, options: TextOptions): number {
  const unit = options.capHeight / EM_HEIGHT;
  const thickness = (options.weight ?? 0.55) * unit;
  const total = measureText(text, options.capHeight);
  let cursor = x;
  if (options.align === 'center') cursor = x - total / 2;
  else if (options.align === 'right') cursor = x - total;

  for (const raw of text) {
    const char = raw.toUpperCase();
    if (char === ' ') {
      cursor += SPACE_ADVANCE * unit;
      continue;
    }
    const spec = GLYPHS[char];
    if (!spec) continue;
    for (const polyline of parseGlyph(spec)) {
      const points = polyline.map((p) => ({ x: cursor + p.x * unit, y: y + p.y * unit }));
      surface.strokePolyline(points, thickness, options.color, options.alpha ?? 1);
    }
    cursor += (EM_WIDTH + TRACKING) * unit;
  }
  return total;
}
