import { encodePng } from './png';
import { mix, type Rgb } from './color';

export interface Point {
  readonly x: number;
  readonly y: number;
}

/**
 * Software RGBA raster surface with alpha compositing, gradients, polygon
 * scan-conversion, separable blur and periodic value noise.
 *
 * Everything is rendered at an internal supersample factor and box-filtered on
 * export, which is what gives the generated icons and artwork clean edges
 * without depending on a native canvas library.
 */
export class Raster {
  readonly width: number;
  readonly height: number;
  readonly scale: number;
  private readonly w: number;
  private readonly h: number;
  private readonly data: Float32Array; // premultiplied-free RGBA, 0..255 / alpha 0..1

  constructor(width: number, height: number, supersample = 2) {
    this.width = width;
    this.height = height;
    this.scale = Math.max(1, Math.floor(supersample));
    this.w = width * this.scale;
    this.h = height * this.scale;
    this.data = new Float32Array(this.w * this.h * 4);
  }

  private index(x: number, y: number): number {
    return (y * this.w + x) * 4;
  }

  clear(color: Rgb, alpha = 1): void {
    for (let i = 0; i < this.data.length; i += 4) {
      this.data[i] = color.r;
      this.data[i + 1] = color.g;
      this.data[i + 2] = color.b;
      this.data[i + 3] = alpha;
    }
  }

  blend(x: number, y: number, color: Rgb, alpha: number): void {
    if (alpha <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const a = Math.min(1, alpha);
    const i = this.index(x, y);
    const dstA = this.data[i + 3] as number;
    const outA = a + dstA * (1 - a);
    if (outA <= 0) {
      this.data[i + 3] = 0;
      return;
    }
    this.data[i] = ((color.r * a + (this.data[i] as number) * dstA * (1 - a)) / outA);
    this.data[i + 1] = ((color.g * a + (this.data[i + 1] as number) * dstA * (1 - a)) / outA);
    this.data[i + 2] = ((color.b * a + (this.data[i + 2] as number) * dstA * (1 - a)) / outA);
    this.data[i + 3] = outA;
  }

  /** Runs `shader` for every device pixel; coordinates are normalised to 0..1. */
  shade(shader: (u: number, v: number, x: number, y: number) => { color: Rgb; alpha: number } | null): void {
    for (let y = 0; y < this.h; y += 1) {
      for (let x = 0; x < this.w; x += 1) {
        const out = shader((x + 0.5) / this.w, (y + 0.5) / this.h, x, y);
        if (out) this.blend(x, y, out.color, out.alpha);
      }
    }
  }

  fillRect(x: number, y: number, w: number, h: number, color: Rgb, alpha = 1): void {
    const s = this.scale;
    const x0 = Math.max(0, Math.floor(x * s));
    const y0 = Math.max(0, Math.floor(y * s));
    const x1 = Math.min(this.w, Math.ceil((x + w) * s));
    const y1 = Math.min(this.h, Math.ceil((y + h) * s));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) this.blend(px, py, color, alpha);
    }
  }

  fillRoundedRect(x: number, y: number, w: number, h: number, radius: number, color: Rgb, alpha = 1): void {
    const s = this.scale;
    const r = Math.max(0, Math.min(radius, w / 2, h / 2)) * s;
    const left = x * s;
    const top = y * s;
    const right = (x + w) * s;
    const bottom = (y + h) * s;
    const x0 = Math.max(0, Math.floor(left));
    const y0 = Math.max(0, Math.floor(top));
    const x1 = Math.min(this.w, Math.ceil(right));
    const y1 = Math.min(this.h, Math.ceil(bottom));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const sx = px + 0.5;
        const sy = py + 0.5;
        // Nearest point of the inner (corner-inset) rectangle.
        const nx = Math.min(Math.max(sx, left + r), right - r);
        const ny = Math.min(Math.max(sy, top + r), bottom - r);
        if (Math.hypot(sx - nx, sy - ny) > r) continue;
        this.blend(px, py, color, alpha);
      }
    }
  }

  fillCircle(cx: number, cy: number, radius: number, color: Rgb, alpha = 1): void {
    const s = this.scale;
    const x0 = Math.max(0, Math.floor((cx - radius) * s));
    const y0 = Math.max(0, Math.floor((cy - radius) * s));
    const x1 = Math.min(this.w, Math.ceil((cx + radius) * s));
    const y1 = Math.min(this.h, Math.ceil((cy + radius) * s));
    const r2 = (radius * s) ** 2;
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const dx = px + 0.5 - cx * s;
        const dy = py + 0.5 - cy * s;
        if (dx * dx + dy * dy <= r2) this.blend(px, py, color, alpha);
      }
    }
  }

  strokeCircle(cx: number, cy: number, radius: number, thickness: number, color: Rgb, alpha = 1): void {
    const s = this.scale;
    const outer = (radius + thickness / 2) * s;
    const inner = Math.max(0, (radius - thickness / 2) * s);
    const x0 = Math.max(0, Math.floor(cx * s - outer));
    const y0 = Math.max(0, Math.floor(cy * s - outer));
    const x1 = Math.min(this.w, Math.ceil(cx * s + outer));
    const y1 = Math.min(this.h, Math.ceil(cy * s + outer));
    for (let py = y0; py < y1; py += 1) {
      for (let px = x0; px < x1; px += 1) {
        const dx = px + 0.5 - cx * s;
        const dy = py + 0.5 - cy * s;
        const d2 = dx * dx + dy * dy;
        if (d2 <= outer * outer && d2 >= inner * inner) this.blend(px, py, color, alpha);
      }
    }
  }

  /** Even-odd scanline polygon fill in surface coordinates. */
  fillPolygon(points: readonly Point[], color: Rgb, alpha = 1): void {
    if (points.length < 3) return;
    const s = this.scale;
    const ys = points.map((p) => p.y * s);
    const yMin = Math.max(0, Math.floor(Math.min(...ys)));
    const yMax = Math.min(this.h - 1, Math.ceil(Math.max(...ys)));
    for (let py = yMin; py <= yMax; py += 1) {
      const centre = py + 0.5;
      const crossings: number[] = [];
      for (let i = 0; i < points.length; i += 1) {
        const a = points[i] as Point;
        const b = points[(i + 1) % points.length] as Point;
        const ay = a.y * s;
        const by = b.y * s;
        if (ay === by) continue;
        if (centre >= Math.min(ay, by) && centre < Math.max(ay, by)) {
          const t = (centre - ay) / (by - ay);
          crossings.push((a.x + (b.x - a.x) * t) * s);
        }
      }
      crossings.sort((m, n) => m - n);
      for (let i = 0; i + 1 < crossings.length; i += 2) {
        const from = Math.max(0, Math.ceil((crossings[i] as number) - 0.5));
        const to = Math.min(this.w - 1, Math.floor((crossings[i + 1] as number) - 0.5));
        for (let px = from; px <= to; px += 1) this.blend(px, py, color, alpha);
      }
    }
  }

  strokePolyline(points: readonly Point[], thickness: number, color: Rgb, alpha = 1, closed = false): void {
    const segments = closed ? points.length : points.length - 1;
    for (let i = 0; i < segments; i += 1) {
      const a = points[i] as Point;
      const b = points[(i + 1) % points.length] as Point;
      this.strokeSegment(a, b, thickness, color, alpha);
    }
    for (const p of points) this.fillCircle(p.x, p.y, thickness / 2, color, alpha);
  }

  strokeSegment(a: Point, b: Point, thickness: number, color: Rgb, alpha = 1): void {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len === 0) {
      this.fillCircle(a.x, a.y, thickness / 2, color, alpha);
      return;
    }
    const nx = (-dy / len) * (thickness / 2);
    const ny = (dx / len) * (thickness / 2);
    this.fillPolygon(
      [
        { x: a.x + nx, y: a.y + ny },
        { x: b.x + nx, y: b.y + ny },
        { x: b.x - nx, y: b.y - ny },
        { x: a.x - nx, y: a.y - ny },
      ],
      color,
      alpha,
    );
  }

  linearGradient(from: Point, to: Point, stops: ReadonlyArray<{ at: number; color: Rgb }>, alpha = 1): void {
    const s = this.scale;
    const ax = from.x * s;
    const ay = from.y * s;
    const bx = to.x * s;
    const by = to.y * s;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    for (let py = 0; py < this.h; py += 1) {
      for (let px = 0; px < this.w; px += 1) {
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
        this.blend(px, py, sampleStops(stops, t), alpha);
      }
    }
  }

  radialGradient(centre: Point, radius: number, stops: ReadonlyArray<{ at: number; color: Rgb }>, alpha = 1): void {
    const s = this.scale;
    const cx = centre.x * s;
    const cy = centre.y * s;
    const r = radius * s || 1;
    for (let py = 0; py < this.h; py += 1) {
      for (let px = 0; px < this.w; px += 1) {
        const t = Math.max(0, Math.min(1, Math.hypot(px - cx, py - cy) / r));
        this.blend(px, py, sampleStops(stops, t), alpha);
      }
    }
  }

  /** Separable box blur, repeated to approximate a Gaussian. */
  blur(radiusPixels: number, passes = 2): void {
    const r = Math.max(1, Math.round(radiusPixels * this.scale));
    const tmp = new Float32Array(this.data.length);
    for (let pass = 0; pass < passes; pass += 1) {
      this.boxBlurAxis(this.data, tmp, r, true);
      this.boxBlurAxis(tmp, this.data, r, false);
    }
  }

  private boxBlurAxis(src: Float32Array, dst: Float32Array, radius: number, horizontal: boolean): void {
    const outer = horizontal ? this.h : this.w;
    const inner = horizontal ? this.w : this.h;
    for (let o = 0; o < outer; o += 1) {
      for (let i = 0; i < inner; i += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        let n = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const p = Math.min(inner - 1, Math.max(0, i + k));
          const idx = horizontal ? (o * this.w + p) * 4 : (p * this.w + o) * 4;
          r += src[idx] as number;
          g += src[idx + 1] as number;
          b += src[idx + 2] as number;
          a += src[idx + 3] as number;
          n += 1;
        }
        const outIdx = horizontal ? (o * this.w + i) * 4 : (i * this.w + o) * 4;
        dst[outIdx] = r / n;
        dst[outIdx + 1] = g / n;
        dst[outIdx + 2] = b / n;
        dst[outIdx + 3] = a / n;
      }
    }
  }

  /** Downsamples the supersampled surface and encodes it as a PNG. */
  toPng(): Buffer {
    const out = new Uint8Array(this.width * this.height * 4);
    const s = this.scale;
    const samples = s * s;
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        let r = 0;
        let g = 0;
        let b = 0;
        let a = 0;
        for (let sy = 0; sy < s; sy += 1) {
          for (let sx = 0; sx < s; sx += 1) {
            const i = this.index(x * s + sx, y * s + sy);
            const pa = this.data[i + 3] as number;
            r += (this.data[i] as number) * pa;
            g += (this.data[i + 1] as number) * pa;
            b += (this.data[i + 2] as number) * pa;
            a += pa;
          }
        }
        const o = (y * this.width + x) * 4;
        const alpha = a / samples;
        out[o] = clamp255(a > 0 ? r / a : 0);
        out[o + 1] = clamp255(a > 0 ? g / a : 0);
        out[o + 2] = clamp255(a > 0 ? b / a : 0);
        out[o + 3] = clamp255(alpha * 255);
      }
    }
    return encodePng(this.width, this.height, out);
  }
}

function clamp255(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

export function sampleStops(stops: ReadonlyArray<{ at: number; color: Rgb }>, t: number): Rgb {
  if (stops.length === 0) return { r: 0, g: 0, b: 0 };
  if (stops.length === 1) return (stops[0] as { at: number; color: Rgb }).color;
  const sorted = [...stops].sort((a, b) => a.at - b.at);
  if (t <= (sorted[0] as { at: number }).at) return (sorted[0] as { color: Rgb }).color;
  const last = sorted[sorted.length - 1] as { at: number; color: Rgb };
  if (t >= last.at) return last.color;
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const a = sorted[i] as { at: number; color: Rgb };
    const b = sorted[i + 1] as { at: number; color: Rgb };
    if (t >= a.at && t <= b.at) {
      const k = b.at === a.at ? 0 : (t - a.at) / (b.at - a.at);
      return mix(a.color, b.color, k);
    }
  }
  return last.color;
}

// -------------------------------------------------------------------- noise --

function hash2(x: number, y: number, seed: number): number {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smoothstep(t: number): number {
  return t * t * (3 - 2 * t);
}

/**
 * Periodic value noise. `period` makes the field wrap exactly, which is what
 * makes generated textures tile seamlessly on a 3D mesh.
 */
export function valueNoise(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const wrap = (v: number): number => ((v % period) + period) % period;
  const x0 = wrap(xi);
  const y0 = wrap(yi);
  const x1 = wrap(xi + 1);
  const y1 = wrap(yi + 1);
  const u = smoothstep(xf);
  const v = smoothstep(yf);
  const a = hash2(x0, y0, seed);
  const b = hash2(x1, y0, seed);
  const c = hash2(x0, y1, seed);
  const d = hash2(x1, y1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

export interface FbmOptions {
  readonly octaves?: number;
  readonly lacunarity?: number;
  readonly gain?: number;
  readonly period?: number;
}

/** Fractional Brownian motion over periodic value noise. Returns 0..1. */
export function fbm(x: number, y: number, seed: number, options: FbmOptions = {}): number {
  const octaves = options.octaves ?? 5;
  const lacunarity = options.lacunarity ?? 2;
  const gain = options.gain ?? 0.5;
  const basePeriod = options.period ?? 8;
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o += 1) {
    const period = Math.max(1, Math.round(basePeriod * frequency));
    sum += amplitude * valueNoise(x * frequency, y * frequency, period, seed + o * 7919);
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return norm === 0 ? 0 : sum / norm;
}
