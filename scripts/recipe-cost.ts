/**
 * Reports what each step of a recipe costs.
 *
 * A triangle budget overrun has to be attributable to the step responsible.
 * Booleans are the usual culprit and the least predictable: a cut through a
 * dense surface can multiply the face count several times over, and without
 * this the only visible repair is to lower smoothness globally and lose the
 * quality everywhere.
 *
 *   npx tsx scripts/recipe-cost.ts field_scout_character
 */
import { interpretRecipe } from '../src/lib/generation/recipe/interpreter';
import { RECIPE_EXAMPLES } from '../src/lib/generation/recipe/examples';
import { AssetRecipeSchema } from '../src/lib/generation/recipe/schema';

const NAME = process.argv[2] ?? 'field_scout_character';
const example = RECIPE_EXAMPLES.find((entry) => entry.recipe.name === NAME);
if (!example) {
  throw new Error(`no example named "${NAME}"; known: ${RECIPE_EXAMPLES.map((e) => e.recipe.name).join(', ')}`);
}

// Smoothness 0 so the numbers are the geometry the steps actually produced,
// not that multiplied by a subdivision level applied to the whole assembly.
const flat = interpretRecipe(AssetRecipeSchema.parse({ ...example.recipe, smoothness: 0 }));

const outputs = new Set(example.recipe.outputs);
let shipped = 0;
for (const cost of flat.stepCosts) {
  const isOutput = outputs.has(cost.id);
  if (isOutput) shipped += cost.faces;
  process.stdout.write(
    `${cost.op.padEnd(10)} ${cost.id.padEnd(20)} ${String(cost.faces).padStart(8)} faces${isOutput ? '  (shipped)' : ''}\n`,
  );
}

process.stdout.write(
  `\n${flat.stepCosts.length} steps · ${shipped} faces in the ${outputs.size} outputs · ` +
    `${flat.triangleCount} triangles at smoothness 0\n` +
    `at smoothness 1 that is roughly ${flat.triangleCount * 4} triangles.\n`,
);
