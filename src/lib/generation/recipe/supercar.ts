import { AssetRecipeSchema, type AssetRecipe } from './schema';

/**
 * A mid-engined supercar, written as a recipe.
 *
 * This is the hardest thing the language has been asked to describe, and it is
 * the one that proves the architecture: the previous hand-written vehicle
 * generator needed 600 lines of TypeScript across three files and could not cut
 * an opening in anything. Here the wheel arches are boolean subtractions, the
 * greenhouse is unioned into the lower body so there is no seam where a
 * separate volume would sit, and the whole thing is data.
 *
 * The section table is where the shape lives. Reading down the z column is
 * reading the car's side elevation; reading the widths is reading its plan.
 * That is how a car is actually surfaced, and it is why the result has a
 * silhouette rather than a bounding box.
 */
export const SUPERCAR: AssetRecipe = AssetRecipeSchema.parse({
  name: 'apex_hypercar',
  description: 'A mid-engined hypercar with a cab-forward greenhouse, cut wheel arches and a full-width rear light bar.',

  brief: {
    subject: 'Mid-engined two-seat hypercar, concept-car surfacing',
    style:
      'Contemporary European concept car in the manner of the Renault Trezor and DeZir: one continuous sculpted volume rather than a cabin sitting on a chassis, with a very low nose, a long cab-forward glasshouse and muscular rear haunches over the driven wheels. Surfaces are large and calm, broken by very few but very deliberate features. No fussy vents, no add-on spoilers, no aftermarket detailing.',
    purpose:
      'The player vehicle in a driving game. Seen from a chase camera at 5-15 metres for almost the entire play session, and in a garage screen up close. The silhouette and the surface highlights carry the whole impression; underbody detail is never seen.',

    mustRead: [
      'four wheels sitting inside cut arches, with a visible gap between the tyre and the arch lip',
      'a glasshouse that is clearly glazed and transparent, distinct from the painted body',
      'a windscreen raked far back, meeting a roof that flows into the rear deck without a step',
      'rear haunches wider than the cabin, swelling over the back wheels',
      'a nose noticeably lower than the tail, giving the car a forward-leaning stance',
      'a full-width light bar across the tail',
      'wheels with visible spokes, not solid discs',
      'the body reads as one continuous surface, not as a cabin placed on a base',
    ],

    silhouette:
      'As a black outline in side view: a long low wedge about four times as long as it is tall, lowest at the nose, rising in one unbroken curve through a glasshouse set well forward, cresting just behind the midpoint, then falling gently to a cut-off tail. Two deep arch openings interrupt the lower edge, each about a third of the height. The outline must never show a horizontal break between body and cabin — the whole profile is one line.',

    proportions: [
      'overall length about four times overall height',
      'wheelbase about 62% of overall length',
      'wheel diameter about 36% of overall height',
      'the glasshouse occupies the middle third of the length and about 35% of the height',
      'the rear track is wider than the cabin at its widest',
      'the nose sits about 25% lower than the highest point of the tail deck',
    ],

    surfaceNotes:
      'Deep metallic paint with a clearcoat: broad soft highlights that travel across the panels as the camera moves, not a flat matte colour. Glass is dark but genuinely transparent — the cabin interior should be implied through it. Tyres are matte black rubber with no sheen; rims are brushed metal that catches a hard specular.',

    avoid: [
      'wheels bolted to the outside of a slab body with no arch cut into it',
      'a cabin that reads as a separate box balanced on the body',
      'a nose and tail chopped flat, as though the model were sawn off at each end',
      'wheels sunk into the bodywork so no gap is visible at the arch',
      'glass so opaque that the car appears to have no windows',
      'a body of constant width down its whole length, with no haunches',
    ],

    acceptance: [
      'all four wheels are visible and each sits inside a cut arch with daylight between tyre and arch lip',
      'the glasshouse is visibly transparent and darker than the painted body',
      'the side silhouette shows one unbroken curve from nose to tail with no step at the cabin',
      'the rear of the car is visibly wider than the cabin when seen from above',
      'the nose is lower than the tail in a side view',
      'spokes are countable on at least one wheel',
      'the nose and tail are rounded rather than flat-cut faces',
    ],

    references: ['Renault Trezor concept', 'Renault DeZir concept', 'Ferrari 458 proportions', 'McLaren P1 glasshouse'],
  },

  targetSize: [2.02, 1.15, 4.6],
  smoothness: 1,
  smoothAngleDegrees: 52,
  uvProjection: 'box',
  uvScale: 0.35,

  materials: [
    { id: 'paint', family: 'car_paint', colorIndex: 0, clearcoat: 1, roughness: 0.22, textureScale: 1 },
    { id: 'glass', family: 'glass', colorIndex: 3, transmission: 0.86, roughness: 0.04, textureScale: 0.5 },
    { id: 'tyre', family: 'rubber', colorIndex: 6, roughness: 0.92, textureScale: 0.5 },
    { id: 'rim', family: 'metal_brushed', colorIndex: 2, metallic: 0.95, roughness: 0.28, textureScale: 0.5 },
    { id: 'lights', family: 'emissive_panel', colorIndex: 1, emissiveStrength: 7, textureScale: 0.25 },
  ],

  steps: [
    // ---------------------------------------------------------------- body --
    {
      op: 'loft',
      id: 'lower_body',
      note: 'The main volume. The widths are the whole point: the section swells to 1.02 over each axle and pulls in to 0.82 between them, which is what a haunch IS. A body of constant width leaves the wheels bolted to the outside with nothing covering them, and the car reads as a hovercraft with castors rather than as a car.',
      sections: [
        { at: [0, 0.42, -2.3], profile: { type: 'superellipse', radiusX: 0.4, radiusY: 0.14, exponent: 3.4, segments: 24 } },
        { at: [0, 0.44, -2.14], profile: { type: 'superellipse', radiusX: 0.78, radiusY: 0.27, exponent: 3.2, segments: 24 } },
        { at: [0, 0.45, -1.86], profile: { type: 'superellipse', radiusX: 0.95, radiusY: 0.34, exponent: 2.9, segments: 24 } },
        { at: [0, 0.46, -1.55], profile: { type: 'superellipse', radiusX: 1.02, radiusY: 0.38, exponent: 2.6, segments: 24 } },
        { at: [0, 0.46, -1.3], profile: { type: 'superellipse', radiusX: 1.02, radiusY: 0.38, exponent: 2.6, segments: 24 } },
        { at: [0, 0.45, -1.02], profile: { type: 'superellipse', radiusX: 0.94, radiusY: 0.37, exponent: 2.7, segments: 24 } },
        { at: [0, 0.44, -0.6], profile: { type: 'superellipse', radiusX: 0.83, radiusY: 0.36, exponent: 2.8, segments: 24 } },
        { at: [0, 0.43, 0.1], profile: { type: 'superellipse', radiusX: 0.82, radiusY: 0.34, exponent: 2.8, segments: 24 } },
        { at: [0, 0.42, 0.72], profile: { type: 'superellipse', radiusX: 0.88, radiusY: 0.32, exponent: 2.8, segments: 24 } },
        { at: [0, 0.42, 1.18], profile: { type: 'superellipse', radiusX: 0.99, radiusY: 0.3, exponent: 2.7, segments: 24 } },
        { at: [0, 0.41, 1.45], profile: { type: 'superellipse', radiusX: 0.99, radiusY: 0.29, exponent: 2.7, segments: 24 } },
        { at: [0, 0.38, 1.78], profile: { type: 'superellipse', radiusX: 0.86, radiusY: 0.25, exponent: 3.0, segments: 24 } },
        { at: [0, 0.33, 2.1], profile: { type: 'superellipse', radiusX: 0.62, radiusY: 0.19, exponent: 3.2, segments: 24 } },
        { at: [0, 0.29, 2.28], profile: { type: 'superellipse', radiusX: 0.32, radiusY: 0.1, exponent: 3.4, segments: 24 } },
      ],
      material: 'paint',
    },
    {
      op: 'loft',
      id: 'glasshouse',
      note: 'The cabin, lofted as its own volume so it can be glass, then unioned into the body below. Set forward of the midpoint and raked hard at the windscreen, which is what gives a mid-engined car its cab-forward stance.',
      sections: [
        { at: [0, 0.7, -1.02], profile: { type: 'superellipse', radiusX: 0.42, radiusY: 0.03, exponent: 3.0, segments: 24 } },
        { at: [0, 0.82, -0.72], profile: { type: 'superellipse', radiusX: 0.54, radiusY: 0.13, exponent: 2.6, segments: 24 } },
        { at: [0, 0.88, -0.2], profile: { type: 'superellipse', radiusX: 0.6, radiusY: 0.17, exponent: 2.4, segments: 24 } },
        { at: [0, 0.86, 0.3], profile: { type: 'superellipse', radiusX: 0.61, radiusY: 0.16, exponent: 2.4, segments: 24 } },
        { at: [0, 0.74, 0.78], profile: { type: 'superellipse', radiusX: 0.56, radiusY: 0.11, exponent: 2.6, segments: 24 } },
        { at: [0, 0.58, 1.14], profile: { type: 'superellipse', radiusX: 0.44, radiusY: 0.04, exponent: 3.0, segments: 24 } },
      ],
      material: 'glass',
    },
    {
      op: 'boolean',
      id: 'shell',
      note: 'Union rather than merge. Merging leaves the two surfaces interpenetrating, and the seam shows as a hard line along the belt where the cabin meets the body; a union resolves them into one closed skin.',
      mode: 'union',
      base: 'lower_body',
      tools: ['glasshouse'],
    },

    // --------------------------------------------------------- wheel arches --
    {
      op: 'primitive',
      id: 'arch_cutter_y',
      note: 'The arch cutting cylinder. Deliberately short: a cutter long enough to span the car bores a tunnel straight through it, removing the centre section along with both arches. Each arch is cut by its own copy placed at that wheel.',
      shape: 'cylinder',
      centre: [0, 0, 0],
      size: [1, 0.44, 1],
      radius: 0.4,
      segments: 28,
      material: 'paint',
    },
    {
      op: 'transform',
      id: 'arch_fl',
      note: 'Front left arch: the cutter laid across the car and placed over that wheel. Its radius exceeds the tyre radius, which is what leaves daylight between tyre and arch lip.',
      source: 'arch_cutter_y',
      apply: { rotate: { axis: [0, 0, 1], degrees: 90 }, translate: [-0.78, 0.38, 1.42] },
    },
    {
      op: 'transform',
      id: 'arch_fr',
      note: 'Front right arch.',
      source: 'arch_cutter_y',
      apply: { rotate: { axis: [0, 0, 1], degrees: 90 }, translate: [0.78, 0.38, 1.42] },
    },
    {
      op: 'transform',
      id: 'arch_rl',
      note: 'Rear left arch, set slightly wider to match the wider rear track.',
      source: 'arch_cutter_y',
      apply: { rotate: { axis: [0, 0, 1], degrees: 90 }, translate: [-0.8, 0.38, -1.42] },
    },
    {
      op: 'transform',
      id: 'arch_rr',
      note: 'Rear right arch.',
      source: 'arch_cutter_y',
      apply: { rotate: { axis: [0, 0, 1], degrees: 90 }, translate: [0.8, 0.38, -1.42] },
    },
    {
      op: 'boolean',
      id: 'body',
      note: 'The four arches cut into the shell. This is the operation the previous generator could not perform at all: without subtraction the wheels can only be bolted to the outside of an uncut slab.',
      mode: 'subtract',
      base: 'shell',
      tools: ['arch_fl', 'arch_fr', 'arch_rl', 'arch_rr'],
    },

    // ------------------------------------------------------------- lighting --
    {
      op: 'loft',
      id: 'tail_bar',
      note: 'Full-width rear light bar, sunk just into the tail. Emissive, so it reads at night, which is when this car will mostly be seen from behind.',
      sections: [
        { at: [0, 0.52, -2.24], profile: { type: 'rectangle', width: 1.44, height: 0.075, cornerRadius: 0.03, segments: 16 } },
        { at: [0, 0.52, -2.16], profile: { type: 'rectangle', width: 1.36, height: 0.06, cornerRadius: 0.025, segments: 16 } },
      ],
      material: 'lights',
    },
    {
      op: 'loft',
      id: 'headlamp_blade',
      note: 'One headlight: a thin blade swept back into the nose rather than a lamp stuck on the front, which is how concept cars integrate lighting.',
      sections: [
        { at: [0.5, 0.4, 2.14], profile: { type: 'rectangle', width: 0.36, height: 0.05, cornerRadius: 0.02, segments: 16 } },
        { at: [0.46, 0.41, 2.02], profile: { type: 'rectangle', width: 0.3, height: 0.04, cornerRadius: 0.015, segments: 16 } },
      ],
      material: 'lights',
    },
    {
      op: 'mirror',
      id: 'headlamps',
      note: 'Both headlights. Mirroring is how a symmetrical feature is built once and used twice.',
      source: 'headlamp_blade',
      axis: 'x',
    },

    // ---------------------------------------------------------------- wheel --
    {
      op: 'revolve',
      id: 'tyre',
      note: 'The tyre carcass, revolved from its cross-section: sidewall bulge, shoulder and a crowned tread. Revolving the real section is what gives a tyre its shape rather than a torus.',
      outline: [
        { x: 0.2, y: -0.135 },
        { x: 0.255, y: -0.15 },
        { x: 0.31, y: -0.135 },
        { x: 0.34, y: -0.085 },
        { x: 0.35, y: 0 },
        { x: 0.34, y: 0.085 },
        { x: 0.31, y: 0.135 },
        { x: 0.255, y: 0.15 },
        { x: 0.2, y: 0.135 },
      ],
      segments: 28,
      material: 'tyre',
    },
    {
      op: 'revolve',
      id: 'rim_barrel',
      note: 'The rim barrel inside the tyre, dished toward the outboard face the way a real wheel is.',
      outline: [
        { x: 0.05, y: -0.105 },
        { x: 0.2, y: -0.13 },
        { x: 0.21, y: 0.045 },
        { x: 0.1, y: 0.115 },
        { x: 0.04, y: 0.09 },
      ],
      segments: 24,
      material: 'rim',
    },
    {
      op: 'loft',
      id: 'spoke',
      note: 'One spoke, tapering outward from the hub. Spokes are what stop a wheel reading as a solid disc at any distance.',
      sections: [
        { at: [0, 0.06, 0.08], profile: { type: 'rectangle', width: 0.075, height: 0.05, cornerRadius: 0.012, segments: 12 } },
        { at: [0, 0.22, 0.06], profile: { type: 'rectangle', width: 0.05, height: 0.04, cornerRadius: 0.01, segments: 12 } },
      ],
      material: 'rim',
    },
    {
      op: 'array',
      id: 'spokes',
      note: 'Five spokes around the hub, the classic supercar wheel count.',
      source: 'spoke',
      kind: 'radial',
      count: 5,
      axis: [0, 0, 1],
      sweepDegrees: 360,
    },
    {
      op: 'merge',
      id: 'wheel_z',
      note: 'The complete wheel, still lying in its generated orientation with the axle along Z.',
      sources: ['tyre', 'rim_barrel', 'spokes'],
    },
    {
      op: 'transform',
      id: 'wheel',
      note: 'The wheel turned so its axle runs across the vehicle. revolve generates about Y, so the axle starts vertical and the wheel lies flat on the road; the rotation must be about Z to stand it up. Rotating about Y spins it on the spot and changes nothing, which is exactly the bug this note exists to prevent repeating.',
      source: 'wheel_z',
      apply: { rotate: { axis: [0, 0, 1], degrees: 90 } },
    },

    {
      op: 'transform',
      id: 'wheel_fl',
      note: 'Front left wheel, on the front axle and just inside the widest point of the front arch.',
      source: 'wheel',
      apply: { translate: [-0.78, 0.36, 1.42] },
    },
    {
      op: 'transform',
      id: 'wheel_fr',
      note: 'Front right wheel.',
      source: 'wheel',
      apply: { translate: [0.78, 0.36, 1.42] },
    },
    {
      op: 'transform',
      id: 'wheel_rl',
      note: 'Rear left wheel, set on a wider track than the front, which is what makes the rear haunches read as driven.',
      source: 'wheel',
      apply: { translate: [-0.8, 0.36, -1.42] },
    },
    {
      op: 'transform',
      id: 'wheel_rr',
      note: 'Rear right wheel.',
      source: 'wheel',
      apply: { translate: [0.8, 0.36, -1.42] },
    },
  ],

  outputs: ['body', 'tail_bar', 'headlamps', 'wheel_fl', 'wheel_fr', 'wheel_rl', 'wheel_rr'],
});
