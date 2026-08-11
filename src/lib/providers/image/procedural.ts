import { Raster, fbm, type Point } from '@/lib/graphics/raster';
import { drawText } from '@/lib/graphics/glyphs';
import { hslToRgb, mix, parseHex, readableTextColor, rgbToHsl, type Rgb } from '@/lib/graphics/color';
import { Rng, seedFrom } from '@/lib/util/random';
import type { ImageGenerationProvider, ImageRequest, ImageResult, ProviderStatus } from '../types';

/**
 * Procedural raster art generator.
 *
 * This is a real generative pipeline, not a template library: composition
 * archetype, geometry, layer count, noise regime, lighting direction and colour
 * relationships are all sampled from a seed derived from the product concept and
 * the prompt, so two different products never receive the same artwork. Output
 * is a genuine RGBA raster (PNG), never vector clip-art.
 *
 * It runs in-process at zero marginal cost and is the default so the factory can
 * produce complete, shippable products without a paid image API. When an image
 * API is configured, the asset pipeline prefers it and keeps this generator for
 * tileable material textures, where determinism matters more than fidelity.
 */

const MAX_DIMENSION = 2048;

type Archetype = 'orbit' | 'lattice' | 'prism' | 'wave' | 'aperture' | 'shards' | 'bloom';

const ARCHETYPES: readonly Archetype[] = ['orbit', 'lattice', 'prism', 'wave', 'aperture', 'shards', 'bloom'];

function derivePalette(rng: Rng, provided?: readonly string[]): Rgb[] {
  if (provided && provided.length >= 3) return provided.map(parseHex);
  const baseHue = rng.float(0, 360);
  const scheme = rng.pick(['analogous', 'triad', 'split', 'tetrad'] as const);
  const offsets =
    scheme === 'analogous'
      ? [0, 28, -26, 55]
      : scheme === 'triad'
        ? [0, 120, 240, 60]
        : scheme === 'split'
          ? [0, 150, 210, 30]
          : [0, 90, 180, 270];
  return offsets.map((o, i) =>
    hslToRgb({
      h: baseHue + o,
      s: rng.float(0.52, 0.92) * (i === 0 ? 1 : 0.9),
      l: i === 0 ? rng.float(0.5, 0.62) : rng.float(0.34, 0.68),
    }),
  );
}

function darken(color: Rgb, amount: number): Rgb {
  const hsl = rgbToHsl(color);
  return hslToRgb({ h: hsl.h, s: hsl.s * 0.9, l: Math.max(0.04, hsl.l - amount) });
}

function initials(prompt: string): string {
  const words = prompt
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1 && !/^(the|and|for|with|app|game|of|a|an)$/i.test(w));
  if (words.length === 0) return 'AF';
  if (words.length === 1) return (words[0] as string).slice(0, 2).toUpperCase();
  return `${(words[0] as string)[0]}${(words[1] as string)[0]}`.toUpperCase();
}

function paintBackground(surface: Raster, rng: Rng, palette: Rgb[], w: number, h: number, seed: number): void {
  const deep = darken(palette[0] as Rgb, 0.42);
  surface.clear(deep, 1);

  const mode = rng.pick(['linear', 'radial'] as const);
  const stops = [
    { at: 0, color: mix(palette[1] as Rgb, deep, rng.float(0.05, 0.3)) },
    { at: rng.float(0.4, 0.65), color: mix(palette[2] ?? (palette[0] as Rgb), deep, rng.float(0.2, 0.45)) },
    { at: 1, color: darken(palette[0] as Rgb, rng.float(0.3, 0.5)) },
  ];
  if (mode === 'linear') {
    const angle = rng.float(0, Math.PI * 2);
    surface.linearGradient(
      { x: w / 2 - (Math.cos(angle) * w) / 2, y: h / 2 - (Math.sin(angle) * h) / 2 },
      { x: w / 2 + (Math.cos(angle) * w) / 2, y: h / 2 + (Math.sin(angle) * h) / 2 },
      stops,
      1,
    );
  } else {
    surface.radialGradient({ x: rng.float(0.25, 0.75) * w, y: rng.float(0.2, 0.6) * h }, Math.hypot(w, h) * rng.float(0.45, 0.8), stops, 1);
  }

  // Atmospheric noise layer: gives the surface real texture instead of a flat fill.
  const scale = rng.float(2.5, 6.5);
  const strength = rng.float(0.06, 0.2);
  const tint = palette[3] ?? (palette[1] as Rgb);
  surface.shade((u, v) => {
    const n = fbm(u * scale, v * scale, seed, { octaves: 5, period: 8 });
    return { color: tint, alpha: Math.max(0, (n - 0.45)) * strength * 2 };
  });
}

function paintMark(surface: Raster, rng: Rng, palette: Rgb[], w: number, h: number, archetype: Archetype, seed: number): void {
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * rng.float(0.24, 0.34);
  const accent = palette[1] as Rgb;
  const accent2 = palette[2] ?? accent;
  const light = mix(accent, { r: 255, g: 255, b: 255 }, 0.4);

  switch (archetype) {
    case 'orbit': {
      const rings = rng.int(2, 5);
      for (let i = 0; i < rings; i += 1) {
        const rr = r * (0.55 + (i / rings) * 0.7);
        surface.strokeCircle(cx, cy, rr, Math.max(1.5, r * rng.float(0.03, 0.075)), mix(accent, accent2, i / rings), rng.float(0.55, 1));
        const bodies = rng.int(1, 4);
        for (let b = 0; b < bodies; b += 1) {
          const a = rng.float(0, Math.PI * 2);
          surface.fillCircle(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr, r * rng.float(0.05, 0.12), light, 0.95);
        }
      }
      break;
    }
    case 'lattice': {
      const cells = rng.int(3, 7);
      const step = (r * 2) / cells;
      for (let gy = 0; gy < cells; gy += 1) {
        for (let gx = 0; gx < cells; gx += 1) {
          const d = Math.hypot(gx - (cells - 1) / 2, gy - (cells - 1) / 2) / cells;
          if (rng.next() < d * 1.4) continue;
          const x = cx - r + gx * step;
          const y = cy - r + gy * step;
          surface.fillRoundedRect(x + step * 0.12, y + step * 0.12, step * 0.76, step * 0.76, step * rng.float(0.05, 0.35), mix(accent, accent2, d + rng.float(-0.15, 0.15)), rng.float(0.6, 1));
        }
      }
      break;
    }
    case 'prism': {
      const faces = rng.int(3, 7);
      for (let i = 0; i < faces; i += 1) {
        const a0 = (i / faces) * Math.PI * 2 + rng.float(-0.15, 0.15);
        const a1 = ((i + 1) / faces) * Math.PI * 2;
        const inner = r * rng.float(0.15, 0.5);
        const points: Point[] = [
          { x: cx, y: cy },
          { x: cx + Math.cos(a0) * r, y: cy + Math.sin(a0) * r },
          { x: cx + Math.cos((a0 + a1) / 2) * r * rng.float(0.8, 1.25), y: cy + Math.sin((a0 + a1) / 2) * r * rng.float(0.8, 1.25) },
          { x: cx + Math.cos(a1) * inner, y: cy + Math.sin(a1) * inner },
        ];
        surface.fillPolygon(points, mix(accent, accent2, i / faces), rng.float(0.55, 0.95));
      }
      break;
    }
    case 'wave': {
      const lines = rng.int(5, 14);
      const amp = r * rng.float(0.25, 0.7);
      const freq = rng.float(1.2, 3.4);
      for (let i = 0; i < lines; i += 1) {
        const t = i / (lines - 1 || 1);
        const points: Point[] = [];
        for (let s = 0; s <= 48; s += 1) {
          const u = s / 48;
          points.push({
            x: cx - r * 1.35 + u * r * 2.7,
            y: cy + (t - 0.5) * r * 1.6 + Math.sin(u * Math.PI * freq + t * 3.1 + rng.float(-0.02, 0.02)) * amp * (1 - Math.abs(t - 0.5)),
          });
        }
        surface.strokePolyline(points, Math.max(1.2, r * rng.float(0.015, 0.045)), mix(accent, light, t), 0.85);
      }
      break;
    }
    case 'aperture': {
      const blades = rng.int(5, 9);
      for (let i = 0; i < blades; i += 1) {
        const a = (i / blades) * Math.PI * 2;
        const spread = (Math.PI * 2) / blades;
        const points: Point[] = [
          { x: cx + Math.cos(a) * r * 0.22, y: cy + Math.sin(a) * r * 0.22 },
          { x: cx + Math.cos(a) * r, y: cy + Math.sin(a) * r },
          { x: cx + Math.cos(a + spread * 0.85) * r, y: cy + Math.sin(a + spread * 0.85) * r },
        ];
        surface.fillPolygon(points, mix(accent, accent2, i / blades), rng.float(0.5, 0.9));
      }
      surface.fillCircle(cx, cy, r * rng.float(0.12, 0.26), light, 0.9);
      break;
    }
    case 'shards': {
      const count = rng.int(4, 10);
      for (let i = 0; i < count; i += 1) {
        const a = rng.float(0, Math.PI * 2);
        const len = r * rng.float(0.5, 1.3);
        const wdt = r * rng.float(0.06, 0.2);
        const nx = Math.cos(a + Math.PI / 2) * wdt;
        const ny = Math.sin(a + Math.PI / 2) * wdt;
        surface.fillPolygon(
          [
            { x: cx + nx, y: cy + ny },
            { x: cx + Math.cos(a) * len + nx * 0.2, y: cy + Math.sin(a) * len + ny * 0.2 },
            { x: cx + Math.cos(a) * len - nx * 0.2, y: cy + Math.sin(a) * len - ny * 0.2 },
            { x: cx - nx, y: cy - ny },
          ],
          mix(accent, light, rng.next()),
          rng.float(0.45, 0.9),
        );
      }
      break;
    }
    case 'bloom': {
      const petals = rng.int(6, 13);
      for (let i = 0; i < petals; i += 1) {
        const a = (i / petals) * Math.PI * 2;
        const rr = r * rng.float(0.6, 1.15);
        surface.fillCircle(cx + Math.cos(a) * rr * 0.55, cy + Math.sin(a) * rr * 0.55, rr * rng.float(0.22, 0.4), mix(accent, accent2, i / petals), rng.float(0.35, 0.7));
      }
      surface.fillCircle(cx, cy, r * rng.float(0.18, 0.3), light, 0.85);
      break;
    }
    default:
      break;
  }

  // Directional light bloom sells the mark as rendered art rather than flat shapes.
  const lightAngle = rng.float(0, Math.PI * 2);
  surface.shade((u, v) => {
    const dx = u - (0.5 + Math.cos(lightAngle) * 0.3);
    const dy = v - (0.5 + Math.sin(lightAngle) * 0.3);
    const d = Math.hypot(dx, dy);
    return { color: light, alpha: Math.max(0, 0.32 - d) * 0.5 };
  });
  void seed;
}

function paintVignette(surface: Raster, strength: number): void {
  surface.shade((u, v) => {
    const d = Math.hypot(u - 0.5, v - 0.5) / Math.SQRT1_2;
    return { color: { r: 0, g: 0, b: 0 }, alpha: Math.max(0, d - 0.5) * strength };
  });
}

function paintScene(surface: Raster, rng: Rng, palette: Rgb[], w: number, h: number, seed: number): void {
  // Layered silhouette landscape with atmospheric perspective — the standard
  // painterly construction, driven entirely by the seeded noise field.
  const horizon = h * rng.float(0.42, 0.62);
  const sky = [
    { at: 0, color: mix(palette[2] ?? (palette[0] as Rgb), { r: 255, g: 255, b: 255 }, 0.25) },
    { at: 0.7, color: palette[1] as Rgb },
    { at: 1, color: darken(palette[0] as Rgb, 0.25) },
  ];
  surface.linearGradient({ x: 0, y: 0 }, { x: 0, y: horizon }, sky, 1);

  const sunX = rng.float(0.15, 0.85) * w;
  const sunY = horizon * rng.float(0.35, 0.85);
  const sunR = Math.min(w, h) * rng.float(0.05, 0.13);
  surface.fillCircle(sunX, sunY, sunR, mix(palette[3] ?? (palette[1] as Rgb), { r: 255, g: 255, b: 255 }, 0.65), 0.95);
  surface.shade((u, v) => {
    const d = Math.hypot(u * w - sunX, v * h - sunY) / (sunR * 6);
    return { color: mix(palette[1] as Rgb, { r: 255, g: 255, b: 255 }, 0.5), alpha: Math.max(0, 1 - d) * 0.35 };
  });

  const layers = rng.int(3, 6);
  for (let l = 0; l < layers; l += 1) {
    const depth = l / (layers - 1 || 1);
    const baseY = horizon + depth * (h - horizon) * rng.float(0.35, 0.8);
    const amplitude = (h - horizon) * (0.35 - depth * 0.22) * rng.float(0.7, 1.4);
    const points: Point[] = [{ x: -2, y: h + 2 }];
    const steps = 96;
    for (let s = 0; s <= steps; s += 1) {
      const u = s / steps;
      const n = fbm(u * rng.float(2, 5) + l * 3.7, depth * 2.3, seed + l * 131, { octaves: 4, period: 16 });
      points.push({ x: u * w, y: baseY - (n - 0.5) * amplitude });
    }
    points.push({ x: w + 2, y: h + 2 });
    surface.fillPolygon(points, mix(darken(palette[0] as Rgb, 0.15), palette[2] ?? (palette[0] as Rgb), 1 - depth), 0.92 - depth * 0.1);
  }

  // Volumetric haze near the horizon.
  surface.shade((_u, v) => {
    const d = Math.abs(v * h - horizon) / (h * 0.18);
    return { color: mix(palette[1] as Rgb, { r: 255, g: 255, b: 255 }, 0.55), alpha: Math.max(0, 1 - d) * 0.28 };
  });
}

function paintTexture(surface: Raster, rng: Rng, palette: Rgb[], seed: number, tileable: boolean): void {
  const period = tileable ? 8 : 32;
  const scale = rng.float(3, 9);
  const warp = rng.float(0, 1.6);
  const roughness = rng.float(0.35, 0.7);
  const base = palette[0] as Rgb;
  const alt = palette[1] as Rgb;
  const detail = palette[2] ?? alt;

  surface.shade((u, v) => {
    const wx = fbm(u * scale * 0.5, v * scale * 0.5, seed + 11, { period, octaves: 3 }) * warp;
    const wy = fbm(u * scale * 0.5 + 3.1, v * scale * 0.5 + 1.7, seed + 23, { period, octaves: 3 }) * warp;
    const n = fbm(u * scale + wx, v * scale + wy, seed, { octaves: 6, gain: roughness, period });
    const grain = fbm(u * scale * 6, v * scale * 6, seed + 97, { octaves: 2, period: period * 4 });
    const t = Math.max(0, Math.min(1, n * 0.85 + grain * 0.15));
    const color = t < 0.5 ? mix(base, alt, t * 2) : mix(alt, detail, (t - 0.5) * 2);
    return { color, alpha: 1 };
  });
}

export class ProceduralImageProvider implements ImageGenerationProvider {
  readonly name = 'procedural';

  status(): ProviderStatus {
    return {
      name: this.name,
      kind: 'image',
      configured: true,
      detail:
        'In-process procedural raster generator (seeded composition, PNG output, zero cost). ' +
        'Configure IMAGE_PROVIDER=openai|stability for photoreal artwork.',
      requires: [],
    };
  }

  async generate(request: ImageRequest): Promise<ImageResult> {
    const started = Date.now();
    const width = Math.max(16, Math.min(request.width, MAX_DIMENSION));
    const height = Math.max(16, Math.min(request.height, MAX_DIMENSION));
    const seed = (request.seed ^ seedFrom(`${request.purpose}:${request.prompt}`)) >>> 0;
    const rng = new Rng(seed);
    const palette = derivePalette(rng, request.palette);
    // Supersampling costs 4x the shading work; above roughly a quarter-megapixel
    // the downsample that follows already removes the aliasing it would fix.
    const supersample = width * height > 300_000 ? 1 : 2;
    const surface = new Raster(width, height, supersample);
    const archetype = ARCHETYPES[seed % ARCHETYPES.length] as Archetype;

    switch (request.purpose) {
      case 'texture': {
        paintTexture(surface, rng, palette, seed, request.tileable ?? true);
        break;
      }
      case 'environment':
      case 'character':
      case 'prop':
      case 'promo':
      case 'screenshot_background': {
        paintScene(surface, rng, palette, width, height, seed);
        if (request.purpose !== 'screenshot_background') {
          paintMark(surface, rng, palette, width, height, archetype, seed);
        }
        paintVignette(surface, 0.55);
        break;
      }
      case 'splash': {
        paintBackground(surface, rng, palette, width, height, seed);
        paintMark(surface, rng, palette, width, height * 0.85, archetype, seed);
        const label = request.prompt.split(/[\n.:]/)[0]?.trim().slice(0, 22) ?? '';
        if (label) {
          const cap = Math.min(width * 0.075, height * 0.06);
          drawText(surface, label, width / 2, height * 0.78, {
            capHeight: cap,
            color: readableTextColor(darken(palette[0] as Rgb, 0.42)),
            align: 'center',
            weight: 0.5,
          });
        }
        paintVignette(surface, 0.7);
        break;
      }
      case 'ui': {
        paintBackground(surface, rng, palette, width, height, seed);
        surface.blur(Math.max(1, Math.min(width, height) * 0.02), 2);
        paintVignette(surface, 0.4);
        break;
      }
      case 'app_icon':
      case 'logo':
      default: {
        paintBackground(surface, rng, palette, width, height, seed);
        paintMark(surface, rng, palette, width, height, archetype, seed);
        const mono = initials(request.prompt);
        const cap = Math.min(width, height) * 0.3;
        drawText(surface, mono, width / 2, height / 2 - cap / 2, {
          capHeight: cap,
          color: readableTextColor(darken(palette[0] as Rgb, 0.42)),
          align: 'center',
          weight: 0.52,
        });
        paintVignette(surface, 0.5);
        break;
      }
    }

    return {
      data: surface.toPng(),
      mime: 'image/png',
      width,
      height,
      provider: this.name,
      model: 'procedural-v1',
      latencyMs: Date.now() - started,
      costUsd: 0,
    };
  }
}
