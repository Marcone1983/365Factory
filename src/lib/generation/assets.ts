import crypto from 'node:crypto';
import { db, newId, nowIso, toJson } from '@/lib/db/client';
import { workspaceFor, type Project } from '@/lib/workspace/project';
import { getImageProvider, getProceduralImageProvider } from '@/lib/providers/registry';
import { recordUsage } from '@/lib/ai/usage';
import { Rng, seedFrom } from '@/lib/util/random';
import { contrastRatio, hslToRgb, parseHex, toHex, type Rgb } from '@/lib/graphics/color';
import { readPngInfo } from '@/lib/graphics/png';
import { coverResizePng, resizePng, roundedMaskPng } from '@/lib/graphics/image-ops';
import { inspectGlb, writeGlb } from '@/lib/graphics/gltf';
import { generateMesh, type MeshArchetype } from './meshes';
import { createLogger } from '@/lib/observability/logger';
import { emitEvent } from '@/lib/observability/events';
import type { BrandIdentity } from './scaffold';
import type { ImagePurpose } from '@/lib/providers/types';

const log = createLogger('generation.assets');

/**
 * Asset generation pipeline.
 *
 * Produces the complete, original visual identity and content set for a
 * product: brand palette, launcher icons at every Android density, maskable and
 * web icons, splash artwork, store graphics, tiling material textures and glTF
 * meshes. Everything is raster or 3D geometry — never vector clip-art standing
 * in for artwork — and everything is reproducible from the product seed.
 */

export interface AssetRecord {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly path: string;
  readonly mime: string;
  readonly width: number;
  readonly height: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly generator: string;
  readonly validated: boolean;
  readonly validation: Record<string, unknown>;
}

// ------------------------------------------------------------------ brand --

const FONT_STACKS: readonly string[] = [
  "'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  "'Sora', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  "ui-rounded, 'SF Pro Rounded', system-ui, 'Segoe UI', Roboto, sans-serif",
  "'IBM Plex Sans', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  "ui-serif, Georgia, 'Times New Roman', serif",
  "ui-monospace, 'JetBrains Mono', 'SFMono-Regular', Menlo, monospace",
];

/**
 * Derives a brand palette from the product's identity seed and verifies it
 * against WCAG contrast, so generated interfaces are legible rather than merely
 * decorative. If a sampled palette fails, it is rotated until it passes.
 */
export function deriveBrand(input: {
  name: string;
  tagline: string;
  tone: readonly string[];
  seed: number;
  dark?: boolean;
}): BrandIdentity {
  const rng = new Rng(input.seed);
  const dark = input.dark ?? true;

  for (let attempt = 0; attempt < 24; attempt += 1) {
    const hue = rng.float(0, 360);
    const scheme = rng.pick(['analogous', 'complementary', 'triad', 'split'] as const);
    const secondaryOffset = scheme === 'analogous' ? rng.float(20, 45) : scheme === 'complementary' ? 180 : scheme === 'triad' ? 120 : 150;
    const accentOffset = scheme === 'analogous' ? rng.float(-45, -20) : scheme === 'triad' ? 240 : rng.float(190, 215);

    const primary = hslToRgb({ h: hue, s: rng.float(0.62, 0.92), l: dark ? rng.float(0.56, 0.68) : rng.float(0.42, 0.52) });
    const secondary = hslToRgb({ h: hue + secondaryOffset, s: rng.float(0.45, 0.8), l: dark ? rng.float(0.48, 0.62) : rng.float(0.38, 0.5) });
    const accent = hslToRgb({ h: hue + accentOffset, s: rng.float(0.6, 0.95), l: dark ? rng.float(0.6, 0.72) : rng.float(0.44, 0.56) });
    const background = dark
      ? hslToRgb({ h: hue + rng.float(-12, 12), s: rng.float(0.16, 0.34), l: rng.float(0.055, 0.1) })
      : hslToRgb({ h: hue + rng.float(-12, 12), s: rng.float(0.08, 0.2), l: rng.float(0.95, 0.985) });
    const surface = dark
      ? hslToRgb({ h: hue, s: rng.float(0.14, 0.3), l: rng.float(0.12, 0.17) })
      : hslToRgb({ h: hue, s: rng.float(0.06, 0.16), l: rng.float(0.9, 0.95) });
    const text: Rgb = dark ? { r: 242, g: 245, b: 251 } : { r: 16, g: 20, b: 30 };

    const textOnBackground = contrastRatio(text, background);
    const primaryOnBackground = contrastRatio(primary, background);
    const accentOnSurface = contrastRatio(accent, surface);
    if (textOnBackground >= 12 && primaryOnBackground >= 3.5 && accentOnSurface >= 3) {
      return {
        name: input.name,
        tagline: input.tagline,
        primary: toHex(primary),
        secondary: toHex(secondary),
        accent: toHex(accent),
        background: toHex(background),
        surface: toHex(surface),
        text: toHex(text),
        fontStack: rng.pick(FONT_STACKS),
        toneKeywords: [...input.tone].slice(0, 6),
      };
    }
  }

  // Deterministic, contrast-safe fallback if sampling never converges.
  return {
    name: input.name,
    tagline: input.tagline,
    primary: '#6ea8fe',
    secondary: '#8f7bff',
    accent: '#39d3a4',
    background: '#0b0f1a',
    surface: '#151b2b',
    text: '#f2f5fb',
    fontStack: FONT_STACKS[0] as string,
    toneKeywords: [...input.tone].slice(0, 6),
  };
}

// ------------------------------------------------------------ persistence --

function persist(project: Project, record: Omit<AssetRecord, 'id'>): AssetRecord {
  const id = newId('ast');
  db()
    .prepare(
      `INSERT INTO assets (id, project_id, kind, name, path, mime, width, height, bytes, sha256, generator, params, validated, validation, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)
       ON CONFLICT(project_id, path) DO UPDATE SET
         sha256 = excluded.sha256, bytes = excluded.bytes, width = excluded.width, height = excluded.height,
         generator = excluded.generator, validated = excluded.validated, validation = excluded.validation`,
    )
    .run(
      id, project.id, record.kind, record.name, record.path, record.mime, record.width, record.height,
      record.bytes, record.sha256, record.generator, record.validated ? 1 : 0, toJson(record.validation), nowIso(),
    );
  emitEvent({
    type: 'asset.generated',
    scope: 'assets',
    projectId: project.id,
    message: `${record.kind}: ${record.path}`,
    data: { kind: record.kind, path: record.path, bytes: record.bytes, generator: record.generator },
  });
  return { id, ...record };
}

function writePngAsset(project: Project, relativePath: string, kind: string, data: Buffer, generator: string): AssetRecord {
  const assets = workspaceFor(project, 'assets');
  assets.write(relativePath, data);
  const info = readPngInfo(data);
  return persist(project, {
    kind,
    name: relativePath.split('/').pop() ?? relativePath,
    path: relativePath,
    mime: 'image/png',
    width: info.width,
    height: info.height,
    bytes: data.length,
    sha256: crypto.createHash('sha256').update(data).digest('hex'),
    generator,
    validated: info.width > 0 && info.height > 0 && info.colorType === 6,
    validation: { colorType: info.colorType, bitDepth: info.bitDepth },
  });
}

// ------------------------------------------------------------ brand assets --

/** Densities the Android resource pipeline and the web manifest both need. */
export const ICON_DENSITIES: ReadonlyArray<{ dir: string; size: number }> = [
  { dir: 'mdpi', size: 48 },
  { dir: 'hdpi', size: 72 },
  { dir: 'xhdpi', size: 96 },
  { dir: 'xxhdpi', size: 144 },
  { dir: 'xxxhdpi', size: 192 },
];

export interface BrandAssetResult {
  readonly assets: readonly AssetRecord[];
  readonly provider: string;
}

export async function generateBrandAssets(
  project: Project,
  brand: BrandIdentity,
  seed: number,
  context: { factoryRunId?: string } = {},
): Promise<BrandAssetResult> {
  const remote = getImageProvider();
  const procedural = getProceduralImageProvider();
  const palette = [brand.primary, brand.secondary, brand.accent, brand.surface];
  const assets: AssetRecord[] = [];

  const generate = async (purpose: ImagePurpose, prompt: string, width: number, height: number, useRemote: boolean): Promise<{ data: Buffer; generator: string }> => {
    const provider = useRemote && remote.name !== 'procedural' ? remote : procedural;
    const started = Date.now();
    try {
      const result = await provider.generate({ purpose, prompt, width, height, seed, palette });
      recordUsage({
        provider: provider.name,
        kind: 'image',
        model: result.model,
        operation: purpose,
        units: 1,
        costUsd: result.costUsd,
        latencyMs: result.latencyMs,
        projectId: project.id,
        factoryRunId: context.factoryRunId,
      });
      recordGeneration(project, purpose, provider.name, result.model, 'succeeded', result.costUsd, result.latencyMs, null);
      return { data: result.data, generator: `${provider.name}:${result.model}` };
    } catch (error) {
      const message = (error as Error).message;
      recordGeneration(project, purpose, provider.name, '', 'failed', 0, Date.now() - started, message);
      if (provider.name === 'procedural') throw error;
      log.warn('remote image generation failed; falling back to the procedural generator', { purpose, error: message });
      const fallback = await procedural.generate({ purpose, prompt, width, height, seed, palette });
      return { data: fallback.data, generator: `procedural:${fallback.model}` };
    }
  };

  const iconPrompt = `${brand.name} — ${brand.tagline}. Tone: ${brand.toneKeywords.join(', ')}.`;
  const masterIcon = await generate('app_icon', iconPrompt, 1024, 1024, true);
  assets.push(writePngAsset(project, 'icons/icon-1024.png', 'app_icon', masterIcon.data, masterIcon.generator));
  for (const size of [512, 192, 96]) {
    assets.push(writePngAsset(project, `icons/icon-${size}.png`, 'app_icon', resizePng(masterIcon.data, size, size), `${masterIcon.generator}+resample`));
  }
  // Maskable icons must survive a circular crop: inset the artwork to the safe zone.
  assets.push(
    writePngAsset(project, 'icons/icon-maskable-512.png', 'app_icon', roundedMaskPng(resizePng(masterIcon.data, 512, 512), 0.5), `${masterIcon.generator}+maskable`),
  );
  for (const density of ICON_DENSITIES) {
    assets.push(
      writePngAsset(project, `android/mipmap-${density.dir}/ic_launcher.png`, 'app_icon', resizePng(masterIcon.data, density.size, density.size), `${masterIcon.generator}+resample`),
    );
    assets.push(
      writePngAsset(
        project,
        `android/mipmap-${density.dir}/ic_launcher_round.png`,
        'app_icon',
        roundedMaskPng(resizePng(masterIcon.data, density.size, density.size), 0.5),
        `${masterIcon.generator}+round`,
      ),
    );
  }

  const logo = await generate('logo', `Wordmark for ${brand.name}. ${brand.tagline}`, 1024, 512, true);
  assets.push(writePngAsset(project, 'brand/logo.png', 'logo', logo.data, logo.generator));

  const splash = await generate('splash', `${brand.name}. ${brand.tagline}`, 1080, 1920, true);
  assets.push(writePngAsset(project, 'brand/splash-portrait.png', 'splash', splash.data, splash.generator));
  assets.push(writePngAsset(project, 'brand/splash-landscape.png', 'splash', coverResizePng(splash.data, 1920, 1080), `${splash.generator}+crop`));
  assets.push(writePngAsset(project, 'android/drawable/splash.png', 'splash', resizePng(splash.data, 720, 1280), `${splash.generator}+resample`));

  const promo = await generate('promo', `Store feature graphic for ${brand.name}: ${brand.tagline}`, 1024, 500, true);
  assets.push(writePngAsset(project, 'brand/feature-graphic.png', 'promo', promo.data, promo.generator));

  log.info('brand assets generated', { projectId: project.id, count: assets.length });
  return { assets, provider: remote.name };
}

function recordGeneration(
  project: Project,
  purpose: string,
  provider: string,
  model: string,
  status: string,
  costUsd: number,
  latencyMs: number,
  error: string | null,
): void {
  db()
    .prepare(
      `INSERT INTO asset_generations (id, project_id, request, provider, model, status, cost_usd, latency_ms, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(newId('agn'), project.id, toJson({ purpose }), provider, model, status, costUsd, latencyMs, error, nowIso());
}

// ---------------------------------------------------------------- textures --

export interface TextureBrief {
  readonly name: string;
  readonly description: string;
  readonly size?: number;
  readonly tileable?: boolean;
}

/**
 * Material textures are always generated procedurally: they must tile seamlessly
 * and be produced at an exact power-of-two size, which remote image models do
 * not guarantee.
 */
export async function generateTextures(
  project: Project,
  briefs: readonly TextureBrief[],
  brand: BrandIdentity,
  seed: number,
): Promise<AssetRecord[]> {
  const procedural = getProceduralImageProvider();
  const palette = [brand.primary, brand.secondary, brand.accent, brand.surface];
  const assets: AssetRecord[] = [];

  for (const [index, brief] of briefs.entries()) {
    const size = brief.size ?? 512;
    const result = await procedural.generate({
      purpose: 'texture',
      prompt: `${brief.name}: ${brief.description}`,
      width: size,
      height: size,
      seed: (seed ^ seedFrom(brief.name)) >>> 0,
      palette,
      tileable: brief.tileable ?? true,
    });
    assets.push(
      writePngAsset(project, `textures/${slug(brief.name) || `texture-${index}`}.png`, 'texture', result.data, `procedural:${result.model}`),
    );
  }
  return assets;
}

// ------------------------------------------------------------------ meshes --

export interface MeshBrief {
  readonly name: string;
  readonly archetype: MeshArchetype;
  readonly complexity?: number;
}

export async function generateMeshAssets(
  project: Project,
  briefs: readonly MeshBrief[],
  brand: BrandIdentity,
  seed: number,
): Promise<AssetRecord[]> {
  const assets = workspaceFor(project, 'assets');
  const palette = [brand.primary, brand.secondary, brand.accent, brand.surface];
  const out: AssetRecord[] = [];

  for (const brief of briefs) {
    const mesh = generateMesh({
      archetype: brief.archetype,
      name: slug(brief.name) || brief.archetype,
      seed: (seed ^ seedFrom(`${brief.archetype}:${brief.name}`)) >>> 0,
      complexity: brief.complexity,
      palette,
    });
    const glb = writeGlb({
      generator: 'Autonomous Daily App Factory parametric mesh synthesiser',
      primitives: mesh.primitives,
      materials: mesh.materials,
    });
    const relativePath = `meshes/${slug(brief.name) || brief.archetype}.glb`;
    assets.write(relativePath, glb);

    const summary = inspectGlb(glb);
    out.push(
      persist(project, {
        kind: 'mesh',
        name: brief.name,
        path: relativePath,
        mime: 'model/gltf-binary',
        width: 0,
        height: 0,
        bytes: glb.length,
        sha256: crypto.createHash('sha256').update(glb).digest('hex'),
        generator: `parametric:${brief.archetype}`,
        validated: summary.meshes > 0 && summary.triangles > 0,
        validation: { ...summary, archetype: brief.archetype },
      }),
    );
  }
  return out;
}

// -------------------------------------------------------------- validation --

export interface AssetValidationIssue {
  readonly path: string;
  readonly severity: 'error' | 'warning';
  readonly message: string;
}

export interface AssetValidationResult {
  readonly ok: boolean;
  readonly checked: number;
  readonly issues: readonly AssetValidationIssue[];
}

/** Re-reads every recorded asset from disk and verifies it is intact. */
export function validateAssets(project: Project, requiredPaths: readonly string[] = []): AssetValidationResult {
  const workspace = workspaceFor(project, 'assets');
  const rows = db()
    .prepare<[string], { path: string; sha256: string; kind: string; mime: string }>(
      'SELECT path, sha256, kind, mime FROM assets WHERE project_id = ?',
    )
    .all(project.id);
  const issues: AssetValidationIssue[] = [];

  for (const row of rows) {
    if (!workspace.exists(row.path)) {
      issues.push({ path: row.path, severity: 'error', message: 'recorded asset is missing from the workspace' });
      continue;
    }
    const data = workspace.readBuffer(row.path);
    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (hash !== row.sha256) {
      issues.push({ path: row.path, severity: 'error', message: 'asset bytes do not match the recorded checksum' });
      continue;
    }
    try {
      if (row.mime === 'image/png') readPngInfo(data);
      else if (row.mime === 'model/gltf-binary') {
        const summary = inspectGlb(data);
        if (summary.triangles === 0) issues.push({ path: row.path, severity: 'error', message: 'mesh contains no triangles' });
      }
    } catch (error) {
      issues.push({ path: row.path, severity: 'error', message: `asset failed format validation: ${(error as Error).message}` });
    }
  }

  for (const required of requiredPaths) {
    if (!workspace.exists(required)) {
      issues.push({ path: required, severity: 'error', message: 'required asset was never generated' });
    }
  }

  return { ok: issues.every((i) => i.severity !== 'error'), checked: rows.length, issues };
}

export function listAssets(projectId: string): AssetRecord[] {
  return db()
    .prepare<[string], {
      id: string; kind: string; name: string; path: string; mime: string; width: number; height: number;
      bytes: number; sha256: string; generator: string; validated: number; validation: string;
    }>('SELECT * FROM assets WHERE project_id = ? ORDER BY kind, path')
    .all(projectId)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      name: row.name,
      path: row.path,
      mime: row.mime,
      width: row.width,
      height: row.height,
      bytes: row.bytes,
      sha256: row.sha256,
      generator: row.generator,
      validated: row.validated === 1,
      validation: JSON.parse(row.validation) as Record<string, unknown>,
    }));
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

void parseHex;
