import { describe, expect, it } from 'vitest';
import { buildSceneFromRecipes } from '@/lib/generation/recipe/scene';
import { buildAssetFromRecipe } from '@/lib/generation/recipe/build';
import { inspectGlb, validateGlb } from '@/lib/graphics/gltf';
import { STREET_LANTERN } from '@/lib/generation/recipe/examples';
import { AssetRecipeSchema } from '@/lib/generation/recipe/schema';

/**
 * A scene is several reviewed assets in one file. The properties that matter
 * are the ones that break silently: a part placed with the wrong material
 * because indices were concatenated without offsetting, a part that floats
 * because it was placed by an origin nobody measured, and geometry quietly
 * altered by being composed — which would mean the file no longer contains what
 * the reviewer approved.
 */

const PALETTE = ['#8c1230', '#101418', '#c9d1de', '#f0a500', '#8892a0', '#555a63', '#17171b'];

interface GltfNode {
  name: string;
  mesh?: number;
  translation?: number[];
  rotation?: number[];
  scale?: number[];
}

/** The glTF JSON out of a GLB, so the nodes can be read as a renderer reads them. */
function nodesOf(glb: Buffer): GltfNode[] {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength)) as {
    nodes?: GltfNode[];
    meshes?: Array<{ primitives: Array<{ material: number }> }>;
  };
  return json.nodes ?? [];
}

function materialsUsedBy(glb: Buffer, meshIndex: number): number[] {
  const jsonLength = glb.readUInt32LE(12);
  const json = JSON.parse(glb.toString('utf8', 20, 20 + jsonLength)) as {
    meshes?: Array<{ primitives: Array<{ material: number }> }>;
  };
  return (json.meshes?.[meshIndex]?.primitives ?? []).map((primitive) => primitive.material);
}

/** A second, deliberately different recipe: one box, one material, no textures. */
const MARKER = AssetRecipeSchema.parse({
  name: 'kerb_marker',
  description: 'A plain concrete block used as a placement fixture.',
  brief: {
    subject: 'A square concrete kerb marker used to check scene placement',
    style: 'Plain poured concrete, no styling, no wear. It exists to be measured.',
    purpose: 'A test fixture placed beside another asset to verify composition.',
    mustRead: ['a single rectangular block', 'flat untextured faces', 'a square footprint'],
    silhouette: 'A plain rectangle from every side.',
    proportions: ['twice as tall as it is wide'],
    surfaceNotes: 'Matte concrete, no gloss.',
    avoid: ['rounded corners', 'any ornament at all'],
    acceptance: ['the block is a rectangular solid', 'the footprint is square'],
  },
  targetSize: [0.2, 0.4, 0.2],
  materials: [{ id: 'concrete', family: 'concrete', colorIndex: 4 }],
  steps: [
    {
      id: 'block',
      op: 'primitive',
      note: 'The whole marker: one box, centred on its own origin so the seating test has something to correct.',
      shape: 'box',
      centre: [0, 0, 0],
      size: [0.2, 0.4, 0.2],
      material: 'concrete',
    },
  ],
  outputs: ['block'],
});

describe('scene composition', () => {
  it('places every part as its own node and keeps their materials apart', () => {
    const scene = buildSceneFromRecipes({
      name: 'kerbside',
      palette: PALETTE,
      seed: 7,
      textureSize: 64,
      occlusion: { enabled: false },
      placements: [
        { recipe: STREET_LANTERN, translate: [0, 0, 0] },
        { recipe: MARKER, name: 'marker_left', translate: [-1.5, 0, 0.5], seatOnGround: true },
        { recipe: MARKER, name: 'marker_right', translate: [1.5, 0, 0.5], rotateYDegrees: 45 },
      ],
    });

    const summary = inspectGlb(scene.glb);
    expect(summary.meshes).toBe(3);
    expect(summary.nodes).toBe(3);
    expect(scene.parts.map((part) => part.name)).toEqual([STREET_LANTERN.name, 'marker_left', 'marker_right']);

    // Every part's materials survive as its own: the lantern's plus one
    // concrete per marker, none of them shared by index accident.
    const lanternMaterials = STREET_LANTERN.materials.length;
    expect(scene.materialCount).toBe(lanternMaterials + 2);

    // The two markers are the same recipe, so an unoffset merge would have them
    // drawing each other's material — the failure that makes a composed scene
    // come out the wrong colour.
    const nodes = nodesOf(scene.glb);
    const leftMaterials = materialsUsedBy(scene.glb, nodes[1]?.mesh as number);
    const rightMaterials = materialsUsedBy(scene.glb, nodes[2]?.mesh as number);
    expect(leftMaterials).not.toEqual(rightMaterials);
    expect(new Set([...leftMaterials, ...rightMaterials]).size).toBe(2);

    expect(nodes[2]?.translation).toEqual([1.5, 0, 0.5]);
    // 45° about the vertical axis, as a quaternion.
    expect(nodes[2]?.rotation?.[1]).toBeCloseTo(Math.sin(Math.PI / 8), 6);
    expect(nodes[2]?.rotation?.[3]).toBeCloseTo(Math.cos(Math.PI / 8), 6);

    expect(validateGlb(scene.glb, { requireUvs: true }).problems).toEqual([]);
  });

  it('seats a part on the ground by measuring it, not by trusting its origin', () => {
    const scene = buildSceneFromRecipes({
      name: 'seating',
      palette: PALETTE,
      textureSize: 64,
      occlusion: { enabled: false },
      placements: [
        { recipe: MARKER, name: 'floating', translate: [0, 0, 0] },
        { recipe: MARKER, name: 'seated', translate: [1, 0, 0], seatOnGround: true },
        { recipe: MARKER, name: 'seated_scaled', translate: [2, 0, 0], scale: 2, seatOnGround: true },
      ],
    });

    const [floating, seated, scaled] = scene.parts;
    // The marker is centred on its origin, so placing it at y=0 buries half of
    // it; seating lifts it by exactly half its height, and by half its *scaled*
    // height when it is scaled.
    expect(floating?.translate[1]).toBe(0);
    expect(seated?.translate[1]).toBeCloseTo(0.2, 5);
    expect(scaled?.translate[1]).toBeCloseTo(0.4, 5);
    expect(scaled?.sizeMetres[1]).toBeCloseTo(0.8, 5);
  });

  it('leaves the geometry of a part identical to the asset that was reviewed', () => {
    const alone = buildAssetFromRecipe(MARKER, { palette: PALETTE, seed: 7, textureSize: 64, occlusion: { enabled: false } });
    const scene = buildSceneFromRecipes({
      name: 'unchanged',
      palette: PALETTE,
      seed: 7,
      textureSize: 64,
      occlusion: { enabled: false },
      placements: [{ recipe: MARKER, translate: [3, 0, -2], rotateYDegrees: 90 }],
    });

    // Placement is a node transform, so the vertex count and the triangle count
    // are the ones the critic graded — the composer never re-meshes a part.
    expect(scene.triangleCount).toBe(alone.triangleCount);
    expect(inspectGlb(scene.glb).triangles).toBe(inspectGlb(alone.glb).triangles);
  });

  it('refuses to compose nothing', () => {
    expect(() => buildSceneFromRecipes({ name: 'empty', palette: PALETTE, placements: [] })).toThrow(/at least one/);
  });
});
