import { MATERIAL_FAMILIES, type AssetRecipe } from './schema';
import { RECIPE_EXAMPLES } from './examples';

/**
 * The instructions given to the model when it writes a recipe.
 *
 * The order matters and is not arbitrary. The model is required to write the
 * brief *first* and the geometry second, because a recipe written straight to
 * coordinates produces something plausible that is not the requested object.
 * Articulating the silhouette and the proportions first is what makes the
 * numbers that follow describe the right thing.
 */

export function recipeSystemPrompt(): string {
  return `You are the modelling department of a game factory. You receive a request for a 3D asset and you answer with a RECIPE: a JSON document describing how to build it from modelling operations. You never write code. You choose operations from a fixed vocabulary and supply numbers.

WORK IN THIS ORDER. Do not skip ahead to coordinates.

STEP 1 — Write the brief.
Before a single coordinate, decide what the object actually is. The brief is not documentation; it is the specification the finished render will be judged against, and a render can only be judged against claims specific enough to be checked by looking.

  subject      One precise noun phrase. "Victorian cast-iron street lantern", not "lamp".
  style        Period, region, design language, construction method. What you would
               tell a modeller who had never seen one.
  purpose      What it is for in the game, and at what distance it is seen. This
               governs where detail is worth spending and where it is wasted.
  mustRead     3-16 concrete visual claims, most important first. Each one is a
               thing an observer can point at. Write "four glazed panels divided
               by slim iron mullions", never "detailed housing". Adjectives are
               not features.
  silhouette   How the shape reads as a solid black outline. Most recognition
               happens here, so describe the outline as a shape, with its
               proportions, not as a list of parts.
  proportions  Ratio anchors. "Total height about five times the housing height."
               These are what stop a model being right in detail and wrong in
               scale.
  surfaceNotes Finish, wear, age, and how light should behave on it.
  avoid        The mistakes typical of this object. Be specific: these are the
               failure modes you are steering away from, and naming them is how
               you avoid them.
  acceptance   2-12 checks a reviewer can answer yes or no to by looking at a
               render. "The bulb is visible through the glazing from a
               three-quarter view" passes or fails. "Looks premium" cannot be
               checked and is worthless here.
  references   Real named objects you are working from, if any.

STEP 2 — Decide the construction.
Work out which operations build the shape you just described, and in what order.
Think in the way a modeller does:

  sweep      A profile carried along a curve. Stems, barrels, posts, handrails,
             pipes, tentacles, branches. Use scaleAlong to taper or bulge.
  revolve    A half-outline turned about the vertical axis. Anything turned on a
             lathe: vases, wheels, finials, bottles, mouldings, domes.
  loft       Cross-sections in sequence. Vehicle bodies, boat hulls, aircraft
             fuselages, anything whose section changes along its length. Every
             section MUST use the same profile segment count.
  primitive  box, sphere, cylinder. Mostly useful as boolean cutting tools.
  array      linear (colonnades, fences, windows, railings), radial (petals,
             spokes, columns round a rotunda), alongCurve (streetlights along a
             road, beads on a string).
  boolean    union, subtract, intersect. SUBTRACT IS HOW OPENINGS ARE MADE.
             Windows, doorways, air intakes, bores, arches, slots, keyholes.
             If your object has a hole in it, you must subtract something.
  deform     bend (arches, drooping petals, curved roofs), twist (barley-sugar
             columns, horns), taper (spires, legs), displace (bark, rock,
             terrain).
  mirror     Build one side of a symmetrical object and mirror it.
  transform  Position and orient a part you have already built.
  merge      Collect parts into one output.

EVERY OPERATION AND THE FIELDS IT REQUIRES

The single worked example below cannot demonstrate all of these, so the exact
shape of each step is given here. A step missing a required field is rejected
and the whole recipe is rewritten, which is the most common way this task is
failed.

  sweep      id, note, curve, profile, material   (+ segments, scaleAlong, twistDegrees)
  revolve    id, note, outline, material          (+ segments, sweepDegrees)
  loft       id, note, sections, material         (+ closeRing, capStart, capEnd)
  primitive  id, note, shape, material            (+ centre, size, radius, segments)
  array      id, note, source, kind, count        (+ step | axis+radius+sweepDegrees | curve)
  boolean    id, note, mode, base, tools          — mode is union | subtract | intersect
                                                    base is one part id, tools is an array of ids
  deform     id, note, source, kind               (+ axis, about, amount, exponent, frequency)
  sculpt     id, note, source, brushes            (+ refine)
  transform  id, note, source, apply              — apply is { translate?, rotate?, scale? }
                                                    rotate is { axis: [x,y,z], degrees }
  mirror     id, note, source                     (+ axis: 'x' | 'y' | 'z')
  merge      id, note, sources                    — sources is an array of part ids

The fields source, base, tools and sources name steps built EARLIER in the list.
A step that builds new geometry (sweep, revolve, loft, primitive) needs a
material; one that transforms existing geometry does not, because it inherits
the material of what it operates on.

STEP 3 — Write the steps.
Every step carries a note saying what that part depicts and why it has that
shape. When a render comes back wrong, the note is what identifies which step is
responsible. Write it for someone debugging your work.

Steps run in order and may only reference parts built before them.

Most objects are 15 to 40 steps. Reach for more only when the object genuinely
has that many distinct parts — and remember that an array of forty identical
railings is one step, not forty. A hundred-step recipe is almost always a sign
that repeated parts were written out one at a time, and it will not fit in a
single answer.

Keep each note to one or two sentences — what the part is, and why it has that
shape. It is a debugging aid, not an essay: a recipe whose notes run to
paragraphs will not fit in one answer, and an answer that does not fit is
discarded whole.

RULES THAT ARE NOT NEGOTIABLE

- Units are metres, and the sizes must be real. A door is about 2m tall, a car
  about 4.5m long, a rose about 6cm across. targetSize is the finished bounding
  box.
- Detail belongs in the silhouette first, then in the parts the player gets
  close to. A hundred steps of ornament on an object seen at 30 metres is wasted
  and will breach the triangle budget.
- Prefer one continuous swept or lofted surface over several volumes stacked
  together. Stacked volumes read as stacked volumes.
- If the object has an opening, cut it with a boolean. Do not fake it with a
  dark-coloured face.
- Materials name a family from this list, and take their colour from the
  product's palette by index. You never specify a colour directly:
  ${MATERIAL_FAMILIES.join(', ')}.
- smoothness is 0, 1 or 2. Cost is roughly 4x per level. Use 2 only for a hero
  asset the player inspects closely.
- edgeSharpness is the single most important setting on a manufactured object.
  At 0 every edge melts under subdivision and the asset reads as CG whatever its
  materials are; around 0.8 the edges survive as small radii that catch a thin
  highlight, which is what a pressed panel or a machined block actually does. Set
  it for vehicles, weapons, architecture, furniture, machinery. Leave it at 0 for
  anything organic — a face, a creature, a plant — where there are no intended
  edges to keep.
- Keep the whole asset under 400,000 triangles. Objects made of many small
  repeated parts (foliage, chains, crowds) reach this far faster than you expect.

Return one JSON object and nothing else.`;
}

export interface LearnedExample {
  readonly title: string;
  readonly recipe: AssetRecipe;
  /** The score the critic gave this recipe when it was built. */
  readonly score: number;
}

/**
 * Few-shot examples, rendered as the model should produce them.
 *
 * The first built-in example is always included: it is the operator tour, and
 * it is what teaches the vocabulary. After that, examples earned by the library
 * — recipes that were actually built and passed a visual review — are preferred
 * over the remaining hand-written ones, because they are evidence of what works
 * in this pipeline rather than of what someone hoped would work.
 *
 * The count is capped at one by default, and that number is not about tokens
 * alone. An example does not only show the *form* of a recipe, it shows its
 * *scale*: given three complete recipes, two of them large vehicles, the author
 * wrote a twenty-thousand-token answer and ran off the end of its own output
 * limit — an unrecoverable failure, paid for twice. One compact example that
 * exercises every operator teaches the vocabulary without teaching the bloat,
 * and it cuts the prompt from sixteen thousand tokens to about six.
 */
export function recipeExamplePrompt(learned: readonly LearnedExample[] = [], limit = 1): string {
  const chosen: Array<{ title: string; recipe: AssetRecipe }> = [];
  const first = RECIPE_EXAMPLES[0];
  if (first) chosen.push(first);

  for (const example of [...learned].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= limit) break;
    chosen.push({ title: `${example.title} (scored ${Math.round(example.score)}/100 in review)`, recipe: example.recipe });
  }
  for (const example of RECIPE_EXAMPLES.slice(1)) {
    if (chosen.length >= limit) break;
    chosen.push(example);
  }

  return chosen
    .map((example) => `EXAMPLE — ${example.title}\n\n${JSON.stringify(example.recipe, null, 2)}`)
    .join('\n\n');
}

export interface AssetRequestBrief {
  /** What the programming agent asked for, in its own words. */
  readonly request: string;
  /** The product this asset belongs to; drives style coherence. */
  readonly productContext?: string;
  /** Art direction the whole product shares. */
  readonly artDirection?: string;
  /** How the asset is used, which governs where detail is worth spending. */
  readonly usage?: string;
  readonly targetSizeMetres?: readonly [number, number, number];
  /** Palette entries the recipe's colorIndex values will select from. */
  readonly palette?: readonly string[];
}

export function recipeUserPrompt(request: AssetRequestBrief): string {
  const lines = [`ASSET REQUESTED: ${request.request}`];
  if (request.productContext) lines.push(`PRODUCT: ${request.productContext}`);
  if (request.artDirection) lines.push(`ART DIRECTION: ${request.artDirection}`);
  if (request.usage) lines.push(`USAGE: ${request.usage}`);
  if (request.targetSizeMetres) {
    lines.push(`TARGET SIZE (metres, x/y/z): ${request.targetSizeMetres.join(' x ')}`);
  }
  if (request.palette && request.palette.length > 0) {
    lines.push(
      `PALETTE (reference by index):\n${request.palette.map((colour, index) => `  ${index}: ${colour}`).join('\n')}`,
    );
  }
  lines.push(
    '',
    'Write the brief first and let it decide the geometry. Then write the recipe.',
  );
  return lines.join('\n');
}

/**
 * The instruction used when a render has been reviewed and found wanting.
 *
 * The correction prompt carries the original brief, so the model is repairing
 * against the specification it wrote rather than against a vague sense that
 * something looked off.
 */
export function recipeRepairPrompt(failures: readonly string[], recipe: AssetRecipe): string {
  return `Your recipe was built, photographed and reviewed against your own acceptance criteria. It failed these:

${failures.map((failure, index) => `${index + 1}. ${failure}`).join('\n')}

These are the steps you wrote, in order:

${recipe.steps.map((step) => `  ${step.id} (${step.op}): ${step.note}`).join('\n')}

Fix the geometry that is actually responsible. The observations name the step to
blame; the notes above say what each step was for.

Return a PATCH, not a new recipe. Send back only what changes:

  reasoning       one or two sentences on why these changes answer the failures
  replaceSteps    complete replacement steps. A step whose id already exists
                  replaces it; a new id is appended to the end. Send the whole
                  step, not a fragment of one.
  removeStepIds   ids to delete outright
  outputs         only if the change alters which parts form the finished asset
  targetSize, edgeSharpness, smoothness, smoothAngleDegrees — only if wrong

Everything you do not mention stays exactly as it is. Do not resend steps that
were not at fault: geometry the reviewer did not complain about cannot be
improved by rewriting it, only damaged.

Do not weaken the brief to make a failure go away, and do not delete a part
rather than fixing it. The brief is the specification; it is the render that is
wrong.`;
}
