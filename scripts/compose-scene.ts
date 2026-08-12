/**
 * Composes several authored recipes into one scene GLB.
 *
 * Each asset is written, reviewed and repaired on its own — a car, a driver and
 * a stretch of promenade are three modelling problems, and a single failure in
 * one of them must not send the other two back. This is the step that puts the
 * approved parts in one file, placed relative to each other.
 *
 *   npx tsx scripts/compose-scene.ts --out=var/scene/coastal.glb \
 *     --place=var/scene/supercar.recipe.json@0,0,0:seat \
 *     --place=var/scene/woman.recipe.json@1.4,0.55,0.35:rot=90 \
 *     --place=var/scene/promenade.recipe.json@-6,0,0:seat
 *
 * A placement is `<recipe.json>@x,y,z` followed by optional colon-separated
 * modifiers: `seat` rests the part's lowest point at y, `rot=<degrees>` turns it
 * about the vertical axis, `scale=<factor>` resizes it, `name=<node>` names the
 * node in the finished file.
 *
 * Nothing here calls a model. Every recipe it reads has already been paid for.
 */
import fs from 'node:fs';
import path from 'node:path';
import { AssetRecipeSchema } from '../src/lib/generation/recipe/schema';
import { buildSceneFromRecipes, type ScenePlacement } from '../src/lib/generation/recipe/scene';
import { renderForReview } from '../src/lib/generation/review/render';

const args = process.argv.slice(2);
const flag = (name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const flags = (name: string): string[] =>
  args.filter((arg) => arg.startsWith(`--${name}=`)).map((arg) => arg.split('=').slice(1).join('='));

const out = flag('out') ?? 'var/scene/scene.glb';
const seed = Number(flag('seed') ?? 4242);
const textureSize = flag('texture-size') ? Number(flag('texture-size')) : undefined;
const palette = (flag('palette') ?? '#b3122c,#141821,#c9d1de,#f0a500,#8892a0,#3a3f47,#0d0f13').split(',');
const renderViews = !args.includes('--no-render');

function parsePlacement(spec: string): ScenePlacement {
  const [locator, ...modifiers] = spec.split(':');
  const [file, at] = (locator ?? '').split('@');
  if (!file) throw new Error(`placement "${spec}" names no recipe file`);

  const recipe = AssetRecipeSchema.parse(JSON.parse(fs.readFileSync(file, 'utf8')));
  const translate = at
    ? (at.split(',').map(Number) as [number, number, number])
    : ([0, 0, 0] as [number, number, number]);
  if (translate.length !== 3 || translate.some((value) => !Number.isFinite(value))) {
    throw new Error(`placement "${spec}" has a position that is not three numbers`);
  }

  const placement: {
    recipe: typeof recipe;
    translate: [number, number, number];
    seatOnGround?: boolean;
    rotateYDegrees?: number;
    scale?: number;
    name?: string;
  } = { recipe, translate };

  for (const modifier of modifiers) {
    if (modifier === 'seat') placement.seatOnGround = true;
    else if (modifier.startsWith('rot=')) placement.rotateYDegrees = Number(modifier.slice(4));
    else if (modifier.startsWith('scale=')) placement.scale = Number(modifier.slice(6));
    else if (modifier.startsWith('name=')) placement.name = modifier.slice(5);
    else throw new Error(`placement "${spec}" carries an unknown modifier "${modifier}"`);
  }
  return placement as ScenePlacement;
}

async function main(): Promise<void> {
  const specs = flags('place');
  if (specs.length === 0) {
    process.stderr.write('usage: compose-scene.ts --out=scene.glb --place=<recipe.json>@x,y,z[:seat][:rot=90][:scale=1]\n');
    process.exitCode = 1;
    return;
  }

  const placements = specs.map(parsePlacement);
  const scene = buildSceneFromRecipes({
    name: path.basename(out, '.glb'),
    placements,
    palette,
    seed,
    ...(textureSize !== undefined ? { textureSize } : {}),
  });

  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, scene.glb);

  for (const part of scene.parts) {
    process.stdout.write(
      `  ${part.name.padEnd(24)} ${part.triangles.toString().padStart(7)} tris  ` +
        `${part.sizeMetres.map((value) => value.toFixed(2)).join(' x ')} m  at ${part.translate.map((value) => value.toFixed(2)).join(', ')}\n`,
    );
  }
  for (const warning of scene.warnings) process.stdout.write(`  warning: ${warning}\n`);
  process.stdout.write(
    `\n${scene.parts.length} part(s) · ${scene.triangleCount} triangles · ${scene.materialCount} materials · ` +
      `${(scene.glb.length / 1e6).toFixed(1)}MB · ${(scene.durationMs / 1000).toFixed(1)}s\nwritten to ${out}\n`,
  );

  if (renderViews) {
    const render = await renderForReview(scene.glb);
    const stem = out.replace(/\.glb$/, '');
    render.views.forEach((view, index) => {
      fs.writeFileSync(`${stem}-${index}-${view.kind}-${view.label}.png`, view.png);
    });
    for (const error of render.runtimeErrors) process.stdout.write(`  render error: ${error}\n`);
    process.stdout.write(`rendered ${render.views.length} view(s) beside the GLB\n`);
  }
}

void main();
