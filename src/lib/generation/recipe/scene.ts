import { writeGlb, validateGlb, type GlbNode, type GlbTexture, type GltfMaterial, type GltfTextureRef, type MeshPrimitiveData } from '@/lib/graphics/gltf';
import { createLogger } from '@/lib/observability/logger';
import { prepareAsset, type BuildOptions, type PreparedAsset } from './build';
import type { AssetRecipe } from './schema';

const log = createLogger('generation.recipe.scene');

/**
 * Several assets placed in one GLB.
 *
 * A car, a driver and a stretch of promenade are three separate modelling
 * problems: each one has its own brief, its own reviewer and its own repair
 * history, and forcing them into a single recipe would mean a single failure
 * anywhere sends the whole thing back. They are built apart and composed here.
 *
 * Composition is done with glTF nodes rather than by baking transforms into
 * vertices. That keeps each part addressable in the finished file — a game can
 * hide the driver, swap the car, or animate the wheels — and it keeps the
 * geometry bit-identical to what the reviewer looked at, so a part that passed
 * review cannot be silently deformed by being placed.
 */

export interface ScenePlacement {
  readonly recipe: AssetRecipe;
  /** Node name in the finished file. Defaults to the recipe's name. */
  readonly name?: string;
  /** Where the part's origin goes, in metres. */
  readonly translate?: readonly [number, number, number];
  /** Heading, in degrees about the vertical axis. */
  readonly rotateYDegrees?: number;
  readonly scale?: number | readonly [number, number, number];
  /**
   * Lower the part until its lowest vertex rests at `translate.y`.
   *
   * Recipes are authored about their own origin, and a recipe that centres its
   * bounding box will float or sink by half its height when placed by that
   * origin. Measuring is the only way to seat a part on a surface without the
   * author having to know what the surface is.
   */
  readonly seatOnGround?: boolean;
  /** Palette for this part only; defaults to the scene palette. */
  readonly palette?: readonly string[];
  readonly seed?: number;
}

export interface SceneOptions {
  readonly name: string;
  readonly placements: readonly ScenePlacement[];
  readonly palette: readonly string[];
  readonly seed?: number;
  readonly textureSize?: number;
  readonly occlusion?: BuildOptions['occlusion'];
}

export interface ScenePart {
  readonly name: string;
  readonly triangles: number;
  readonly materials: number;
  readonly textures: number;
  /** Where it ended up, after seating and scaling. */
  readonly translate: readonly [number, number, number];
  readonly sizeMetres: readonly [number, number, number];
  readonly warnings: readonly string[];
}

export interface BuiltScene {
  readonly glb: Buffer;
  readonly name: string;
  readonly triangleCount: number;
  readonly materialCount: number;
  readonly textureCount: number;
  readonly parts: readonly ScenePart[];
  readonly warnings: readonly string[];
  readonly durationMs: number;
}

/** The axis-aligned bounds of everything a prepared asset draws. */
function boundsOf(prepared: PreparedAsset): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  // Only the vertices an index actually reaches count: a primitive may carry a
  // shared position buffer covering the whole asset while drawing one material
  // group of it, and measuring the buffer would measure the other groups twice.
  for (const primitive of prepared.primitives) {
    for (const index of primitive.indices) {
      for (let axis = 0; axis < 3; axis += 1) {
        const value = primitive.positions[index * 3 + axis] as number;
        if (value < (min[axis] as number)) min[axis] = value;
        if (value > (max[axis] as number)) max[axis] = value;
      }
    }
  }
  if (!Number.isFinite(min[0])) return { min: [0, 0, 0], max: [0, 0, 0] };
  return { min, max };
}

/** Remaps every texture reference on a material by a fixed offset. */
function offsetTextures(material: GltfMaterial, offset: number): GltfMaterial {
  if (offset === 0) return material;
  const shift = (ref: GltfTextureRef | undefined): GltfTextureRef | undefined =>
    ref ? { ...ref, texture: ref.texture + offset } : undefined;

  const out: Record<string, unknown> = { ...material };
  for (const key of ['baseColorTexture', 'metallicRoughnessTexture', 'normalTexture', 'occlusionTexture', 'emissiveTexture'] as const) {
    const shifted = shift(material[key]);
    if (shifted) out[key] = shifted;
    else delete out[key];
  }
  return out as unknown as GltfMaterial;
}

function quaternionAboutY(degrees: number): [number, number, number, number] {
  const half = (degrees * Math.PI) / 360;
  return [0, Math.sin(half), 0, Math.cos(half)];
}

function scaleTriple(scale: ScenePlacement['scale']): [number, number, number] {
  if (scale === undefined) return [1, 1, 1];
  if (typeof scale === 'number') return [scale, scale, scale];
  return [scale[0] as number, scale[1] as number, scale[2] as number];
}

export function buildSceneFromRecipes(options: SceneOptions): BuiltScene {
  const started = Date.now();
  if (options.placements.length === 0) {
    throw new Error('a scene needs at least one placement');
  }

  const meshes: Array<{ name: string; primitives: MeshPrimitiveData[] }> = [];
  const materials: GltfMaterial[] = [];
  const textures: GlbTexture[] = [];
  const nodes: GlbNode[] = [];
  const parts: ScenePart[] = [];
  const warnings: string[] = [];

  for (const placement of options.placements) {
    const name = placement.name ?? placement.recipe.name;
    const prepared = prepareAsset(placement.recipe, {
      palette: placement.palette ?? options.palette,
      ...(placement.seed !== undefined
        ? { seed: placement.seed }
        : options.seed !== undefined
          ? { seed: options.seed }
          : {}),
      ...(options.textureSize !== undefined ? { textureSize: options.textureSize } : {}),
      ...(options.occlusion ? { occlusion: options.occlusion } : {}),
    });

    const materialOffset = materials.length;
    const textureOffset = textures.length;
    for (const material of prepared.materials) {
      materials.push(offsetTextures({ ...material, name: `${name}_${material.name}` }, textureOffset));
    }
    for (const texture of prepared.textures) {
      textures.push({ ...texture, name: `${name}_${texture.name}` });
    }

    meshes.push({
      name,
      primitives: prepared.primitives.map((primitive) => ({
        ...primitive,
        name: `${name}_${primitive.name}`,
        materialIndex: primitive.materialIndex + materialOffset,
      })),
    });

    const scale = scaleTriple(placement.scale);
    const requested = placement.translate ?? [0, 0, 0];
    const translate: [number, number, number] = [requested[0] as number, requested[1] as number, requested[2] as number];
    const { min, max } = boundsOf(prepared);
    if (placement.seatOnGround) {
      // The node scales before it translates, so the lift is the scaled height
      // of whatever sits below the origin.
      translate[1] = (requested[1] as number) - min[1] * (scale[1] as number);
    }

    const node: GlbNode = {
      name,
      mesh: meshes.length - 1,
      translation: translate,
      ...(placement.rotateYDegrees ? { rotation: quaternionAboutY(placement.rotateYDegrees) } : {}),
      ...(scale[0] !== 1 || scale[1] !== 1 || scale[2] !== 1 ? { scale } : {}),
    };
    nodes.push(node);

    parts.push({
      name,
      triangles: prepared.triangleCount,
      materials: prepared.materials.length,
      textures: prepared.textures.length,
      translate,
      sizeMetres: [
        (max[0] - min[0]) * (scale[0] as number),
        (max[1] - min[1]) * (scale[1] as number),
        (max[2] - min[2]) * (scale[2] as number),
      ],
      warnings: prepared.warnings,
    });
    for (const warning of prepared.warnings) warnings.push(`${name}: ${warning}`);
  }

  const glb = writeGlb({
    generator: 'Autonomous Daily App Factory · scene composer',
    meshes,
    materials,
    textures,
    nodes,
  });

  const validation = validateGlb(glb, { requireUvs: true });
  for (const problem of validation.problems) warnings.push(problem);
  if (warnings.length > 0) {
    log.warn('scene composed with warnings', { name: options.name, warnings: warnings.length });
  }

  return {
    glb,
    name: options.name,
    triangleCount: validation.summary?.triangles ?? parts.reduce((total, part) => total + part.triangles, 0),
    materialCount: materials.length,
    textureCount: textures.length,
    parts,
    warnings,
    durationMs: Date.now() - started,
  };
}
