import crypto from 'node:crypto';
import { config } from '@/lib/config/env';
import { db, newId, nowIso, toJson } from '@/lib/db/client';
import { workspaceFor, type Project } from '@/lib/workspace/project';
import { getImageProvider, getModel3dProvider, getProceduralImageProvider } from '@/lib/providers/registry';
import { recordUsage } from '@/lib/ai/usage';
import { Rng, seedFrom } from '@/lib/util/random';
import { contrastRatio, hslToRgb, parseHex, toHex, type Rgb } from '@/lib/graphics/color';
import { readPngInfo } from '@/lib/graphics/png';
import { coverResizePng, resizePng, roundedMaskPng } from '@/lib/graphics/image-ops';
import { inspectGlb, writeGlb } from '@/lib/graphics/gltf';
import { generateMesh, type MeshArchetype } from './meshes';
import { generateModel, type ModelKind } from './models/catalog';
import { generateReviewedAsset } from './review/loop';
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

/** High-fidelity model classes routed to the subdivision-surface generators. */
const HIGH_FIDELITY: Readonly<Record<string, ModelKind>> = {
  character: 'character',
  creature: 'character',
  avatar: 'character',
  vehicle: 'vehicle',
  car: 'vehicle',
  track: 'track',
  circuit: 'track',
  weapon: 'weapon',
};

export interface MeshBrief {
  readonly name: string;
  readonly archetype: MeshArchetype | ModelKind | 'avatar' | 'car' | 'circuit';
  readonly complexity?: number;
  /** Passed through to the specialised generator (vehicle class, track style…). */
  readonly params?: Record<string, unknown>;
  /**
   * Art direction for the generative-3D service. Written by the asset agent from
   * the product concept; when present and a service is configured, this is the
   * preferred way to obtain the model.
   */
  readonly prompt?: string;
}

/** How a mesh brief is filed in the recipe library, so like is compared with like. */
function recipeCategory(archetype: string): string {
  const kind = HIGH_FIDELITY[archetype];
  if (kind === 'character') return 'character';
  if (kind === 'vehicle') return 'vehicle';
  if (kind === 'weapon') return 'weapon';
  if (kind === 'track') return 'track';
  return archetype === 'building' || archetype === 'prop' ? archetype : 'prop';
}

interface AuthoredMesh {
  readonly glb: Buffer;
  readonly generator: string;
  readonly accepted: boolean;
  readonly validation: Record<string, unknown>;
}

/**
 * Runs the authored-recipe pipeline for one mesh brief.
 *
 * Returns null rather than throwing whenever the pipeline cannot deliver, so
 * the caller falls through to the next real path. Two distinct reasons produce
 * a null and both are logged as what they are: the pipeline was unavailable
 * (no model configured, no browser to render with, a build that never
 * succeeded), or it produced something its own critic rejected while a
 * specialised generator exists for this archetype and will do better.
 */
async function generateAuthoredMesh(
  project: Project,
  brief: MeshBrief,
  palette: readonly string[],
  seed: number,
): Promise<AuthoredMesh | null> {
  const started = Date.now();
  const category = recipeCategory(brief.archetype as string);
  const cfg = config();

  try {
    const result = await generateReviewedAsset({
      request: {
        request: brief.prompt as string,
        productContext: project.name,
        usage: `${brief.archetype} asset for ${project.name}`,
        palette,
      },
      palette,
      seed,
      category,
      maxRepairs: cfg.RECIPE_REVIEW_ROUNDS,
      passMark: cfg.RECIPE_PASS_MARK,
      context: { projectId: project.id },
    });

    const { best } = result;
    const validation: Record<string, unknown> = {
      ...inspectGlb(best.asset.glb),
      recipeId: result.recipeId,
      recipeName: best.recipe.name,
      reviewScore: best.verdict.score,
      reviewSummary: best.verdict.summary,
      reviewRounds: result.rounds,
      reusedFromLibrary: result.reused,
      accepted: result.accepted,
      failedCriteria: best.verdict.criteria.filter((entry) => !entry.passed).map((entry) => entry.criterion),
      steps: best.recipe.steps.length,
      warnings: best.asset.warnings,
    };

    recordGeneration(
      project,
      `recipe:${category}`,
      'internal',
      'recipe-interpreter',
      result.accepted ? 'succeeded' : 'failed',
      0,
      Date.now() - started,
      result.accepted ? null : `the critic scored it ${Math.round(best.verdict.score)}, below the pass mark`,
    );

    // A rejected asset is not shipped when a specialised generator exists for
    // this archetype: that generator is known to produce a correct shape, and
    // handing over something the critic said does not read as the requested
    // object would be shipping a failure quietly.
    if (!result.accepted && HIGH_FIDELITY[brief.archetype as string]) {
      log.warn('the authored recipe did not pass review; falling through to the specialised generator', {
        asset: brief.name,
        score: best.verdict.score,
        failures: best.failures.slice(0, 3),
      });
      return null;
    }

    emitEvent({
      type: 'asset.generated',
      scope: 'generation',
      message:
        `authored "${best.recipe.name}" from a recipe — scored ${Math.round(best.verdict.score)}/100` +
        (result.reused ? ' (reused from the library)' : ` after ${result.rounds} round(s)`),
      data: { asset: brief.name, score: best.verdict.score, reused: result.reused },
      projectId: project.id,
    });

    return {
      glb: best.asset.glb,
      generator: result.reused ? 'recipe:library' : 'recipe:authored',
      accepted: result.accepted,
      validation,
    };
  } catch (error) {
    const message = (error as Error).message;
    recordGeneration(project, `recipe:${category}`, 'internal', 'recipe-interpreter', 'failed', 0, Date.now() - started, message);
    log.warn('the authored-recipe pipeline is unavailable for this asset; trying the next path', {
      asset: brief.name,
      error: message,
    });
    return null;
  }
}

/**
 * Generates 3D assets.
 *
 * Characters, vehicles, tracks and weapons go through the subdivision-surface
 * generators, which produce smooth, PBR-textured, rigged models. Set dressing
 * (rocks, flora, generic props) uses the lightweight parametric path, where
 * faceted geometry is the correct artistic choice and the triangle budget
 * matters more than silhouette fidelity.
 */
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
    const name = slug(brief.name) || String(brief.archetype);
    const modelSeed = (seed ^ seedFrom(`${brief.archetype}:${brief.name}`)) >>> 0;
    const relativePath = `meshes/${name}.glb`;
    const highFidelity = HIGH_FIDELITY[brief.archetype as string];

    let glb: Buffer;
    let generator: string;
    let validation: Record<string, unknown>;

    // First choice: the platform's own authored-recipe pipeline. A model writes
    // the brief and the construction, the interpreter builds it, and a vision
    // critic checks the render against the brief before it is accepted. It is
    // preferred over an external service because the result is inspectable,
    // recolourable, stored as a few kilobytes of reusable JSON, and free the
    // second time it is asked for.
    if (config().RECIPE_PIPELINE && brief.prompt) {
      const authored = await generateAuthoredMesh(project, brief, palette, modelSeed);
      if (authored) {
        assets.write(relativePath, authored.glb);
        out.push(
          persist(project, {
            kind: 'mesh',
            name: brief.name,
            path: relativePath,
            mime: 'model/gltf-binary',
            width: 0,
            height: 0,
            bytes: authored.glb.length,
            sha256: crypto.createHash('sha256').update(authored.glb).digest('hex'),
            generator: authored.generator,
            validated: authored.accepted,
            validation: authored.validation,
          }),
        );
        continue;
      }
    }

    // Second choice: ask a generative-3D service for the asset. The coding
    // agent describes what it needs, the service synthesises it, and the GLB is
    // validated before it is accepted. On any failure the platform falls through
    // to its own subdivision generators rather than shipping nothing.
    const remote3d = getModel3dProvider();
    const remoteEligible = remote3d !== null && highFidelity !== 'track' && brief.prompt !== undefined;
    if (remoteEligible && remote3d) {
      const started = Date.now();
      try {
        const result = await remote3d.generate({
          prompt: brief.prompt as string,
          modelClass: (highFidelity === 'character' ? 'character' : highFidelity === 'vehicle' ? 'vehicle' : 'weapon') as never,
          style: 'realistic',
          pbr: true,
          seed: modelSeed,
          targetTriangles: config().MODEL3D_TRIANGLE_BUDGET,
        });
        recordUsage({
          provider: result.provider,
          kind: 'image',
          model: result.model,
          operation: 'text_to_3d',
          units: 1,
          costUsd: result.costUsd,
          latencyMs: result.latencyMs,
          projectId: project.id,
        });
        recordGeneration(project, `model3d:${brief.archetype}`, result.provider, result.model, 'succeeded', result.costUsd, result.latencyMs, null);
        assets.write(relativePath, result.glb);
        const summary = inspectGlb(result.glb);
        out.push(
          persist(project, {
            kind: 'mesh',
            name: brief.name,
            path: relativePath,
            mime: 'model/gltf-binary',
            width: 0,
            height: 0,
            bytes: result.glb.length,
            sha256: crypto.createHash('sha256').update(result.glb).digest('hex'),
            generator: `generative:${result.provider}:${result.model}`,
            validated: summary.meshes > 0 && summary.triangles > 0,
            validation: { ...summary, taskId: result.taskId, prompt: brief.prompt },
          }),
        );
        continue;
      } catch (error) {
        const message = (error as Error).message;
        recordGeneration(project, `model3d:${brief.archetype}`, remote3d.name, '', 'failed', 0, Date.now() - started, message);
        log.warn('generative 3D provider failed; falling back to the built-in generator', { asset: brief.name, error: message });
      }
    }

    if (highFidelity) {
      const model = generateModel({
        kind: highFidelity,
        name,
        seed: modelSeed,
        palette,
        smoothness: brief.complexity !== undefined ? Math.round(brief.complexity * 2) : undefined,
        character: highFidelity === 'character' ? (brief.params as never) : undefined,
        vehicle: highFidelity === 'vehicle' ? (brief.params as never) : undefined,
        track: highFidelity === 'track' ? (brief.params as never) : undefined,
        weapon: highFidelity === 'weapon' ? (brief.params as never) : undefined,
      });
      glb = model.glb;
      generator = `subdivision:${highFidelity}`;
      validation = {
        ...inspectGlb(glb),
        modelKind: highFidelity,
        warnings: model.warnings,
        textures: model.textureCount,
        // Stored triangles govern download size; rendered triangles govern frame
        // time. The coding agent needs the second to budget a scene, so both are
        // recorded rather than one standing in for the other.
        renderedTriangles: model.renderedTriangleCount,
      };
      // Gameplay data (track layout, vehicle dimensions, rig joints) travels with
      // the mesh so the coding agent can consume it without parsing geometry.
      if (model.gameplay) {
        const dataPath = `meshes/${name}.json`;
        const payload = Buffer.from(JSON.stringify(model.gameplay, null, 2), 'utf8');
        assets.write(dataPath, payload);
        out.push(
          persist(project, {
            kind: 'model_data',
            name: `${brief.name} data`,
            path: dataPath,
            mime: 'application/json',
            width: 0,
            height: 0,
            bytes: payload.length,
            sha256: crypto.createHash('sha256').update(payload).digest('hex'),
            generator,
            validated: true,
            validation: { keys: Object.keys(model.gameplay) },
          }),
        );
      }
    } else {
      const mesh = generateMesh({
        archetype: brief.archetype as MeshArchetype,
        name,
        seed: modelSeed,
        complexity: brief.complexity,
        palette,
      });
      glb = writeGlb({
        generator: 'Autonomous Daily App Factory parametric mesh synthesiser',
        meshes: [{ name, primitives: mesh.primitives }],
        materials: mesh.materials,
      });
      generator = `parametric:${brief.archetype}`;
      validation = { ...inspectGlb(glb), archetype: brief.archetype };
    }

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
        generator,
        validated: summary.meshes > 0 && summary.triangles > 0,
        validation,
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
