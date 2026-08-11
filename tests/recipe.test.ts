import { describe, expect, it } from 'vitest';
import { AssetRecipeSchema, validateReferences, type AssetRecipe } from '@/lib/generation/recipe/schema';
import { interpretRecipe, RecipeError } from '@/lib/generation/recipe/interpreter';
import { buildAssetFromRecipe } from '@/lib/generation/recipe/build';
import { inspectGlb } from '@/lib/graphics/gltf';
import { STREET_LANTERN } from '@/lib/generation/recipe/examples';

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

const LANTERN = STREET_LANTERN;

/** Minimal brief for the fixtures that exist only to exercise one operator. */
const BLOCK_BRIEF = {
  subject: 'A plain concrete block used as a boolean test fixture',
  style: 'Untextured engineering test geometry, no stylistic intent whatsoever.',
  purpose: 'Exists only to verify that a subtraction removes volume and adds surface.',
  mustRead: ['a rectangular block', 'a circular bore passing right through it', 'sharp unfilleted edges'],
  silhouette: 'A square seen from any face, with a circular hole visible straight through the middle.',
  proportions: ['the bore diameter is half the block width'],
  surfaceNotes: 'Flat untextured concrete; no wear, no variation.',
  avoid: ['a bore that stops short of passing through'],
  acceptance: ['the hole passes completely through the block', 'the block is otherwise a plain cube'],
};

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
        { op: 'array', id: 'copies', note: 'arrays a part that does not exist yet', source: 'later', kind: 'radial', count: 4 },
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

  it('refuses a recipe with no brief at all', () => {
    const { brief, ...withoutBrief } = LANTERN as unknown as Record<string, unknown>;
    void brief;
    expect(() => parse(withoutBrief)).toThrow(/brief/);
  });

  it('refuses a thin brief, which is the failure this schema exists to prevent', () => {
    // A one-line brief produces geometry that is plausible and wrong, and
    // leaves the visual review with nothing specific to check against.
    expect(() =>
      parse({ ...LANTERN, brief: { ...LANTERN.brief, mustRead: ['a lantern'] } }),
    ).toThrow();

    expect(() =>
      parse({ ...LANTERN, brief: { ...LANTERN.brief, mustRead: ['a post', 'a lamp', 'a base'], silhouette: 'tall' } }),
    ).toThrow(/silhouette/);

    expect(() =>
      parse({ ...LANTERN, brief: { ...LANTERN.brief, acceptance: ['it looks good'] } }),
    ).toThrow();

    expect(() => parse({ ...LANTERN, brief: { ...LANTERN.brief, style: 'iron' } })).toThrow(/style/);
    expect(() => parse({ ...LANTERN, brief: { ...LANTERN.brief, avoid: [] } })).toThrow(/avoid/);
  });

  it('requires every step to say what it depicts', () => {
    const { note, ...withoutNote } = LANTERN.steps[0] as unknown as Record<string, unknown>;
    void note;
    expect(() => parse({ ...LANTERN, steps: [withoutNote], outputs: ['post'] })).toThrow(/note/);
    expect(() =>
      parse({ ...LANTERN, steps: [{ ...LANTERN.steps[0], note: 'post' }], outputs: ['post'] }),
    ).toThrow(/note/);
  });

  it('carries the brief through parsing so the review step can read it', () => {
    const recipe = parse(LANTERN);
    expect(recipe.brief.mustRead.length).toBeGreaterThanOrEqual(3);
    expect(recipe.brief.acceptance.length).toBeGreaterThanOrEqual(2);
    // Acceptance criteria have to be answerable by looking at a picture.
    expect(recipe.brief.acceptance.every((line) => line.length > 10)).toBe(true);
    expect(recipe.steps.every((step) => step.note.length >= 8)).toBe(true);
  });

  it('rejects a linear array with no step vector', () => {
    const recipe = parse({
      ...LANTERN,
      steps: [LANTERN.steps[0], { op: 'array', id: 'row', note: 'a linear array missing its step vector', source: 'post', kind: 'linear', count: 4 }],
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
      steps: [{ op: 'mirror', id: 'copy', note: 'mirrors a part that was never built', source: 'ghost', axis: 'x' }],
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
          note: 'sections with mismatched point counts, which cannot be lofted',
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
      brief: BLOCK_BRIEF,
      targetSize: [2, 2, 2],
      smoothness: 0,
      materials: [{ id: 'stone', family: 'concrete', colorIndex: 0 }],
      steps: [
        { op: 'primitive', id: 'block', note: 'the solid the bore is cut from', shape: 'box', centre: [0, 0, 0], size: [2, 2, 2], material: 'stone' },
        { op: 'primitive', id: 'bore', note: 'the cutting tool, longer than the block so it passes clean through', shape: 'cylinder', centre: [0, 0, 0], size: [1, 4, 1], radius: 0.5, segments: 24, material: 'stone' },
        { op: 'boolean', id: 'pierced', note: 'the block with the bore removed', mode: 'subtract', base: 'block', tools: ['bore'] },
      ],
      outputs: ['pierced'],
    });

    const solid = interpretRecipe(
      parse({
        name: 'solid_block',
        description: 'A block.',
        brief: BLOCK_BRIEF,
        targetSize: [2, 2, 2],
        smoothness: 0,
        materials: [{ id: 'stone', family: 'concrete', colorIndex: 0 }],
        steps: [{ op: 'primitive', id: 'block', note: 'the same block, uncut, as the control', shape: 'box', centre: [0, 0, 0], size: [2, 2, 2], material: 'stone' }],
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
