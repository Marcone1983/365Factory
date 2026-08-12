import { AssetRecipeSchema, type AssetRecipe } from './schema';

/**
 * Worked examples.
 *
 * These are shown to the model as few-shot references when it writes a recipe.
 * They are chosen to demonstrate the operators rather than to be reused: the
 * lantern exercises sweep, revolve, loft, radial array and a primitive, which
 * between them cover most of what any hard-surface object needs.
 *
 * They are also the standard for how much a brief is expected to say. A recipe
 * whose brief is thinner than these will produce geometry that is plausible and
 * wrong, and there will be nothing to catch it with — which is exactly what the
 * brief exists to prevent.
 *
 * They are parsed through the schema at import, so an example that drifts out
 * of spec fails the build rather than quietly teaching the model something the
 * interpreter will reject.
 */

/** A cast-iron street lantern: no dedicated generator exists for this. */
export const STREET_LANTERN: AssetRecipe = AssetRecipeSchema.parse({
  name: 'street_lantern',
  description: 'A Victorian cast-iron street lantern with a fluted post and a four-panel glazed housing.',

  brief: {
    subject: 'Victorian cast-iron street lantern on a fluted column',
    style:
      'British municipal ironwork, roughly 1880-1900. Heavy cast iron, moulded and turned rather than welded: every transition is a curve or a fillet, never a mitred joint. Restrained ornament — a stepped base, a swelling at the housing, a modest finial — not Gothic revival excess.',
    purpose:
      'Street dressing in a night-time urban level. Seen mostly in silhouette against sky at 5-20 metres, and up close only when the player walks past, so the housing deserves detail and the post does not.',

    mustRead: [
      'a tall slender post that visibly tapers from a thick base to a narrow neck',
      'a stepped, moulded foot where the post meets the ground, wider than the post itself',
      'a glazed lamp housing that flares outward from the post before closing back in at the top',
      'four slim vertical mullions dividing the glazing into panels',
      'a light source visible through the glass, not merely a glow on the surface',
      'a pointed finial capping the housing',
      'the housing sits clearly above the post rather than being an extension of it',
    ],

    silhouette:
      'As a black shape: a long thin vertical line, flared at the very bottom into a small skirt, widening near the top into a lantern shape roughly a fifth of the total height, then narrowing to a spike. The housing must read as a distinct mass at the top, not as a bulge in the post — the eye should find the break instantly.',

    proportions: [
      'total height about five times the housing height',
      'post diameter at the base roughly twice the diameter at the neck',
      'housing widest point about three times the post neck diameter',
      'the moulded foot is about 1.5 times as wide as the post base',
      'the finial is about a third of the housing height',
    ],

    surfaceNotes:
      'Iron painted matte black and weathered: broadly rough, with slight sheen on raised mouldings where hands and weather have polished it. Glass is clear and clean rather than frosted — the bulb must be legible through it. The lamp reads as warm sodium yellow, notably warmer than any moonlight in the scene.',

    avoid: [
      'a post of constant diameter, which reads as a pipe rather than a casting',
      'a housing that is simply a box stuck on the post with no flare or transition',
      'glazing so dark or frosted that the bulb cannot be seen through it',
      'a base so small that the lantern appears to be stabbed into the ground',
      'mullions thick enough to read as columns instead of glazing bars',
    ],

    acceptance: [
      'the post is visibly thicker at the bottom than at the top in a side view',
      'the glazed housing is distinguishable from the post as a separate mass',
      'the bulb is visible through the glazing from a three-quarter view',
      'four mullions are countable in a view from directly in front',
      'the foot flares out where the post meets the ground',
      'the finial comes to a point rather than ending flat',
    ],

    references: ['Victorian gas lamp standards', 'London Westminster lamp posts', 'Glasgow cast-iron lamp standards'],
  },

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
    {
      op: 'sweep',
      id: 'post',
      note: 'The column. Swept rather than a cylinder so it can taper: a constant-diameter post reads as plumbing, not as a casting. Superellipse exponent 3.2 gives the slightly squared section of a fluted shaft.',
      curve: { type: 'line', from: [0, 0, 0], to: [0, 2.4, 0] },
      profile: { type: 'superellipse', radiusX: 0.055, radiusY: 0.055, exponent: 3.2, segments: 16 },
      segments: 18,
      scaleAlong: { shape: 'easeOut', from: 1.6, to: 0.72, bias: 1.6 },
      material: 'iron',
    },
    {
      op: 'revolve',
      id: 'base',
      note: 'The moulded foot, revolved from its half-outline the way a turned part actually is. The steps in the outline are what make it read as cast iron rather than as a cone.',
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
    {
      op: 'loft',
      id: 'housing',
      note: 'The glazed lamp housing: narrow where it meets the post, flaring out to its widest just above, then closing back in toward the cap. The flare is what separates the housing from the post in silhouette.',
      sections: [
        { at: [0, 2.4, 0], profile: { type: 'rectangle', width: 0.2, height: 0.2, cornerRadius: 0.02, segments: 16 } },
        { at: [0, 2.55, 0], profile: { type: 'rectangle', width: 0.3, height: 0.3, cornerRadius: 0.03, segments: 16 } },
        { at: [0, 2.95, 0], profile: { type: 'rectangle', width: 0.26, height: 0.26, cornerRadius: 0.03, segments: 16 } },
        { at: [0, 3.05, 0], profile: { type: 'rectangle', width: 0.1, height: 0.1, cornerRadius: 0.02, segments: 16 } },
      ],
      material: 'glass',
    },
    {
      op: 'sweep',
      id: 'mullion',
      note: 'One glazing bar, spanning the full height of the glazed section. Kept slim — 22mm — so it reads as a bar holding glass, not as a corner column.',
      curve: { type: 'line', from: [0, 2.55, 0], to: [0, 2.95, 0] },
      profile: { type: 'rectangle', width: 0.022, height: 0.022, cornerRadius: 0.004, segments: 8 },
      segments: 3,
      material: 'iron',
    },
    {
      op: 'array',
      id: 'mullions',
      note: 'Four mullions on the housing corners, which is what divides the glazing into countable panels.',
      source: 'mullion',
      kind: 'radial',
      count: 4,
      axis: [0, 1, 0],
      radius: 0.135,
      sweepDegrees: 360,
    },
    {
      op: 'primitive',
      id: 'bulb',
      note: 'The lamp itself, inside the glazing rather than painted on it, so it is genuinely visible through the glass and casts light from the right place.',
      shape: 'sphere',
      centre: [0, 2.74, 0],
      radius: 0.07,
      segments: 18,
      material: 'lamp',
    },
    {
      op: 'revolve',
      id: 'finial',
      note: 'The cap, drawn to a point. Its outline ends at x=0 so the tip closes properly instead of leaving a flat disc.',
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
});

export { SUPERCAR } from './supercar';
export { JEEP } from './jeep';
export { AVATAR, AVATAR_PALETTE } from './avatar';

// Imported after STREET_LANTERN so the simpler example is read first.
import { SUPERCAR as SUPERCAR_RECIPE } from './supercar';
import { JEEP as JEEP_RECIPE } from './jeep';
import { AVATAR as AVATAR_RECIPE, AVATAR_PALETTE as AVATAR_COLOURS } from './avatar';

export interface RecipeExample {
  readonly title: string;
  readonly recipe: AssetRecipe;
  /**
   * The colours this example is authored against. A recipe never hardcodes a
   * colour — it indexes a palette — so an example without one would be built in
   * whatever colours the caller happened to have, and a dark-green utility 4x4
   * would arrive crimson.
   */
  readonly palette: readonly string[];
}

export const RECIPE_EXAMPLES: readonly RecipeExample[] = [
  {
    title: 'A Victorian cast-iron street lantern',
    recipe: STREET_LANTERN,
    palette: ['#12151a', '#1b1f26', '#cfe3ef', '#ffd79a', '#8892a0'],
  },
  {
    title: 'A mid-engined hypercar with cut wheel arches and a glazed cabin',
    recipe: SUPERCAR_RECIPE,
    palette: ['#8c1230', '#ff3355', '#c9d1de', '#101418', '#8892a0', '#555a63', '#17171b'],
  },
  {
    title: 'A boxy dark-green off-road utility 4x4',
    recipe: JEEP_RECIPE,
    palette: ['#4e7a52', '#2a2f2a', '#aeb8c4', '#0d1116', '#ffe9b8', '#15150f', '#1a1a14'],
  },
  {
    title: 'A human character with a modelled face and five-fingered hands',
    recipe: AVATAR_RECIPE,
    palette: AVATAR_COLOURS,
  },
];
