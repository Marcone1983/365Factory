import { AssetRecipeSchema, type AssetRecipe } from './schema';

/**
 * Worked examples.
 *
 * These are shown to the model as few-shot references when it writes a recipe.
 * They are chosen to demonstrate the operators rather than to be reused: a
 * lantern exercises sweep, revolve, loft, radial array and a primitive, which
 * between them cover most of what any hard-surface object needs.
 *
 * They are also exercised by the test suite, so an example that stops building
 * fails the build rather than quietly teaching the model something that no
 * longer works.
 */

/** A cast-iron street lantern: no dedicated generator exists for this. */
// Parsed through the schema rather than cast, so the defaults are filled in and
// an example that drifts out of spec fails at import instead of teaching the
// model something the interpreter will reject.
export const STREET_LANTERN: AssetRecipe = AssetRecipeSchema.parse({
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
});

export const RECIPE_EXAMPLES: ReadonlyArray<{ readonly title: string; readonly recipe: AssetRecipe }> = [
  { title: 'A cast-iron street lantern', recipe: STREET_LANTERN },
];
