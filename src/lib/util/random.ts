/**
 * Deterministic pseudo-random number generation.
 *
 * Every generative step in the platform (brand palettes, procedural art, mesh
 * synthesis, world layout) is driven by a seed derived from the product concept,
 * so a given concept always regenerates byte-identical assets. That makes builds
 * reproducible and makes regressions debuggable.
 */

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  /** mulberry32 — small, fast, and statistically sound for content generation. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  float(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  int(minInclusive: number, maxExclusive: number): number {
    return Math.floor(this.float(minInclusive, maxExclusive));
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    if (items.length === 0) throw new Error('Rng.pick called with an empty list');
    return items[this.int(0, items.length)] as T;
  }

  /** Fisher-Yates shuffle of a copy. */
  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = this.int(0, i + 1);
      const tmp = out[i] as T;
      out[i] = out[j] as T;
      out[j] = tmp;
    }
    return out;
  }

  /** Box-Muller normal deviate. */
  gaussian(mean = 0, stdDev = 1): number {
    const u = Math.max(this.next(), Number.EPSILON);
    const v = this.next();
    return mean + stdDev * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
}

/** Stable 32-bit seed derived from arbitrary text (FNV-1a). */
export function seedFrom(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
