/**
 * Reports where a recipe's surface actually is.
 *
 * Placing a feature on a lofted organic form — an eye on a face, a handle on a
 * vase — means knowing how far forward the surface sits at that point, and that
 * is not something anyone can read off a list of cross-sections. Guessing costs
 * a build, a render and a look, and gets it wrong about half the time: two
 * millimetres too far back and the feature vanishes inside the form, two too far
 * forward and it floats.
 *
 * It casts a ray along +Z through each sample point and reports where it
 * crosses the surface. Vertices are not enough: a loft only has vertices on its
 * rings, so the nearest one to a point on the face can be centimetres away and
 * on the back of the skull.
 *
 *   npx tsx scripts/recipe-probe.ts field_scout_character head_cheeks 0,1.700 0.0325,1.677
 */
import { interpretRecipe } from '../src/lib/generation/recipe/interpreter';
import { RECIPE_EXAMPLES } from '../src/lib/generation/recipe/examples';
import { AssetRecipeSchema } from '../src/lib/generation/recipe/schema';
import type { Vec3 } from '../src/lib/graphics/mesh-kernel';

const [recipeName, partId, ...samples] = process.argv.slice(2);
if (!recipeName || !partId || samples.length === 0) {
  throw new Error('usage: recipe-probe.ts <recipe> <partId> <x,y> [<x,y> …]');
}

const example = RECIPE_EXAMPLES.find((entry) => entry.recipe.name === recipeName);
if (!example) throw new Error(`no recipe named "${recipeName}"`);

const stepIndex = example.recipe.steps.findIndex((step) => step.id === partId);
if (stepIndex < 0) throw new Error(`no step "${partId}" in "${recipeName}"`);

// Truncated at the part, at smoothness 0 and with targetSize disabled, so the
// coordinates reported are the ones written in the recipe.
const result = interpretRecipe(
  AssetRecipeSchema.parse({
    ...example.recipe,
    smoothness: 0,
    targetSize: [0, 0, 0],
    steps: example.recipe.steps.slice(0, stepIndex + 1),
    outputs: [partId],
  }),
);

/** Möller–Trumbore, specialised to a ray pointing along +Z from (x, y, -inf). */
function crossingZ(x: number, y: number, a: Vec3, b: Vec3, c: Vec3): number | null {
  const e1 = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z };
  const e2 = { x: c.x - a.x, y: c.y - a.y, z: c.z - a.z };
  // direction = (0, 0, 1); p = direction × e2
  const p = { x: -e2.y, y: e2.x, z: 0 };
  const determinant = e1.x * p.x + e1.y * p.y + e1.z * p.z;
  if (Math.abs(determinant) < 1e-12) return null;

  const inverse = 1 / determinant;
  const t = { x: x - a.x, y: y - a.y, z: -a.z };
  const u = (t.x * p.x + t.y * p.y + t.z * p.z) * inverse;
  if (u < 0 || u > 1) return null;

  const q = {
    x: t.y * e1.z - t.z * e1.y,
    y: t.z * e1.x - t.x * e1.z,
    z: t.x * e1.y - t.y * e1.x,
  };
  const v = q.z * inverse;
  if (v < 0 || u + v > 1) return null;

  return (e2.x * q.x + e2.y * q.y + e2.z * q.z) * inverse;
}

for (const sample of samples) {
  const [xs, ys] = sample.split(',');
  const x = Number(xs);
  const y = Number(ys);
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`"${sample}" is not an x,y pair`);

  const crossings: number[] = [];
  for (const face of result.mesh.faces) {
    const positions = face.vertices
      .map((index) => result.mesh.vertices[index]?.position)
      .filter((position): position is Vec3 => position !== undefined);
    for (let i = 1; i + 1 < positions.length; i += 1) {
      const z = crossingZ(x, y, positions[0] as Vec3, positions[i] as Vec3, positions[i + 1] as Vec3);
      if (z !== null) crossings.push(z);
    }
  }

  if (crossings.length === 0) {
    process.stdout.write(`(${x}, ${y}): the ray misses the part entirely\n`);
    continue;
  }
  crossings.sort((a, b) => a - b);
  const front = crossings[crossings.length - 1] as number;
  const back = crossings[0] as number;
  process.stdout.write(
    `(${x}, ${y}): front z=${front.toFixed(4)}  back z=${back.toFixed(4)}  ` +
      `(${crossings.length} crossings: ${crossings.map((z) => z.toFixed(3)).join(', ')})\n`,
  );
}
