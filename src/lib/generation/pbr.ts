import { encodePng } from '@/lib/graphics/png';
import { fbm, valueNoise } from '@/lib/graphics/raster';
import { hslToRgb, mix, parseHex, rgbToHsl, type Rgb } from '@/lib/graphics/color';
import { Rng, seedFrom } from '@/lib/util/random';

/**
 * Physically based texture synthesis.
 *
 * A metallic-roughness renderer needs three maps to look like a real material:
 * albedo (colour with no lighting baked in), a tangent-space normal map, and an
 * ORM pack (occlusion / roughness / metallic in R / G / B). This module
 * generates all three from a shared height field, so the bumps in the normal
 * map, the cavities in the occlusion channel and the wear in the roughness
 * channel all agree with each other — which is exactly what makes a surface read
 * as a material rather than as a coloured noise pattern.
 *
 * Everything tiles seamlessly (periodic noise) and is reproducible from a seed.
 */

export type MaterialFamily =
  | 'car_paint'
  | 'metal_brushed'
  | 'metal_worn'
  | 'rubber'
  | 'glass'
  | 'asphalt'
  | 'concrete'
  | 'sand'
  | 'grass'
  | 'rock'
  | 'bark'
  | 'fabric'
  | 'leather'
  | 'skin'
  | 'hair'
  | 'emissive_panel';

export interface MaterialRecipe {
  readonly family: MaterialFamily;
  readonly baseColor: string;
  readonly secondaryColor?: string;
  /** 0 = mirror, 1 = fully diffuse. */
  readonly roughness: number;
  readonly metallic: number;
  /** Height amplitude in texture space; drives the normal map strength. */
  readonly relief: number;
  /** Surface detail frequency. Higher = finer grain. */
  readonly detailScale: number;
  /** 0..1 amount of wear, scratches and dirt. */
  readonly wear: number;
  readonly clearcoat?: number;
  readonly transmission?: number;
  readonly emissiveStrength?: number;
}

export interface TextureSet {
  readonly albedo: Buffer;
  readonly normal: Buffer;
  /** Occlusion (R), roughness (G), metallic (B). */
  readonly orm: Buffer;
  readonly emissive?: Buffer;
  readonly size: number;
  readonly recipe: MaterialRecipe;
}

const FAMILY_DEFAULTS: Record<MaterialFamily, Omit<MaterialRecipe, 'family' | 'baseColor'>> = {
  car_paint: { roughness: 0.22, metallic: 0.35, relief: 0.012, detailScale: 26, wear: 0.05, clearcoat: 1 },
  metal_brushed: { roughness: 0.34, metallic: 0.95, relief: 0.03, detailScale: 120, wear: 0.15 },
  metal_worn: { roughness: 0.55, metallic: 0.85, relief: 0.09, detailScale: 34, wear: 0.6 },
  rubber: { roughness: 0.92, metallic: 0.02, relief: 0.08, detailScale: 48, wear: 0.25 },
  glass: { roughness: 0.05, metallic: 0.0, relief: 0.004, detailScale: 12, wear: 0.02, transmission: 0.92 },
  asphalt: { roughness: 0.88, metallic: 0.0, relief: 0.16, detailScale: 44, wear: 0.45 },
  concrete: { roughness: 0.9, metallic: 0.0, relief: 0.13, detailScale: 22, wear: 0.4 },
  sand: { roughness: 0.95, metallic: 0.0, relief: 0.1, detailScale: 60, wear: 0.2 },
  grass: { roughness: 0.94, metallic: 0.0, relief: 0.14, detailScale: 70, wear: 0.3 },
  rock: { roughness: 0.87, metallic: 0.02, relief: 0.28, detailScale: 16, wear: 0.5 },
  bark: { roughness: 0.93, metallic: 0.0, relief: 0.24, detailScale: 18, wear: 0.45 },
  fabric: { roughness: 0.88, metallic: 0.0, relief: 0.06, detailScale: 130, wear: 0.2 },
  leather: { roughness: 0.7, metallic: 0.0, relief: 0.09, detailScale: 55, wear: 0.3 },
  skin: { roughness: 0.62, metallic: 0.0, relief: 0.02, detailScale: 90, wear: 0.08 },
  hair: { roughness: 0.45, metallic: 0.0, relief: 0.05, detailScale: 180, wear: 0.1 },
  emissive_panel: { roughness: 0.3, metallic: 0.1, relief: 0.02, detailScale: 20, wear: 0.05, emissiveStrength: 4 },
};

export function recipeFor(family: MaterialFamily, baseColor: string, overrides: Partial<MaterialRecipe> = {}): MaterialRecipe {
  return { family, baseColor, ...FAMILY_DEFAULTS[family], ...overrides };
}

/**
 * Height field for a family. Each material has a distinct construction rather
 * than a shared noise call — brushed metal is anisotropic, asphalt is aggregate
 * cells, bark is stretched ridges, fabric is a woven lattice.
 *
 * `limit` is the highest frequency the map can carry: a pattern finer than about
 * four texels per cycle cannot be represented and comes back as moiré — the
 * wide diagonal banding that made a woven jacket look like corduroy and brushed
 * steel look like watered silk. Detail beyond the limit is not lost, it is moved
 * into roughness, which is where a material finer than the texel grid actually
 * expresses itself.
 */
function heightAt(recipe: MaterialRecipe, u: number, v: number, seed: number, limit: number): number {
  const s = Math.min(recipe.detailScale, limit);
  /** Frequency for one term, never above what the map can resolve. */
  const f = (multiplier: number): number => Math.min(recipe.detailScale * multiplier, limit);
  switch (recipe.family) {
    case 'metal_brushed':
      // Strongly anisotropic: fine streaks along U, almost no variation along V.
      return fbm(u * s, v * 2, seed, { octaves: 3, period: 64 }) * 0.7 + valueNoise(u * f(3), v, 128, seed + 5) * 0.3;
    case 'asphalt': {
      // Aggregate: Worley-style cells give stone chips embedded in binder.
      let nearest = 1;
      const cells = Math.max(4, Math.round(s / 4));
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const gx = Math.floor(u * cells) + dx;
          const gy = Math.floor(v * cells) + dy;
          const px = (gx + valueNoise(gx, gy, cells, seed)) / cells;
          const py = (gy + valueNoise(gx, gy, cells, seed + 3)) / cells;
          nearest = Math.min(nearest, Math.hypot(u - px, v - py) * cells);
        }
      }
      return 1 - Math.min(1, nearest) * 0.8 + fbm(u * s * 2, v * s * 2, seed + 9, { octaves: 3, period: 32 }) * 0.2;
    }
    case 'bark':
      return fbm(u * s * 0.3, v * s * 3.4, seed, { octaves: 5, period: 24 });
    case 'fabric': {
      // A twill rather than a plain grid: real cloth shows a diagonal because
      // the weft crosses two warps at a time, and a pure sin(u)·sin(v) lattice
      // reads as graph paper. The threads are individually raised, so the
      // crossings sit proud and the interstices sink.
      const scale = Math.min(recipe.detailScale, limit * 0.5);
      const warp = Math.sin(u * scale * Math.PI * 2) * 0.5 + 0.5;
      const weft = Math.sin(v * scale * Math.PI * 2) * 0.5 + 0.5;
      const twill = Math.sin((u + v * 0.5) * scale * Math.PI * 2) * 0.5 + 0.5;
      const fibre = fbm(u * f(2.5), v * f(2.5), seed + 31, { octaves: 2, period: 48 });
      return (warp * 0.34 + weft * 0.34 + twill * 0.32) * 0.72 + fibre * 0.28;
    }
    case 'hair':
      // Strands run along V and clump along U: the clumping is what stops hair
      // reading as a brushed-metal cap.
      return (
        fbm(u * f(0.12), v * Math.min(recipe.detailScale * 5, limit), seed, { octaves: 3, period: 48 }) * 0.72 +
        fbm(u * f(0.03), v * f(0.2), seed + 17, { octaves: 2, period: 24 }) * 0.28
      );
    case 'skin':
      // Pores, and almost nothing else. Skin has very little large-scale albedo
      // or height variation — the slow term used to carry two thirds of the
      // weight, and at that strength it reads as marble, or as cling film
      // stretched over the face. Pores dominate; the mid-frequency term is a
      // hint of dermal unevenness, not a pattern.
      return (
        fbm(u * f(7), v * f(7), seed, { octaves: 2, period: 64 }) * 0.68 +
        fbm(u * f(1.2), v * f(1.2), seed + 11, { octaves: 3, period: 32 }) * 0.24 +
        fbm(u * 3, v * 3, seed + 23, { octaves: 2, period: 16 }) * 0.08
      );
    case 'rock':
      return fbm(u * s, v * s, seed, { octaves: 6, gain: 0.58, period: 16 });
    case 'leather':
      // A cell structure with fine creases between the grains, which is what
      // distinguishes leather from generic bumpy noise.
      return fbm(u * f(1.6), v * f(1.6), seed, { octaves: 4, gain: 0.62, period: 24 }) * 0.7 +
        Math.abs(fbm(u * f(4), v * f(4), seed + 41, { octaves: 2, period: 32 }) - 0.5) * 0.6;
    case 'glass':
    case 'car_paint':
      return fbm(u * s, v * s, seed, { octaves: 2, period: 32 });
    default:
      return fbm(u * s, v * s, seed, { octaves: 5, period: 32 });
  }
}

/** Wear mask: where paint has chipped, metal has scratched, fabric has worn. */
function wearAt(recipe: MaterialRecipe, u: number, v: number, seed: number): number {
  if (recipe.wear <= 0) return 0;
  const broad = fbm(u * 5, v * 5, seed + 101, { octaves: 4, period: 16 });
  const scratches = Math.abs(fbm(u * 90, v * 12, seed + 211, { octaves: 2, period: 64 }) - 0.5) * 2;
  const mask = Math.max(0, broad - (1 - recipe.wear)) / Math.max(1e-3, recipe.wear);
  return Math.min(1, mask * 0.75 + (1 - scratches) * recipe.wear * 0.35);
}

function albedoAt(recipe: MaterialRecipe, height: number, wear: number, base: Rgb, secondary: Rgb): Rgb {
  const hsl = rgbToHsl(base);
  switch (recipe.family) {
    case 'car_paint': {
      // Metallic flake: tiny lightness variation, no hue shift.
      const flake = (height - 0.5) * 0.06;
      const painted = hslToRgb({ h: hsl.h, s: hsl.s, l: Math.max(0.02, Math.min(0.98, hsl.l + flake)) });
      return mix(painted, secondary, wear * 0.8);
    }
    case 'grass': {
      const blade = hslToRgb({ h: hsl.h + (height - 0.5) * 18, s: hsl.s * (0.8 + height * 0.4), l: hsl.l * (0.7 + height * 0.6) });
      return mix(blade, secondary, wear * 0.4);
    }
    case 'skin': {
      // Real skin varies by a few percent in lightness across a face and hardly
      // at all in hue. The previous swing — 12% lightness, 8 degrees of hue —
      // is what produced the mottled, bruised look; the variation belongs in
      // roughness, where sebum and dry patches actually live.
      const flush = hslToRgb({
        h: hsl.h - 1.5 + height * 3,
        s: hsl.s * (0.97 + height * 0.06),
        l: hsl.l * (0.985 + height * 0.03),
      });
      return flush;
    }
    case 'emissive_panel':
      return mix(base, secondary, height);
    default: {
      const shaded = hslToRgb({ h: hsl.h, s: hsl.s * (0.85 + height * 0.3), l: Math.max(0.02, Math.min(0.98, hsl.l * (0.65 + height * 0.7))) });
      return mix(shaded, secondary, wear);
    }
  }
}

export interface TextureSetOptions {
  readonly size?: number;
  readonly seed: number;
}

export function generateTextureSet(recipe: MaterialRecipe, options: TextureSetOptions): TextureSet {
  const size = options.size ?? 512;
  const seed = (options.seed ^ seedFrom(recipe.family + recipe.baseColor)) >>> 0;
  const rng = new Rng(seed);
  const base = parseHex(recipe.baseColor);
  const secondary = recipe.secondaryColor
    ? parseHex(recipe.secondaryColor)
    : hslToRgb({ ...rgbToHsl(base), l: Math.max(0.05, rgbToHsl(base).l * 0.45), s: rgbToHsl(base).s * 0.5 });

  // The highest frequency a map of this size can carry, at four texels per
  // cycle. Everything the height field builds is held under it.
  const limit = size / 4;

  // Families whose pattern is periodic alias hardest, because a regular grid
  // beating against the texel grid produces a low-frequency artefact that looks
  // deliberate — the corduroy stripes on a woven jacket. Averaging four
  // sub-samples per texel costs four times the height evaluations and is spent
  // only where it buys something.
  const PERIODIC: ReadonlySet<MaterialFamily> = new Set(['fabric', 'metal_brushed', 'hair', 'leather']);
  const subSamples = PERIODIC.has(recipe.family) ? 2 : 1;
  const step = 1 / (size * subSamples);

  const heights = new Float32Array(size * size);
  const wear = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      const index = y * size + x;
      let total = 0;
      for (let sy = 0; sy < subSamples; sy += 1) {
        for (let sx = 0; sx < subSamples; sx += 1) {
          total += heightAt(recipe, u + sx * step, v + sy * step, seed, limit);
        }
      }
      heights[index] = total / (subSamples * subSamples);
      wear[index] = wearAt(recipe, u, v, seed);
    }
  }

  const albedo = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const orm = new Uint8Array(size * size * 4);
  const emissive = recipe.emissiveStrength ? new Uint8Array(size * size * 4) : null;

  const sample = (x: number, y: number): number => heights[((y + size) % size) * size + ((x + size) % size)] as number;

  const sobelX = (x: number, y: number): number =>
    sample(x + 1, y - 1) + 2 * sample(x + 1, y) + sample(x + 1, y + 1) -
    (sample(x - 1, y - 1) + 2 * sample(x - 1, y) + sample(x - 1, y + 1));
  const sobelY = (x: number, y: number): number =>
    sample(x - 1, y + 1) + 2 * sample(x, y + 1) + sample(x + 1, y + 1) -
    (sample(x - 1, y - 1) + 2 * sample(x, y - 1) + sample(x + 1, y - 1));

  // The Sobel response depends on both the map's resolution and the frequency
  // of whatever the height field happened to build, so a fixed coefficient bakes
  // normals that are eight times too strong at one scale and invisible at
  // another — pores at 1024px came out as gouges. Measuring the field's own mean
  // gradient and normalising against it makes `relief` mean one thing: how far
  // the surface tilts, whatever the material and whatever the resolution.
  let gradientTotal = 0;
  let gradientCount = 0;
  const stride = Math.max(1, Math.floor(size / 128));
  for (let y = 0; y < size; y += stride) {
    for (let x = 0; x < size; x += stride) {
      gradientTotal += Math.hypot(sobelX(x, y), sobelY(x, y));
      gradientCount += 1;
    }
  }
  const meanGradient = gradientCount > 0 ? gradientTotal / gradientCount : 0;
  const strength = meanGradient > 1e-6 ? (recipe.relief * 2) / meanGradient : 0;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = y * size + x;
      const height = heights[index] as number;
      const worn = wear[index] as number;

      const colour = albedoAt(recipe, height, worn, base, secondary);
      albedo[index * 4] = clamp255(colour.r);
      albedo[index * 4 + 1] = clamp255(colour.g);
      albedo[index * 4 + 2] = clamp255(colour.b);
      albedo[index * 4 + 3] = 255;

      // Sobel gradient of the height field → tangent-space normal.
      const dx = sobelX(x, y);
      const dy = sobelY(x, y);
      const nx = -dx * strength;
      const ny = -dy * strength;
      const nz = 1;
      const inv = 1 / Math.hypot(nx, ny, nz);
      normal[index * 4] = clamp255((nx * inv * 0.5 + 0.5) * 255);
      normal[index * 4 + 1] = clamp255((ny * inv * 0.5 + 0.5) * 255);
      normal[index * 4 + 2] = clamp255((nz * inv * 0.5 + 0.5) * 255);
      normal[index * 4 + 3] = 255;

      // Cavities darken occlusion; wear raises roughness and, on painted metal,
      // exposes the substrate so metallic rises where the coat has gone.
      const cavity = Math.max(0, 0.5 - height) * 2;
      const occlusion = 1 - cavity * (0.35 + recipe.relief * 1.6);
      // Roughness carries the variation the albedo no longer does. Skin is the
      // clearest case: an even matte face is a mannequin, and what makes it
      // read as skin is that the nose and forehead are slicker than the cheeks.
      const roughnessBreakup = recipe.family === 'skin' ? 0.3 : 0.12;
      const roughness = Math.max(
        0.02,
        Math.min(1, recipe.roughness + worn * 0.35 + (height - 0.5) * roughnessBreakup),
      );
      const metallic =
        recipe.family === 'car_paint'
          ? Math.max(0, Math.min(1, recipe.metallic + worn * 0.5))
          : Math.max(0, Math.min(1, recipe.metallic - worn * 0.25));
      orm[index * 4] = clamp255(occlusion * 255);
      orm[index * 4 + 1] = clamp255(roughness * 255);
      orm[index * 4 + 2] = clamp255(metallic * 255);
      orm[index * 4 + 3] = 255;

      if (emissive) {
        const glow = Math.max(0, height - 0.45) / 0.55;
        const lit = mix({ r: 0, g: 0, b: 0 }, colour, glow);
        emissive[index * 4] = clamp255(lit.r);
        emissive[index * 4 + 1] = clamp255(lit.g);
        emissive[index * 4 + 2] = clamp255(lit.b);
        emissive[index * 4 + 3] = 255;
      }
    }
  }

  void rng;
  return {
    albedo: encodePng(size, size, albedo),
    normal: encodePng(size, size, normal),
    orm: encodePng(size, size, orm),
    emissive: emissive ? encodePng(size, size, emissive) : undefined,
    size,
    recipe,
  };
}

function clamp255(value: number): number {
  return Math.max(0, Math.min(255, Math.round(value)));
}

/** Converts a hex colour to the linear RGBA factor glTF materials expect. */
export function linearFactor(hex: string, alpha = 1): [number, number, number, number] {
  const { r, g, b } = parseHex(hex);
  const toLinear = (c: number): number => {
    const n = c / 255;
    return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4;
  };
  return [toLinear(r), toLinear(g), toLinear(b), alpha];
}
