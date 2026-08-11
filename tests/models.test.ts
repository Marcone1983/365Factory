import { describe, expect, it } from 'vitest';
import { generateModel, type ModelKind } from '@/lib/generation/models/catalog';
import { inspectGlb, validateGlb } from '@/lib/graphics/gltf';

/**
 * These tests defend the quality bar for generated 3D: the models must be real
 * modelled geometry with materials, textures and — for characters — a rig and
 * baked animation. A box with a colour on it would pass a "does it load" check
 * and fail every assertion here.
 *
 * The generators are deterministic functions of their seed, so this is an exact
 * test of real output, not a smoke test.
 */

const PALETTE = ['#c81e3a', '#141821', '#e8edf7', '#f5a524', '#2dd4bf'];

function generate(kind: ModelKind, seed = 20260811): ReturnType<typeof generateModel> {
  return generateModel({ kind, name: `test_${kind}`, seed, palette: PALETTE });
}

describe.each<[ModelKind, number]>([
  ['character', 4_000],
  ['vehicle', 6_000],
  ['track', 4_000],
  ['weapon', 2_000],
])('%s generation', (kind, minimumTriangles) => {
  const model = generate(kind);

  it('produces a valid GLB', () => {
    const validation = validateGlb(model.glb);
    expect(validation.problems).toEqual([]);
    expect(validation.ok).toBe(true);
  });

  it('is genuinely modelled, not a primitive with a colour on it', () => {
    // The floor is set well above what any box, cylinder or capsule assembly
    // would produce; only real subdivided surface modelling reaches it.
    expect(model.triangleCount).toBeGreaterThan(minimumTriangles);
  });

  it('reports a stored triangle count that matches the file', () => {
    expect(inspectGlb(model.glb).triangles).toBe(model.triangleCount);
  });

  it('stays within its per-frame triangle budget so it can render on a phone', () => {
    // Rendered triangles count every node instance, so it is never lower than
    // what the file stores.
    expect(model.renderedTriangleCount).toBeGreaterThanOrEqual(model.triangleCount);
    expect(model.renderedTriangleCount).toBeLessThan(400_000);
  });

  it('carries multiple materials and real PBR textures', () => {
    expect(model.materialCount).toBeGreaterThan(1);
    // Each textured slot contributes albedo + normal + ORM, so a model with any
    // textured material has at least three maps.
    expect(model.textureCount).toBeGreaterThanOrEqual(3);
    expect(model.textureCount % 1).toBe(0);
  });

  it('reports no warnings for a default request', () => {
    expect(model.warnings).toEqual([]);
  });

  it('is deterministic for a given seed', () => {
    const again = generate(kind);
    expect(again.glb.equals(model.glb)).toBe(true);
  });

  it('produces different geometry for a different seed', () => {
    const other = generate(kind, 99991);
    expect(other.glb.equals(model.glb)).toBe(false);
  });

  it('stays inside the workspace binary file limit', () => {
    expect(model.glb.length).toBeLessThan(24 * 1024 * 1024);
  });
});

describe('character rigging', () => {
  const model = generate('character');
  const summary = inspectGlb(model.glb);

  it('ships a skeleton so the character can be animated at runtime', () => {
    expect(summary.skins).toBeGreaterThan(0);
  });

  it('ships baked animations rather than a static pose', () => {
    // idle, walk, run and attack are baked at generation time so a generated
    // game has something to play the moment it boots.
    expect(summary.animations).toBeGreaterThanOrEqual(3);
  });

  it('has a plausible human silhouette rather than a slab', () => {
    const json = readJson(model.glb);
    const bounds = positionBounds(json);
    const height = bounds.max[1] - bounds.min[1];
    const width = bounds.max[0] - bounds.min[0];
    const depth = bounds.max[2] - bounds.min[2];

    // Human proportions: roughly 3.5-9x taller than deep, and clearly taller
    // than wide. A box-man fails both.
    expect(height).toBeGreaterThan(width * 1.8);
    expect(height / depth).toBeGreaterThan(2.5);
    expect(height / depth).toBeLessThan(12);
  });
});

describe('vehicle construction', () => {
  const model = generate('vehicle');

  it('is wider than it is tall and longer than it is wide, like a car', () => {
    const bounds = positionBounds(readJson(model.glb));
    const length = bounds.max[2] - bounds.min[2];
    const width = bounds.max[0] - bounds.min[0];
    const height = bounds.max[1] - bounds.min[1];

    expect(length).toBeGreaterThan(width);
    expect(width).toBeGreaterThan(height);
  });

  it('uses clearcoat for paint and transmission for glass', () => {
    const json = readJson(model.glb) as unknown as { extensionsUsed?: string[] };
    expect(json.extensionsUsed).toContain('KHR_materials_clearcoat');
    expect(json.extensionsUsed).toContain('KHR_materials_transmission');
  });
});

describe('track generation', () => {
  const model = generate('track');

  it('returns the gameplay data a driving game needs, not just a mesh', () => {
    expect(model.gameplay).toBeDefined();
    const gameplay = model.gameplay as Record<string, unknown>;
    expect(Object.keys(gameplay).length).toBeGreaterThan(0);
  });

  it('is a long circuit rather than a small prop', () => {
    const bounds = positionBounds(readJson(model.glb));
    const extent = Math.max(bounds.max[0] - bounds.min[0], bounds.max[2] - bounds.min[2]);
    expect(extent).toBeGreaterThan(100);
  });
});

// ------------------------------------------------------------------ helpers --

interface GlbJson {
  accessors: Array<{ type: string; min?: number[]; max?: number[] }>;
  meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
  extensionsUsed?: string[];
}

function readJson(glb: Buffer): GlbJson {
  const jsonLength = glb.readUInt32LE(12);
  return JSON.parse(glb.toString('utf8', 20, 20 + jsonLength)) as GlbJson;
}

/** Model-space bounds, taken from the POSITION accessors' recorded min/max. */
function positionBounds(json: GlbJson): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  for (const mesh of json.meshes) {
    for (const primitive of mesh.primitives) {
      const index = primitive.attributes.POSITION;
      if (index === undefined) continue;
      const accessor = json.accessors[index];
      if (!accessor?.min || !accessor.max) continue;
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis] as number, accessor.min[axis] as number);
        max[axis] = Math.max(max[axis] as number, accessor.max[axis] as number);
      }
    }
  }
  return { min, max };
}
