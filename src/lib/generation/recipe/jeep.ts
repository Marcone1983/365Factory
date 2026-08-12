import { AssetRecipeSchema, type AssetRecipe } from './schema';

/**
 * A dark green off-road utility vehicle.
 *
 * Written to be as unlike the supercar as possible while using the same
 * operators, because that is the claim the recipe language has to survive: a
 * boxy, upright, hard-edged vehicle and a low sculpted one are the same
 * vocabulary with different numbers.
 *
 * The interesting difference is the exponent column. A supercar's sections are
 * near-elliptical (exponent ~2.6); this one runs 5-8, which pushes the
 * superellipse toward a rounded rectangle and gives the slab sides and hard
 * shoulders an off-roader has. Nothing else about the construction changes.
 */
export const JEEP: AssetRecipe = AssetRecipeSchema.parse({
  name: 'trail_utility_4x4',
  description: 'A dark green boxy off-road utility vehicle with a flat bonnet, upright glasshouse and exposed wheels.',

  brief: {
    subject: 'Boxy short-wheelbase off-road utility vehicle in dark green',
    style:
      'Utilitarian military-derived 4x4, in the lineage of the Willys MB and the Land Rover Defender. Everything is flat panel and hard fold: the bonnet is a flat plane, the sides are slabs, the corners are creases rather than curves. Function is legible everywhere — the shape exists to be repairable and to clear obstacles, not to be aerodynamic. Matte dark green with no gloss.',
    purpose:
      'A drivable vehicle in an off-road or wartime setting. Seen from a chase camera and from outside on foot, so the upright silhouette and the exposed running gear both matter.',

    mustRead: [
      'a flat horizontal bonnet clearly lower than the cabin roof',
      'an upright, nearly vertical windscreen rather than a raked one',
      'a squared-off cabin with flat slab sides',
      'four large exposed wheels standing proud of the body, under flared arches',
      'high ground clearance with a visible gap between the body and the ground',
      'a flat vertical grille at the front with vertical slots',
      'round headlamps set either side of the grille',
      'a spare wheel mounted on the flat rear panel',
    ],

    silhouette:
      'As a black outline in side view: a tall rectangle roughly one and a half times as long as it is tall, with a lower rectangular notch at the front for the bonnet. The roofline is flat and horizontal, the windscreen almost vertical, the rear end cut off square. Two large wheels sit clearly below the body with daylight between them and the sills. Nothing about the outline is streamlined — every transition is a right angle or close to it.',

    proportions: [
      'wheel diameter about 40% of overall height, notably larger than a road car',
      'bonnet height about 55% of roof height',
      'ground clearance about 15% of overall height',
      'the cabin occupies the rear 55% of the length',
      'track nearly as wide as the body, so the wheels sit at the corners',
    ],

    surfaceNotes:
      'Matte dark green paint, flat and chalky with almost no specular — a gloss finish immediately reads as a toy. Tyres are heavy matte black with a deep block tread. Grille and bumpers are darker than the body. Glass is neutral and only lightly tinted, since the cabin is a working space rather than a cockpit.',

    avoid: [
      'rounded, streamlined bodywork, which turns it into an SUV rather than a utility 4x4',
      'a raked windscreen',
      'wheels tucked under the body instead of standing at the corners',
      'low ground clearance',
      'glossy paint',
      'a bonnet that curves down into the grille rather than meeting it at an edge',
    ],

    acceptance: [
      'the windscreen is close to vertical in a side view, not raked back',
      'the bonnet is visibly a flat plane lower than the roof',
      'there is clear daylight between the underside of the body and the ground',
      'all four wheels stand outside or flush with the body sides, not tucked under',
      'the grille is a flat vertical face with countable vertical slots',
      'a spare wheel is visible on the rear panel',
      'the roofline is flat and horizontal',
    ],

    references: ['Willys MB', 'Land Rover Defender 90', 'Mercedes G-Wagen', 'Suzuki Jimny'],
  },

  targetSize: [1.9, 1.95, 3.9],
  smoothness: 1,
  edgeSharpness: 0.82,
  edgeAngleDegrees: 32,
  smoothAngleDegrees: 32,
  uvProjection: 'box',
  uvScale: 0.4,

  materials: [
    { id: 'body', family: 'fabric', colorIndex: 0, roughness: 0.86, metallic: 0.05, textureScale: 1 },
    { id: 'glass', family: 'glass', colorIndex: 3, transmission: 0.9, roughness: 0.05, textureScale: 0.5 },
    { id: 'tyre', family: 'rubber', colorIndex: 5, roughness: 0.95, textureScale: 0.5 },
    { id: 'rim', family: 'metal_worn', colorIndex: 1, metallic: 0.7, roughness: 0.5, textureScale: 0.5 },
    { id: 'trim', family: 'metal_worn', colorIndex: 1, roughness: 0.72, textureScale: 0.5 },
    { id: 'lights', family: 'emissive_panel', colorIndex: 4, emissiveStrength: 4, textureScale: 0.25 },
  ],

  steps: [
    {
      op: 'loft',
      id: 'hull',
      note: 'The tub: sills, floor and flat slab sides, running the full length. High exponents (6-8) push the superellipse toward a rounded rectangle, which is what gives the flat sides and hard shoulders a utility vehicle needs. This is the single change that separates this body from the supercar built with the same operator.',
      sections: [
        { at: [0, 0.78, -1.95], profile: { type: 'superellipse', radiusX: 0.86, radiusY: 0.36, exponent: 7, segments: 20 } },
        { at: [0, 0.78, -1.6], profile: { type: 'superellipse', radiusX: 0.9, radiusY: 0.38, exponent: 8, segments: 20 } },
        { at: [0, 0.78, -0.4], profile: { type: 'superellipse', radiusX: 0.9, radiusY: 0.38, exponent: 8, segments: 20 } },
        { at: [0, 0.78, 0.5], profile: { type: 'superellipse', radiusX: 0.9, radiusY: 0.38, exponent: 8, segments: 20 } },
        { at: [0, 0.76, 1.25], profile: { type: 'superellipse', radiusX: 0.88, radiusY: 0.36, exponent: 7, segments: 20 } },
        { at: [0, 0.74, 1.78], profile: { type: 'superellipse', radiusX: 0.84, radiusY: 0.33, exponent: 6, segments: 20 } },
        { at: [0, 0.74, 1.92], profile: { type: 'superellipse', radiusX: 0.8, radiusY: 0.3, exponent: 6, segments: 20 } },
      ],
      material: 'body',
    },
    {
      op: 'loft',
      id: 'bonnet',
      note: 'The bonnet: a flat plane sitting on top of the front of the tub, ending in a hard edge at the grille. Exponent 8 keeps it genuinely flat — anything lower rounds it down into the grille, which is one of the failure modes the brief calls out.',
      sections: [
        { at: [0, 1.18, 0.55], profile: { type: 'superellipse', radiusX: 0.82, radiusY: 0.06, exponent: 8, segments: 20 } },
        { at: [0, 1.17, 1.3], profile: { type: 'superellipse', radiusX: 0.8, radiusY: 0.06, exponent: 8, segments: 20 } },
        { at: [0, 1.16, 1.8], profile: { type: 'superellipse', radiusX: 0.76, radiusY: 0.055, exponent: 8, segments: 20 } },
        { at: [0, 1.15, 1.94], profile: { type: 'superellipse', radiusX: 0.72, radiusY: 0.05, exponent: 8, segments: 20 } },
      ],
      material: 'body',
    },
    {
      op: 'loft',
      id: 'cabin',
      note: 'The cabin box, from the almost-vertical windscreen base to the flat roof. The windscreen rakes back only 0.18m over 0.62m of height, which is roughly 16 degrees off vertical — a road car is nearer 60. Each section is centred on `at` and reaches radiusY above and below it, so the centres are placed to put every section BOTTOM at 1.14 — just inside the tub roof at 1.16. Read as bottoms rather than centres they leave the cabin hanging up to 40cm clear of the body, which is what this recipe used to do: a greenhouse floating over a bonnet, held up by nothing.',
      sections: [
        { at: [0, 1.22, 0.42], profile: { type: 'superellipse', radiusX: 0.8, radiusY: 0.08, exponent: 8, segments: 20 } },
        { at: [0, 1.36, 0.3], profile: { type: 'superellipse', radiusX: 0.82, radiusY: 0.22, exponent: 8, segments: 20 } },
        { at: [0, 1.58, 0.24], profile: { type: 'superellipse', radiusX: 0.84, radiusY: 0.44, exponent: 8, segments: 20 } },
        { at: [0, 1.6, -1.5], profile: { type: 'superellipse', radiusX: 0.84, radiusY: 0.46, exponent: 8, segments: 20 } },
        { at: [0, 1.57, -1.86], profile: { type: 'superellipse', radiusX: 0.8, radiusY: 0.43, exponent: 7, segments: 20 } },
      ],
      material: 'glass',
    },
    {
      op: 'boolean',
      id: 'shell',
      note: 'Tub, bonnet and cabin resolved into one closed skin. Union rather than merge: merged volumes interpenetrate and show a hard seam along every join.',
      mode: 'union',
      base: 'hull',
      tools: ['bonnet', 'cabin'],
    },

    // ------------------------------------------------------------- arches --
    {
      op: 'primitive',
      id: 'arch_cutter',
      note: 'The arch cutter, kept short so it opens one arch rather than boring a tunnel across the vehicle.',
      shape: 'cylinder',
      centre: [0, 0, 0],
      size: [1, 0.46, 1],
      radius: 0.5,
      segments: 24,
      material: 'body',
    },
    {
      op: 'transform',
      id: 'arch_fl',
      note: 'Front left arch. Generous radius against a 0.42m tyre, because an off-roader needs visible suspension travel above the wheel.',
      source: 'arch_cutter',
      apply: { rotate: { axis: [0, 0, 1], degrees: 90 }, translate: [-0.74, 0.5, 1.28] },
    },
    {
      op: 'transform',
      id: 'arch_fr',
      note: 'Front right arch.',
      source: 'arch_cutter',
      apply: { rotate: { axis: [0, 0, 1], degrees: 90 }, translate: [0.74, 0.5, 1.28] },
    },
    {
      op: 'transform',
      id: 'arch_rl',
      note: 'Rear left arch.',
      source: 'arch_cutter',
      apply: { rotate: { axis: [0, 0, 1], degrees: 90 }, translate: [-0.74, 0.5, -1.25] },
    },
    {
      op: 'transform',
      id: 'arch_rr',
      note: 'Rear right arch.',
      source: 'arch_cutter',
      apply: { rotate: { axis: [0, 0, 1], degrees: 90 }, translate: [0.74, 0.5, -1.25] },
    },
    {
      op: 'boolean',
      id: 'body_cut',
      note: 'The four arches cut into the shell.',
      mode: 'subtract',
      base: 'shell',
      tools: ['arch_fl', 'arch_fr', 'arch_rl', 'arch_rr'],
    },

    // -------------------------------------------------------------- front --
    {
      op: 'loft',
      id: 'grille',
      note: 'The flat vertical grille panel, standing proud of the nose so it reads as a separate face rather than as paint.',
      sections: [
        { at: [0, 0.98, 1.95], profile: { type: 'rectangle', width: 1.12, height: 0.46, cornerRadius: 0.03, segments: 16 } },
        { at: [0, 0.98, 2.02], profile: { type: 'rectangle', width: 1.06, height: 0.42, cornerRadius: 0.03, segments: 16 } },
      ],
      material: 'trim',
    },
    {
      op: 'loft',
      id: 'grille_slot',
      note: 'One vertical grille slot. Real geometry, not a texture: the slots have to be countable, which the brief makes an acceptance criterion.',
      sections: [
        { at: [-0.44, 0.98, 2.0], profile: { type: 'rectangle', width: 0.05, height: 0.34, cornerRadius: 0.012, segments: 12 } },
        { at: [-0.44, 0.98, 2.06], profile: { type: 'rectangle', width: 0.045, height: 0.32, cornerRadius: 0.01, segments: 12 } },
      ],
      material: 'body',
    },
    {
      op: 'array',
      id: 'grille_slots',
      note: 'Seven slots across the grille, evenly spaced — the count that reads as a utility vehicle rather than a truck.',
      source: 'grille_slot',
      kind: 'linear',
      count: 7,
      step: [0.148, 0, 0],
    },
    {
      op: 'revolve',
      id: 'headlamp',
      note: 'A round headlamp, which is the single most recognisable feature of this class of vehicle.',
      outline: [
        { x: 0.0, y: 0 },
        { x: 0.11, y: 0.01 },
        { x: 0.12, y: 0.05 },
        { x: 0.1, y: 0.08 },
        { x: 0.0, y: 0.085 },
      ],
      segments: 18,
      material: 'lights',
    },
    {
      op: 'transform',
      id: 'headlamp_l',
      note: 'Left headlamp, laid flat against the front face and set outboard of the grille.',
      source: 'headlamp',
      apply: { rotate: { axis: [1, 0, 0], degrees: 90 }, translate: [-0.68, 1.02, 1.97] },
    },
    {
      op: 'mirror',
      id: 'headlamps',
      note: 'Both headlamps.',
      source: 'headlamp_l',
      axis: 'x',
    },

    // --------------------------------------------------------------- wheel --
    {
      op: 'revolve',
      id: 'tyre',
      note: 'A tall off-road tyre with a square shoulder: the sidewall runs nearly straight out to the tread rather than bulging, which is what a heavy-duty carcass looks like.',
      outline: [
        { x: 0.22, y: -0.17 },
        { x: 0.33, y: -0.185 },
        { x: 0.41, y: -0.165 },
        { x: 0.425, y: -0.09 },
        { x: 0.43, y: 0 },
        { x: 0.425, y: 0.09 },
        { x: 0.41, y: 0.165 },
        { x: 0.33, y: 0.185 },
        { x: 0.22, y: 0.17 },
      ],
      segments: 26,
      material: 'tyre',
    },
    {
      op: 'revolve',
      id: 'rim_dish',
      note: 'A deep steel rim, dished well inboard the way a utility wheel is.',
      outline: [
        { x: 0.05, y: -0.13 },
        { x: 0.21, y: -0.16 },
        { x: 0.225, y: 0.06 },
        { x: 0.11, y: 0.14 },
        { x: 0.04, y: 0.11 },
      ],
      segments: 20,
      material: 'rim',
    },
    {
      op: 'primitive',
      id: 'lug',
      note: 'One wheel nut. Visible fasteners are part of why this class of vehicle reads as serviceable.',
      shape: 'cylinder',
      centre: [0, 0, 0.14],
      size: [1, 0.04, 1],
      radius: 0.022,
      segments: 8,
      material: 'rim',
    },
    {
      op: 'array',
      id: 'lugs',
      note: 'Five wheel nuts around the hub.',
      source: 'lug',
      kind: 'radial',
      count: 5,
      axis: [0, 0, 1],
      radius: 0.09,
      sweepDegrees: 360,
    },
    {
      op: 'merge',
      id: 'wheel_z',
      note: 'The complete wheel, still with its axle along Z as generated.',
      sources: ['tyre', 'rim_dish', 'lugs'],
    },
    {
      op: 'transform',
      id: 'wheel',
      note: 'The wheel turned so its axle runs across the vehicle. revolve generates about Y, so the axle starts vertical and the wheel lies flat on the road; the rotation must be about Z to stand it up. Rotating about Y spins it on the spot and changes nothing.',
      source: 'wheel_z',
      apply: { rotate: { axis: [0, 0, 1], degrees: 90 } },
    },
    {
      op: 'transform',
      id: 'wheel_fl',
      note: 'Front left wheel, standing at the corner rather than tucked under, which is what gives an off-roader its stance.',
      source: 'wheel',
      apply: { translate: [-0.76, 0.44, 1.28] },
    },
    { op: 'transform', id: 'wheel_fr', note: 'Front right wheel.', source: 'wheel', apply: { translate: [0.76, 0.44, 1.28] } },
    { op: 'transform', id: 'wheel_rl', note: 'Rear left wheel.', source: 'wheel', apply: { translate: [-0.76, 0.44, -1.25] } },
    { op: 'transform', id: 'wheel_rr', note: 'Rear right wheel.', source: 'wheel', apply: { translate: [0.76, 0.44, -1.25] } },
    {
      op: 'transform',
      id: 'spare_wheel',
      note: 'The spare, bolted flat to the rear panel. It is the same wheel mesh reused, which is what an array of parts is for.',
      source: 'wheel',
      apply: { rotate: { axis: [0, 1, 0], degrees: 90 }, translate: [0.12, 1.3, -2.06] },
    },

    // --------------------------------------------------------------- misc --
    {
      op: 'loft',
      id: 'front_bumper',
      note: 'A heavy square bumper, the kind that is a structural member rather than a trim piece.',
      sections: [
        { at: [0, 0.62, 1.98], profile: { type: 'rectangle', width: 1.72, height: 0.14, cornerRadius: 0.03, segments: 16 } },
        { at: [0, 0.62, 2.08], profile: { type: 'rectangle', width: 1.68, height: 0.12, cornerRadius: 0.03, segments: 16 } },
      ],
      material: 'trim',
    },
    {
      op: 'loft',
      id: 'rear_bumper',
      note: 'The matching rear bumper.',
      sections: [
        { at: [0, 0.62, -1.98], profile: { type: 'rectangle', width: 1.72, height: 0.14, cornerRadius: 0.03, segments: 16 } },
        { at: [0, 0.62, -2.06], profile: { type: 'rectangle', width: 1.68, height: 0.12, cornerRadius: 0.03, segments: 16 } },
      ],
      material: 'trim',
    },
  ],

  outputs: [
    'body_cut',
    'grille',
    'grille_slots',
    'headlamps',
    'front_bumper',
    'rear_bumper',
    'wheel_fl',
    'wheel_fr',
    'wheel_rl',
    'wheel_rr',
    'spare_wheel',
  ],
});
