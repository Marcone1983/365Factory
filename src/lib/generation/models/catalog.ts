import { writeGlb, validateGlb, type GlbInput, type GlbTexture, type GltfMaterial } from '@/lib/graphics/gltf';
import { generateTextureSet, linearFactor, recipeFor, type MaterialFamily } from '../pbr';
import { Rng, seedFrom } from '@/lib/util/random';
import { generateCharacter, CHARACTER_MATERIALS, type CharacterRequest } from './character';
import { generateVehicle, VEHICLE_MATERIALS, type VehicleRequest } from './vehicle';
import { generateTrack, TRACK_MATERIALS, type TrackRequest, type GeneratedTrack } from './track';
import { generateWeapon, WEAPON_MATERIALS, type WeaponRequest } from './weapon';
import { generateBouquet, FLOWER_MATERIALS, type BouquetRequest } from './flowers';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('generation.models');

/**
 * Model catalogue.
 *
 * Turns a high-level asset request into a complete, textured, validated GLB:
 * geometry from the subdivision generators, a PBR material set from the texture
 * synthesiser, and — for gameplay-bearing assets like tracks — the structured
 * data the game code needs alongside the mesh.
 *
 * Every model class declares its own material assignment, so a car gets clearcoat
 * paint, rubber and chrome while a character gets skin, hair and fabric. That
 * mapping is what stops every generated asset from looking like the same plastic.
 */

export type ModelKind = 'character' | 'vehicle' | 'track' | 'weapon' | 'bouquet';

export interface ModelRequest {
  readonly kind: ModelKind;
  readonly name: string;
  readonly seed: number;
  /** Brand or scene palette; drives the material colours. */
  readonly palette: readonly string[];
  readonly textureSize?: number;
  readonly smoothness?: number;
  readonly character?: Omit<CharacterRequest, 'name' | 'seed'>;
  readonly vehicle?: Omit<VehicleRequest, 'name' | 'seed'>;
  readonly track?: Omit<TrackRequest, 'name' | 'seed'>;
  readonly weapon?: Omit<WeaponRequest, 'name' | 'seed'>;
  readonly bouquet?: Omit<BouquetRequest, 'name' | 'seed'>;
}

export interface GeneratedModel {
  readonly glb: Buffer;
  readonly kind: ModelKind;
  readonly name: string;
  /**
   * Triangles stored in the file. This is what determines download size and GPU
   * memory, and it is the number a GLB inspector reports.
   */
  readonly triangleCount: number;
  /**
   * Triangles submitted per frame with every node instance counted. A vehicle
   * stores one wheel mesh and instances it at four nodes, so it draws
   * substantially more than it stores; this is the number that governs frame
   * time, and it is what the triangle budget is checked against.
   */
  readonly renderedTriangleCount: number;
  readonly textureCount: number;
  readonly materialCount: number;
  readonly warnings: readonly string[];
  /** Structured gameplay data, present for assets that carry it (tracks). */
  readonly gameplay?: Record<string, unknown>;
}

interface SlotSpec {
  readonly slot: number;
  readonly name: string;
  readonly family: MaterialFamily;
  readonly colorIndex: number;
  readonly textured: boolean;
  /**
   * Texture resolution for this slot, relative to the model's base size. Small
   * or rarely-seen surfaces get less: a 512px map for a character's eyes costs
   * as much as one for the whole body and is never seen at that density.
   */
  readonly textureScale?: number;
  readonly overrides?: Partial<{ metallic: number; roughness: number; clearcoat: number; transmission: number; emissiveStrength: number }>;
}

const SLOTS: Record<ModelKind, readonly SlotSpec[]> = {
  character: [
    { slot: CHARACTER_MATERIALS.skin, name: 'skin', family: 'skin', colorIndex: 4, textured: true, textureScale: 1 },
    { slot: CHARACTER_MATERIALS.hair, name: 'hair', family: 'hair', colorIndex: 5, textured: true, textureScale: 0.5 },
    { slot: CHARACTER_MATERIALS.garment, name: 'garment', family: 'fabric', colorIndex: 0, textured: true, textureScale: 1 },
    { slot: CHARACTER_MATERIALS.accent, name: 'accent', family: 'leather', colorIndex: 1, textured: true, textureScale: 0.5 },
    { slot: CHARACTER_MATERIALS.eyes, name: 'eyes', family: 'glass', colorIndex: 2, textured: false, overrides: { roughness: 0.08 } },
  ],
  vehicle: [
    { slot: VEHICLE_MATERIALS.paint, name: 'paint', family: 'car_paint', colorIndex: 0, textured: true, overrides: { clearcoat: 1 } },
    { slot: VEHICLE_MATERIALS.glass, name: 'glass', family: 'glass', colorIndex: 3, textured: false, overrides: { transmission: 0.88, roughness: 0.04 } },
    { slot: VEHICLE_MATERIALS.tyre, name: 'tyre', family: 'rubber', colorIndex: 6, textured: true, textureScale: 0.5 },
    { slot: VEHICLE_MATERIALS.trim, name: 'trim', family: 'metal_brushed', colorIndex: 2, textured: true, textureScale: 0.5 },
    { slot: VEHICLE_MATERIALS.lights, name: 'lights', family: 'emissive_panel', colorIndex: 1, textured: true, textureScale: 0.25, overrides: { emissiveStrength: 6 } },
  ],
  track: [
    { slot: TRACK_MATERIALS.asphalt, name: 'asphalt', family: 'asphalt', colorIndex: 6, textured: true },
    { slot: TRACK_MATERIALS.kerb, name: 'kerb', family: 'concrete', colorIndex: 1, textured: true, textureScale: 0.5 },
    { slot: TRACK_MATERIALS.barrier, name: 'barrier', family: 'metal_worn', colorIndex: 2, textured: true, textureScale: 0.5 },
    { slot: TRACK_MATERIALS.runoff, name: 'runoff', family: 'sand', colorIndex: 7, textured: true, textureScale: 0.5 },
    { slot: TRACK_MATERIALS.markings, name: 'markings', family: 'concrete', colorIndex: 3, textured: false },
  ],
  // Indices 4-7 of the extended palette are skin, hair and neutrals, reserved
  // for characters. Foliage must draw from the caller's own palette entries or
  // it comes out flesh-coloured.
  bouquet: [
    { slot: FLOWER_MATERIALS.petal, name: 'petal', family: 'fabric', colorIndex: 0, textured: true, textureScale: 0.5, overrides: { roughness: 0.58 } },
    { slot: FLOWER_MATERIALS.stem, name: 'stem', family: 'fabric', colorIndex: 1, textured: true, textureScale: 0.25, overrides: { roughness: 0.72 } },
    { slot: FLOWER_MATERIALS.leaf, name: 'leaf', family: 'fabric', colorIndex: 1, textured: true, textureScale: 0.5, overrides: { roughness: 0.5 } },
    { slot: FLOWER_MATERIALS.centre, name: 'centre', family: 'fabric', colorIndex: 3, textured: true, textureScale: 0.25, overrides: { roughness: 0.85 } },
  ],
  weapon: [
    { slot: WEAPON_MATERIALS.body, name: 'body', family: 'metal_worn', colorIndex: 2, textured: true },
    { slot: WEAPON_MATERIALS.grip, name: 'grip', family: 'leather', colorIndex: 6, textured: true, textureScale: 0.5 },
    { slot: WEAPON_MATERIALS.accent, name: 'accent', family: 'metal_brushed', colorIndex: 1, textured: true, textureScale: 0.5 },
    { slot: WEAPON_MATERIALS.emissive, name: 'emissive', family: 'emissive_panel', colorIndex: 0, textured: true, textureScale: 0.25, overrides: { emissiveStrength: 8 } },
  ],
};

/** Extends a brand palette with the neutral tones models need (skin, rubber, sand). */
function extendPalette(palette: readonly string[], seed: number): string[] {
  const rng = new Rng(seed ^ 0x9e37);
  const base = palette.length > 0 ? [...palette] : ['#6ea8fe', '#8f7bff', '#c9d3e6', '#1b2233'];
  while (base.length < 4) base.push(base[base.length - 1] as string);
  const skinTones = ['#f0c8a8', '#d9a377', '#a9713f', '#7a4a26', '#e8b98f', '#5c3620'];
  const hairTones = ['#2a2118', '#4a3524', '#7d5a33', '#c8b18a', '#1c1c1e', '#8a3d2a'];
  return [
    base[0] as string,
    base[1] as string,
    base[2] as string,
    base[3] as string,
    rng.pick(skinTones),
    rng.pick(hairTones),
    '#22242a',
    '#c2b08a',
  ];
}

interface BuiltGeometry {
  readonly input: Omit<GlbInput, 'materials' | 'textures' | 'generator'>;
  /** Per-frame triangle count with node instancing counted; see GeneratedModel. */
  readonly renderedTriangleCount: number;
  readonly gameplay?: Record<string, unknown>;
}

function buildGeometry(request: ModelRequest): BuiltGeometry {
  switch (request.kind) {
    case 'character': {
      const model = generateCharacter({ name: request.name, seed: request.seed, smoothness: request.smoothness, ...request.character });
      return {
        input: { meshes: model.meshes, nodes: model.nodes, skins: model.skins, animations: model.animations, roots: [0, 1] },
        renderedTriangleCount: model.triangleCount,
        gameplay: { joints: model.skeleton.joints.map((j) => j.name), animations: model.animations.map((a) => a.name) },
      };
    }
    case 'vehicle': {
      const model = generateVehicle({ name: request.name, seed: request.seed, smoothness: request.smoothness, ...request.vehicle });
      return {
        input: { meshes: model.meshes, nodes: model.nodes },
        renderedTriangleCount: model.triangleCount,
        gameplay: { dimensions: model.dimensions, vehicleClass: model.vehicleClass, wheelNodes: ['wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'] },
      };
    }
    case 'track': {
      const model = generateTrack({ name: request.name, seed: request.seed, ...request.track });
      return {
        input: { meshes: model.meshes, nodes: model.nodes },
        renderedTriangleCount: model.triangleCount,
        gameplay: trackGameplayData(model),
      };
    }
    case 'bouquet': {
      const model = generateBouquet({ name: request.name, seed: request.seed, smoothness: request.smoothness, ...request.bouquet });
      return {
        input: { meshes: model.meshes, nodes: model.nodes },
        renderedTriangleCount: model.triangleCount,
        gameplay: { species: model.species, stems: model.stems },
      };
    }
    case 'weapon':
    default: {
      const model = generateWeapon({ name: request.name, seed: request.seed, smoothness: request.smoothness, ...request.weapon });
      return {
        input: { meshes: model.meshes, nodes: model.nodes },
        renderedTriangleCount: model.triangleCount,
        gameplay: { family: model.family, muzzleOffset: model.muzzleOffset, gripOffset: model.gripOffset, overallLength: model.overallLength },
      };
    }
  }
}

function trackGameplayData(model: GeneratedTrack): Record<string, unknown> {
  return {
    style: model.style,
    lapLength: Number(model.lapLength.toFixed(1)),
    startPosition: model.startPosition,
    startForward: model.startForward,
    checkpoints: model.checkpoints.map((c) => ({
      index: c.index,
      position: { x: Number(c.position.x.toFixed(2)), y: Number(c.position.y.toFixed(2)), z: Number(c.position.z.toFixed(2)) },
      forward: { x: Number(c.forward.x.toFixed(4)), y: Number(c.forward.y.toFixed(4)), z: Number(c.forward.z.toFixed(4)) },
      width: Number(c.width.toFixed(2)),
      distance: Number(c.distance.toFixed(1)),
    })),
    corners: model.corners,
    // The racing line is downsampled: a game needs a drivable path, not every sample.
    racingLine: model.racingLine
      .filter((_point, index) => index % 3 === 0)
      .map((p) => ({ x: Number(p.x.toFixed(2)), y: Number(p.y.toFixed(2)), z: Number(p.z.toFixed(2)) })),
    centreLineWidths: model.centreLine.filter((_n, i) => i % 6 === 0).map((n) => Number(n.width.toFixed(2))),
  };
}

const TRIANGLE_BUDGETS: Record<ModelKind, number> = {
  character: 90_000,
  vehicle: 140_000,
  track: 400_000,
  weapon: 60_000,
  bouquet: 260_000,
};

export function generateModel(request: ModelRequest): GeneratedModel {
  const palette = extendPalette(request.palette, request.seed);
  const geometry = buildGeometry(request);
  const slots = SLOTS[request.kind];
  const textureSize = request.textureSize ?? (request.kind === 'track' ? 512 : 512);

  const textures: GlbTexture[] = [];
  const materials: GltfMaterial[] = [];

  for (const slot of slots) {
    const color = palette[slot.colorIndex] ?? (palette[0] as string);
    const recipe = recipeFor(slot.family, color, slot.overrides ?? {});
    const material: Record<string, unknown> = {
      name: `${request.name}_${slot.name}`,
      baseColor: linearFactor(color, slot.family === 'glass' ? 0.62 : 1),
      metallic: recipe.metallic,
      roughness: recipe.roughness,
      doubleSided: false,
    };

    if (slot.textured) {
      const slotSize = Math.max(64, Math.round((textureSize * (slot.textureScale ?? 1)) / 64) * 64);
      const set = generateTextureSet(recipe, { seed: (request.seed ^ seedFrom(slot.name)) >>> 0, size: slotSize });
      const albedoIndex = textures.push({ name: `${slot.name}_albedo`, png: set.albedo, srgb: true }) - 1;
      const normalIndex = textures.push({ name: `${slot.name}_normal`, png: set.normal, srgb: false }) - 1;
      const ormIndex = textures.push({ name: `${slot.name}_orm`, png: set.orm, srgb: false }) - 1;
      material.baseColorTexture = { texture: albedoIndex };
      material.normalTexture = { texture: normalIndex, scale: 1 };
      material.metallicRoughnessTexture = { texture: ormIndex };
      material.occlusionTexture = { texture: ormIndex };
      if (set.emissive) {
        const emissiveIndex = textures.push({ name: `${slot.name}_emissive`, png: set.emissive, srgb: true }) - 1;
        material.emissiveTexture = { texture: emissiveIndex };
        material.emissive = linearFactor(color).slice(0, 3);
        material.emissiveStrength = recipe.emissiveStrength ?? 2;
      }
    }

    if (recipe.clearcoat) material.clearcoat = recipe.clearcoat;
    if (recipe.transmission) {
      material.transmission = recipe.transmission;
      material.ior = 1.5;
      material.alphaMode = 'BLEND';
    }
    materials.push(material as unknown as GltfMaterial);
  }

  const glb = writeGlb({
    generator: `Autonomous Daily App Factory · ${request.kind} synthesiser`,
    ...geometry.input,
    materials,
    textures,
  });

  const validation = validateGlb(glb, { requireUvs: true });
  const problems = [...validation.problems];

  // The budget is a frame-time budget, so it is checked against the instanced
  // count rather than the stored one. Checking the stored count would let a
  // model that instances one mesh a hundred times pass while being unplayable.
  const budget = TRIANGLE_BUDGETS[request.kind];
  if (geometry.renderedTriangleCount > budget) {
    problems.push(
      `${geometry.renderedTriangleCount} rendered triangles exceeds the ${budget} budget for a ${request.kind}`,
    );
  }
  if (problems.length > 0) {
    log.warn('generated model exceeded its budget or failed validation', { name: request.name, problems });
  }

  return {
    glb,
    kind: request.kind,
    name: request.name,
    triangleCount: validation.summary?.triangles ?? 0,
    renderedTriangleCount: geometry.renderedTriangleCount,
    textureCount: textures.length,
    materialCount: materials.length,
    warnings: problems,
    gameplay: geometry.gameplay,
  };
}
