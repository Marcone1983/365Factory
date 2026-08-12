import { writeGlb, validateGlb, type GlbTexture, type GltfMaterial, type MeshPrimitiveData } from '@/lib/graphics/gltf';
import { generateTextureSet, linearFactor, recipeFor } from '../pbr';
import { seedFrom } from '@/lib/util/random';
import { createLogger } from '@/lib/observability/logger';
import { interpretRecipe } from './interpreter';
import { bakeVertexOcclusion, occlusionToVertexColors } from '@/lib/graphics/occlusion';
import type { AssetRecipe } from './schema';

const log = createLogger('generation.recipe');

/**
 * Turns a recipe into a finished, textured, validated GLB.
 *
 * The recipe supplies geometry and names a material family per surface; the PBR
 * synthesiser produces the actual albedo, normal and ORM maps. A recipe cannot
 * supply texture data itself, which is what keeps every asset in a product
 * consistent with the product's palette instead of each one arriving with its
 * own idea of what red means.
 */

export interface BuiltAsset {
  readonly glb: Buffer;
  readonly name: string;
  readonly triangleCount: number;
  readonly materialCount: number;
  readonly textureCount: number;
  readonly warnings: readonly string[];
  readonly stats: {
    readonly steps: number;
    readonly vertices: number;
    readonly durationMs: number;
    /** How long the occlusion bake took, and how many rays it traced. */
    readonly occlusionMs: number;
    readonly occlusionRays: number;
  };
}

export interface BuildOptions {
  /** Colours the recipe's colorIndex values select from. */
  readonly palette: readonly string[];
  readonly seed?: number;
  readonly textureSize?: number;
  /**
   * Baked ambient occlusion. On by default: without it nothing darkens where two
   * surfaces meet and every asset reads as plastic, whatever its silhouette. Set
   * `samples` low for a draft and high for a hero asset; turning it off entirely
   * is for isolating a fault, not for saving time.
   */
  readonly occlusion?: { readonly enabled?: boolean; readonly samples?: number; readonly intensity?: number };
}

export function buildAssetFromRecipe(recipe: AssetRecipe, options: BuildOptions): BuiltAsset {
  const seed = options.seed ?? seedFrom(recipe.name);
  const result = interpretRecipe(recipe, { seed });

  const palette = options.palette.length > 0 ? options.palette : ['#8899aa'];
  const baseSize = options.textureSize ?? 512;

  const textures: GlbTexture[] = [];
  const materials: GltfMaterial[] = [];

  for (const id of result.materialOrder) {
    const declared = recipe.materials.find((material) => material.id === id);
    if (!declared) throw new Error(`material "${id}" vanished between validation and build`);

    const color = palette[declared.colorIndex % palette.length] ?? (palette[0] as string);
    const overrides: Record<string, number> = {};
    if (declared.roughness !== undefined) overrides.roughness = declared.roughness;
    if (declared.metallic !== undefined) overrides.metallic = declared.metallic;
    if (declared.clearcoat !== undefined) overrides.clearcoat = declared.clearcoat;
    if (declared.transmission !== undefined) overrides.transmission = declared.transmission;
    if (declared.emissiveStrength !== undefined) overrides.emissiveStrength = declared.emissiveStrength;

    const materialRecipe = recipeFor(declared.family, color, overrides);
    const material: Record<string, unknown> = {
      name: `${recipe.name}_${declared.id}`,
      baseColor: linearFactor(color, declared.family === 'glass' ? 0.62 : 1),
      metallic: materialRecipe.metallic,
      roughness: materialRecipe.roughness,
      doubleSided: false,
    };

    // Glass gets no maps: a transmissive surface with a noise normal map reads
    // as frosted, which is almost never what a recipe asking for glass wants.
    if (declared.family !== 'glass') {
      const size = Math.max(64, Math.round((baseSize * declared.textureScale) / 64) * 64);
      const set = generateTextureSet(materialRecipe, { seed: (seed ^ seedFrom(declared.id)) >>> 0, size });
      const albedo = textures.push({ name: `${declared.id}_albedo`, png: set.albedo, srgb: true }) - 1;
      const normal = textures.push({ name: `${declared.id}_normal`, png: set.normal, srgb: false }) - 1;
      const orm = textures.push({ name: `${declared.id}_orm`, png: set.orm, srgb: false }) - 1;
      material.baseColorTexture = { texture: albedo };
      material.normalTexture = { texture: normal, scale: 1 };
      material.metallicRoughnessTexture = { texture: orm };
      material.occlusionTexture = { texture: orm };
      if (set.emissive) {
        const emissive = textures.push({ name: `${declared.id}_emissive`, png: set.emissive, srgb: true }) - 1;
        material.emissiveTexture = { texture: emissive };
        material.emissive = linearFactor(color).slice(0, 3);
        material.emissiveStrength = materialRecipe.emissiveStrength ?? 2;
      }
    }

    if (materialRecipe.clearcoat) material.clearcoat = materialRecipe.clearcoat;
    if (materialRecipe.transmission) {
      material.transmission = materialRecipe.transmission;
      material.alphaMode = 'BLEND';
      material.ior = 1.45;
    }
    materials.push(material as unknown as GltfMaterial);
  }

  // Occlusion is baked once over the whole assembled mesh, not per material
  // group: a shadow does not stop at a material boundary, and the chin that
  // shadows the neck is skin shadowing fabric.
  let colors: Float32Array | undefined;
  let occlusionMs = 0;
  let occlusionRays = 0;
  if (options.occlusion?.enabled !== false) {
    const baked = bakeVertexOcclusion(
      result.triangulated.positions,
      result.triangulated.normals,
      result.triangulated.indices,
      {
        samples: options.occlusion?.samples ?? 64,
        ...(options.occlusion?.intensity !== undefined ? { intensity: options.occlusion.intensity } : {}),
      },
    );
    colors = occlusionToVertexColors(baked.occlusion);
    occlusionMs = baked.stats.durationMs;
    occlusionRays = baked.stats.rays;
  }

  const primitives: MeshPrimitiveData[] = result.triangulated.materialGroups.map((group) => ({
    name: `${recipe.name}_mat${group.material}`,
    positions: result.triangulated.positions,
    normals: result.triangulated.normals,
    uvs: result.triangulated.uvs,
    ...(colors ? { colors } : {}),
    indices: result.triangulated.indices.slice(group.start, group.start + group.count),
    materialIndex: group.material,
  }));

  const glb = writeGlb({
    generator: `Autonomous Daily App Factory · recipe interpreter`,
    meshes: [{ name: recipe.name, primitives }],
    materials,
    textures,
    nodes: [{ name: recipe.name, mesh: 0 }],
  });

  const validation = validateGlb(glb, { requireUvs: true });
  const warnings = [...result.warnings, ...validation.problems];
  if (warnings.length > 0) {
    log.warn('recipe produced warnings', { name: recipe.name, warnings });
  }

  return {
    glb,
    name: recipe.name,
    triangleCount: validation.summary?.triangles ?? result.triangleCount,
    materialCount: materials.length,
    textureCount: textures.length,
    warnings,
    stats: { ...result.stats, occlusionMs, occlusionRays },
  };
}
