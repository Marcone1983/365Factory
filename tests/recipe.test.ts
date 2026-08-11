import { describe, expect, it } from 'vitest';
import { AssetRecipeSchema, validateReferences, type AssetRecipe } from '@/lib/generation/recipe/schema';
import { interpretRecipe, RecipeError } from '@/lib/generation/recipe/interpreter';
import { buildAssetFromRecipe } from '@/lib/generation/recipe/build';
import { inspectGlb } from '@/lib/graphics/gltf';

/**
 * The recipe is the language the AI writes instead of the platform shipping a
 * generator per asset category, so these tests check the two properties that
 * make that safe: a malformed recipe is refused rather than partially built,
 * and a well-formed one produces real geometry.
 *
 * The worked example is a street lantern — an object with no dedicated
 * generator anywhere in the codebase, built from the same operators the car and
 * the bouquet use.
 */

const LANTERN = {
  name: 'street_lantern',
  description: 'A cast-iron street lantern: fluted post, scrolled bracket, glazed lamp housing and a finial.',
  targetSize: [0.6, 3.2, 0.6],
  smoothness: 1,
  smoothAngleDegrees: 46,
  uvProjection: 'box',
  uvScale: 0.6,
  materials: [
    { id: 'iron', family: 'metal_worn', colorIndex: 1, roughness: 0.52, textureScale: 1 },
    { id: 'glass', family: 'glass', colorIndex: 2, transmission: 0.9, roughness: 0.05, textureScale: 0.5 },
    { id: 'lamp', family: 'emissive_panel', colorIndex: 3, emissiveStrength: 9, textureScale: 0.25 },
  ],
  steps: [
    // The post: a tapered fluted column swept up from the base.
    {
      op: 'sweep',
      id: 'post',
      curve: { type: 'line', from: [0, 0, 0], to: [0, 2.4, 0] },
      profile: { type: 'superellipse', radiusX: 0.055, radiusY: 0.055, exponent: 3.2, segments: 16 },
      segments: 18,
      scaleAlong: { shape: 'easeOut', from: 1.6, to: 0.72, bias: 1.6 },
      material: 'iron',
    },
    // A moulded base, revolved from its half-outline the way a turned part is.
    {
      op: 'revolve',
      id: 'base',
      outline: [
        { x: 0.2, y: 0 },
        { x: 0.2, y: 0.06 },
        { x: 0.15, y: 0.1 },
        { x: 0.16, y: 0.2 },
        { x: 0.1, y: 0.28 },
        { x: 0.09, y: 0.42 },
      ],
      segments: 24,
      material: 'iron',
    },
    // The housing: a tapered glazed box.
    {
      op: 'loft',
      id: 'housing',
      sections: [
        { at: [0, 2.4, 0], profile: { type: 'rectangle', width: 0.2, height: 0.2, cornerRadius: 0.02, segments: 16 } },
        { at: [0, 2.55, 0], profile: { type: 'rectangle', width: 0.3, height: 0.3, cornerRadius: 0.03, segments: 16 } },
        { at: [0, 2.95, 0], profile: { type: 'rectangle', width: 0.26, height: 0.26, cornerRadius: 0.03, segments: 16 } },
        { at: [0, 3.05, 0], profile: { type: 'rectangle', width: 0.1, height: 0.1, cornerRadius: 0.02, segments: 16 } },
      ],
      material: 'glass',
    },
    // Four corner posts, arrayed radially around the housing.
    {
      op: 'sweep',
      id: 'mullion',
      curve: { type: 'line', from: [0, 2.55, 0], to: [0, 2.95, 0] },
      profile: { type: 'rectangle', width: 0.022, height: 0.022, cornerRadius: 0.004, segments: 8 },
      segments: 3,
      material: 'iron',
    },
    {
      op: 'array',
      id: 'mullions',
      source: 'mullion',
      kind: 'radial',
      count: 4,
      axis: [0, 1, 0],
      radius: 0.135,
      sweepDegrees: 360,
    },
    // The lamp itself, inside the glass.
    {
      op: 'primitive',
      id: 'bulb',
      shape: 'sphere',
      centre: [0, 2.74, 0],
      radius: 0.07,
      segments: 18,
      material: 'lamp',
    },
    // The finial on top.
    {
      op: 'revolve',
      id: 'finial',
      outline: [
        { x: 0.05, y: 3.05 },
        { x: 0.07, y: 3.1 },
        { x: 0.035, y: 3.18 },
        { x: 0.012, y: 3.26 },
        { x: 0.0, y: 3.3 },
      ],
      segments: 16,
      material: 'iron',
    },
  ],
  outputs: ['post', 'base', 'housing', 'mullions', 'bulb', 'finial'],
} as const;

function parse(input: unknown): AssetRecipe {
  const result = AssetRecipeSchema.safeParse(input);
  if (!result.success) {
    throw new Error(result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }
  return result.data;
}

describe('recipe validation', () => {
  it('accepts a well-formed recipe', () => {
    const recipe = parse(LANTERN);
    expect(recipe.name).toBe('street_lantern');
    expect(validateReferences(recipe)).toEqual([]);
  });

  it('rejects a step that references a part built after it', () => {
    const recipe = parse({
      ...LANTERN,
      steps: [
        { op: 'array', id: 'copies', source: 'later', kind: 'radial', count: 4 },
        ...LANTERN.steps,
      ],
      outputs: ['copies'],
    });
    expect(validateReferences(recipe).join(' ')).toMatch(/references "later"/);
  });

  it('rejects a duplicate step id', () => {
    const recipe = parse({ ...LANTERN, steps: [...LANTERN.steps, LANTERN.steps[0]], outputs: ['post'] });
    expect(validateReferences(recipe).join(' ')).toMatch(/reuses the id/);
  });

  it('rejects an undeclared material', () => {
    const recipe = parse({
      ...LANTERN,
      steps: [{ ...LANTERN.steps[0], material: 'brass' }],
      outputs: ['post'],
    });
    expect(validateReferences(recipe).join(' ')).toMatch(/material "brass"/);
  });

  it('rejects an output nothing builds', () => {
    const recipe = parse({ ...LANTERN, outputs: ['nonexistent'] });
    expect(validateReferences(recipe).join(' ')).toMatch(/output "nonexistent"/);
  });

  it('refuses values outside the safe ranges instead of trying them', () => {
    // A recipe cannot ask for a million segments and exhaust memory.
    expect(() => parse({ ...LANTERN, steps: [{ ...LANTERN.steps[0], segments: 1_000_000 }] })).toThrow();
    expect(() => parse({ ...LANTERN, smoothness: 9 })).toThrow();
    expect(() =>
      parse({ ...LANTERN, materials: [{ id: 'x', family: 'unobtainium', colorIndex: 0 }] }),
    ).toThrow();
  });

  it('rejects a linear array with no step vector', () => {
    const recipe = parse({
      ...LANTERN,
      steps: [LANTERN.steps[0], { op: 'array', id: 'row', source: 'post', kind: 'linear', count: 4 }],
      outputs: ['row'],
    });
    expect(validateReferences(recipe).join(' ')).toMatch(/no step vector/);
  });
});

describe('interpretation', () => {
  it('builds real geometry from the lantern recipe', () => {
    const result = interpretRecipe(parse(LANTERN), { seed: 99 });

    expect(result.triangleCount).toBeGreaterThan(2_000);
    expect(result.triangleCount).toBeLessThan(400_000);
    expect(result.warnings).toEqual([]);
    expect(result.stats.steps).toBe(LANTERN.steps.length);
    expect(result.materialOrder).toEqual(['iron', 'glass', 'lamp']);
  });

  it('fits the asset to the size the recipe asked for', () => {
    const result = interpretRecipe(parse(LANTERN), { seed: 99 });
    let minY = Infinity;
    let maxY = -Infinity;
    let maxHorizontal = 0;
    for (const vertex of result.mesh.vertices) {
      minY = Math.min(minY, vertex.position.y);
      maxY = Math.max(maxY, vertex.position.y);
      maxHorizontal = Math.max(maxHorizontal, Math.abs(vertex.position.x), Math.abs(vertex.position.z));
    }
    // Scaled uniformly to fit within the target box, so the tallest axis
    // reaches it and the others stay inside.
    expect(maxY - minY).toBeLessThanOrEqual(3.2 + 1e-6);
    expect(maxY - minY).toBeGreaterThan(3.0);
    expect(maxHorizontal * 2).toBeLessThanOrEqual(0.6 + 1e-6);
  });

  it('keeps every material used by at least one triangle group', () => {
    const result = interpretRecipe(parse(LANTERN), { seed: 99 });
    const used = new Set(result.triangulated.materialGroups.map((group) => group.material));
    expect(used.size).toBe(3);
  });

  it('is deterministic for a given seed', () => {
    const a = interpretRecipe(parse(LANTERN), { seed: 7 });
    const b = interpretRecipe(parse(LANTERN), { seed: 7 });
    expect(a.triangleCount).toBe(b.triangleCount);
    expect(a.mesh.vertices[10]?.position).toEqual(b.mesh.vertices[10]?.position);
  });

  it('names the failing step when a reference is missing at run time', () => {
    const recipe = parse(LANTERN) as AssetRecipe;
    const broken: AssetRecipe = {
      ...recipe,
      steps: [{ op: 'mirror', id: 'copy', source: 'ghost', axis: 'x' }],
      outputs: ['copy'],
    };
    expect(() => interpretRecipe(broken)).toThrow(RecipeError);
    expect(() => interpretRecipe(broken)).toThrow(/ghost/);
  });

  it('refuses a loft whose sections have different point counts', () => {
    const recipe = parse(LANTERN) as AssetRecipe;
    const mismatched: AssetRecipe = {
      ...recipe,
      steps: [
        {
          op: 'loft',
          id: 'bad',
          sections: [
            { at: [0, 0, 0], profile: { type: 'ellipse', radiusX: 1, radiusY: 1, segments: 8 } },
            { at: [0, 1, 0], profile: { type: 'ellipse', radiusX: 1, radiusY: 1, segments: 16 } },
          ],
          closeRing: true,
          capStart: true,
          capEnd: true,
          material: 'iron',
        },
      ],
      outputs: ['bad'],
    };
    expect(() => interpretRecipe(mismatched)).toThrow(/same profile segments/);
  });
});

describe('boolean operations inside a recipe', () => {
  it('cuts an opening, which is what no previous generator could do', () => {
    const recipe = parse({
      name: 'pierced_block',
      description: 'A block with a bore through it.',
      targetSize: [2, 2, 2],
      smoothness: 0,
      materials: [{ id: 'stone', family: 'concrete', colorIndex: 0 }],
      steps: [
        { op: 'primitive', id: 'block', shape: 'box', centre: [0, 0, 0], size: [2, 2, 2], material: 'stone' },
        { op: 'primitive', id: 'bore', shape: 'cylinder', centre: [0, 0, 0], size: [1, 4, 1], radius: 0.5, segments: 24, material: 'stone' },
        { op: 'boolean', id: 'pierced', mode: 'subtract', base: 'block', tools: ['bore'] },
      ],
      outputs: ['pierced'],
    });

    const solid = interpretRecipe(
      parse({
        name: 'solid_block',
        description: 'A block.',
        targetSize: [2, 2, 2],
        smoothness: 0,
        materials: [{ id: 'stone', family: 'concrete', colorIndex: 0 }],
        steps: [{ op: 'primitive', id: 'block', shape: 'box', centre: [0, 0, 0], size: [2, 2, 2], material: 'stone' }],
        outputs: ['block'],
      }),
    );
    const pierced = interpretRecipe(recipe);

    // The bore adds surface while removing volume, so a real subtraction has
    // strictly more triangles than the solid it was cut from.
    expect(pierced.triangleCount).toBeGreaterThan(solid.triangleCount);
  });
});

describe('building a GLB from a recipe', () => {
  const built = buildAssetFromRecipe(parse(LANTERN), {
    palette: ['#c9a227', '#2b2f36', '#dfe7f5', '#ffd88a'],
    seed: 4242,
  });

  it('produces a valid GLB with the recipe\'s materials', () => {
    const summary = inspectGlb(built.glb);
    expect(summary.version).toBe(2);
    expect(summary.materials).toBe(3);
    expect(summary.triangles).toBe(built.triangleCount);
    expect(built.warnings).toEqual([]);
  });

  it('synthesises PBR maps for every non-glass material', () => {
    // Two textured materials (iron, lamp) at three maps each, plus the lamp's
    // emissive map. Glass is deliberately left unmapped.
    expect(built.textureCount).toBeGreaterThanOrEqual(6);
    expect(inspectGlb(built.glb).textures).toBe(built.textureCount);
  });

  it('stays small enough to ship', () => {
    expect(built.glb.length).toBeLessThan(24 * 1024 * 1024);
  });
});
