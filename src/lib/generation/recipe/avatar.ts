import { AssetRecipeSchema, type AssetRecipe } from './schema';

/**
 * A playable human character, built entirely from the recipe vocabulary.
 *
 * This is the hardest thing the kernel is asked to do, and it is the honest
 * test of whether the recipe language is general. A vehicle forgives a lot: it
 * is hard-surface, it is symmetric, and nobody can say from a render whether a
 * wheel arch is two centimetres too high. A face cannot be got approximately
 * right. Everyone alive has spent their whole life reading faces, so a nose
 * that emerges from the wrong depth or eyes set two millimetres too far apart
 * are noticed instantly, even by someone who cannot say what is wrong.
 *
 * Three decisions carry most of the quality:
 *
 *  1. **The head is a loft along the view axis, not a solid of revolution.** A
 *     revolve is the obvious way to make a head and it is a trap: it is
 *     rotationally symmetric, so it produces a skull that is exactly as deep as
 *     it is wide and has the same section at the brow as at the back. A real
 *     head is a long oval seen from above, flat across the face and round at
 *     the back. Sections along Z give that directly, and give control of the
 *     face plane where every feature is anchored.
 *
 *  2. **The features are unioned, not stacked.** The nose, the brow ridge, the
 *     cheekbones and the jaw are separate volumes booleaned into the skull, so
 *     the result is one continuous surface. Merged, they would read as parts
 *     laid on a head; unioned, they read as a head with those forms in it.
 *
 *  3. **The eyes sit in cut sockets.** A sphere pressed onto a face reads as a
 *     bead. The socket is subtracted first, so the eyeball sits inside a
 *     recess with a lid over it and the shadow falls where a shadow falls on a
 *     face.
 *
 * The hands are the other place a figure fails. Four fingers plus an opposed
 * thumb, each swept along its own slightly curled spline and tapering to the
 * tip, is the minimum that reads as a hand rather than as a mitten — and it is
 * cheap, because a finger is one swept profile.
 *
 * Everything is built for a figure standing at the origin facing +Z, one side
 * only, and mirrored across X at the end. Building both sides by hand is how
 * asymmetry creeps in.
 *
 * Palette (by index): 0 skin, 1 lip/inner tissue, 2 hair, 3 sclera, 4 iris,
 * 5 jacket, 6 trousers, 7 boots.
 */

/** Eye centres, brow and the face plane: everything on the head hangs off these. */
const EYE_Y = 1.678;
const EYE_X = 0.031;

export const AVATAR: AssetRecipe = AssetRecipeSchema.parse({
  name: 'field_scout_character',
  description:
    'A 1.78 m adult human field scout: an anatomically proportioned figure with a modelled face — brow, cheekbones, nose, lips, ears, eyes in cut sockets — and five-fingered hands, dressed in a fitted jacket, trousers and boots.',

  brief: {
    subject: 'Adult human field scout, standing at rest, in a fitted jacket, trousers and boots',
    style:
      'Contemporary realism at the fidelity of a modern third-person action game hero. Anatomy first: the figure is built from the skeleton outward, so the silhouette is governed by the ribcage, pelvis and shoulder girdle rather than by a smooth tube with limbs attached. Clothing is fitted and plain — no armour, no fantasy elements — because the character has to read as a person, not as a costume.',
    purpose:
      'The player character, seen over the shoulder at two to four metres for the whole game and in close-up in menus and dialogue. That means the face and the hands carry the asset: they are what the player looks at for hours, and every fault in them is a fault they will see a thousand times.',

    mustRead: [
      'a face with a recognisable nose that projects clearly forward of the cheeks in profile',
      'eyes set into cut sockets under a brow ridge, not spheres resting on the surface of the face',
      'lips that form two distinct volumes separated by a mouth line',
      'ears standing off the sides of the skull at the height between brow and nose base',
      'a jaw and chin that project forward of the neck, so the head is not an egg',
      'hands with four separate fingers and an opposed thumb, each tapering toward its tip',
      'a chest that is broader than the waist, and hips that widen again below it',
      'knees and elbows readable as joints where the limb changes direction',
      'a neck that emerges from between the shoulders rather than from the top of a barrel',
      'feet with a heel behind the ankle and a toe extending forward of it',
    ],

    silhouette:
      'As a black shape, an unmistakably human standing figure: head about one seventh of the total height, sitting on a neck narrower than the head; shoulders the widest point of the upper body at about a quarter of the height across; the outline drawing in at the waist and out again at the hips; arms hanging with a slight outward bow at the elbow and hands reaching to mid-thigh; legs converging slightly to the knee and again to the ankle before the foot breaks forward. In profile the silhouette must show the nose and chin projecting from the head, the chest ahead of the pelvis, and the heel behind the ankle — a profile with a flat face and a vertical spine reads as a mannequin.',

    proportions: [
      'total height about seven and a half head heights',
      'shoulder width about two and a half head widths',
      'the eyes sit at the vertical midpoint of the head, not above it',
      'the nose base is a third of the way from the eyes to the chin',
      'the ears span from the brow line to the base of the nose',
      'the hand is about the length of the face, chin to hairline',
      'the elbow sits level with the bottom of the ribcage, the wrist level with the crotch',
      'the knee is at the midpoint between hip and floor',
      'the head is about 15cm wide and 19cm deep — noticeably longer than it is broad',
    ],

    surfaceNotes:
      'Skin is dielectric and fairly rough, catching a broad soft highlight on the forehead, the nose and the cheekbones rather than a sharp one anywhere. The lips are smoother and slightly darker than the surrounding skin. The sclera is the brightest thing on the figure and the iris the darkest, and that contrast is what makes the gaze read at a distance. Jacket and trousers are matte woven fabric with no sheen; boots are the only part with any polish.',

    avoid: [
      'a head built as a solid of revolution, which is as deep as it is wide and has no face plane',
      'eyeballs sitting on the surface of the face instead of inside sockets',
      'a nose that does not clear the cheeks in a side view',
      'mitten hands, or fingers modelled as one block with grooves cut in it',
      'a torso of constant section, which reads as a barrel with limbs stuck on',
      'arms hanging from the sides of the neck rather than from the shoulder joints',
      'feet as flat slabs with no heel behind the ankle',
      'a neck as wide as the head, which makes the figure look like a thumb',
    ],

    acceptance: [
      'in the side view the nose projects clearly forward of the cheek and the chin forward of the neck',
      'in the front view two eyes are visible inside recessed sockets, not as protruding spheres',
      'the mouth reads as an upper and a lower lip with a line between them',
      'an ear is visible on the side of the head in the side and three-quarter views',
      'at least four separate fingers can be counted on a hand',
      'the silhouette narrows at the waist and widens again at the hips',
      'the head is longer front-to-back than it is wide when seen from above',
      'the feet show a heel behind the ankle in the side view',
    ],

    references: [
      'Vitruvian proportion canon',
      'Loomis head construction',
      'Bammes human anatomy for artists',
      'Andrew Loomis figure proportion charts',
    ],
  },

  targetSize: [0.62, 1.78, 0.44],
  smoothness: 1,
  smoothAngleDegrees: 150,
  uvProjection: 'cylindrical',
  uvScale: 1.4,

  materials: [
    { id: 'skin', family: 'skin', colorIndex: 0, roughness: 0.58, textureScale: 1 },
    { id: 'lip', family: 'skin', colorIndex: 1, roughness: 0.42, textureScale: 0.5 },
    { id: 'hair', family: 'hair', colorIndex: 2, roughness: 0.78, textureScale: 0.5 },
    { id: 'sclera', family: 'skin', colorIndex: 3, roughness: 0.16, textureScale: 0.25 },
    { id: 'iris', family: 'skin', colorIndex: 4, roughness: 0.1, textureScale: 0.25 },
    { id: 'jacket', family: 'fabric', colorIndex: 5, roughness: 0.82, textureScale: 1 },
    { id: 'trousers', family: 'fabric', colorIndex: 6, roughness: 0.86, textureScale: 1 },
    { id: 'boot', family: 'leather', colorIndex: 7, roughness: 0.46, textureScale: 0.5 },
  ],

  steps: [
    // ----------------------------------------------------------------- head --
    {
      op: 'loft',
      id: 'skull',
      note: 'The cranium, lofted front-to-back rather than revolved. A revolve makes a head exactly as deep as it is wide with the same section at the brow as at the back; sections along Z give a head that is long front-to-back and flat across the face. Every section centre sits at the same height on purpose: a loft orients each section to the direction its centre is travelling, so a centre that drifts 5mm over a 6mm step tilts that section 40 degrees and the front of the head bulges forward into a snout.',
      sections: [
        { at: [0, 1.664, -0.094], profile: { type: 'ellipse', radiusX: 0.024, radiusY: 0.03, segments: 32 } },
        { at: [0, 1.664, -0.08], profile: { type: 'ellipse', radiusX: 0.05, radiusY: 0.062, segments: 32 } },
        { at: [0, 1.664, -0.06], profile: { type: 'ellipse', radiusX: 0.068, radiusY: 0.09, segments: 32 } },
        { at: [0, 1.664, -0.032], profile: { type: 'ellipse', radiusX: 0.0765, radiusY: 0.106, segments: 32 } },
        { at: [0, 1.664, 0.0], profile: { type: 'ellipse', radiusX: 0.0785, radiusY: 0.114, segments: 32 } },
        { at: [0, 1.664, 0.03], profile: { type: 'ellipse', radiusX: 0.0775, radiusY: 0.114, segments: 32 } },
        { at: [0, 1.664, 0.054], profile: { type: 'ellipse', radiusX: 0.0735, radiusY: 0.112, segments: 32 } },
        { at: [0, 1.664, 0.07], profile: { type: 'ellipse', radiusX: 0.0685, radiusY: 0.106, segments: 32 } },
        { at: [0, 1.664, 0.082], profile: { type: 'ellipse', radiusX: 0.059, radiusY: 0.096, segments: 32 } },
        { at: [0, 1.664, 0.09], profile: { type: 'ellipse', radiusX: 0.043, radiusY: 0.076, segments: 32 } },
        { at: [0, 1.664, 0.095], profile: { type: 'ellipse', radiusX: 0.022, radiusY: 0.046, segments: 32 } },
      ],
      material: 'skin',
    },
    {
      op: 'loft',
      id: 'jaw_mass',
      note: 'The mandible and chin, projecting forward and down from the skull. Without it the head is an egg: the chin is what puts a front on the lower face, and it has to reach further forward than the cheeks do at the same height.',
      sections: [
        { at: [0, 1.607, -0.052], profile: { type: 'superellipse', radiusX: 0.064, radiusY: 0.044, exponent: 2.9, segments: 20 } },
        { at: [0, 1.605, -0.008], profile: { type: 'superellipse', radiusX: 0.066, radiusY: 0.046, exponent: 2.9, segments: 20 } },
        { at: [0, 1.603, 0.032], profile: { type: 'superellipse', radiusX: 0.062, radiusY: 0.044, exponent: 2.6, segments: 20 } },
        { at: [0, 1.601, 0.064], profile: { type: 'superellipse', radiusX: 0.052, radiusY: 0.04, exponent: 2.3, segments: 20 } },
        { at: [0, 1.6, 0.086], profile: { type: 'superellipse', radiusX: 0.035, radiusY: 0.031, exponent: 2.1, segments: 20 } },
        { at: [0, 1.599, 0.098], profile: { type: 'superellipse', radiusX: 0.016, radiusY: 0.018, exponent: 2, segments: 20 } },
      ],
      material: 'skin',
    },
    {
      op: 'boolean',
      id: 'head_jaw',
      note: 'The jaw fused into the skull as one continuous surface. Merged instead of unioned it would read as a chin laid on a head, with a visible seam exactly where the eye looks first.',
      mode: 'union',
      base: 'skull',
      tools: ['jaw_mass'],
    },
    {
      op: 'sweep',
      id: 'brow_ridge',
      note: 'The supraorbital ridge, swept across the face on a curve that bows forward over each eye and returns at the temples. This is the shelf the eyes sit under; without it there is no shadow over the eye and the face reads as a doll.',
      curve: {
        type: 'bezier',
        p0: [-0.068, 1.699, 0.026],
        p1: [-0.034, 1.702, 0.088],
        p2: [0.034, 1.702, 0.088],
        p3: [0.068, 1.699, 0.026],
      },
      profile: { type: 'ellipse', radiusX: 0.0102, radiusY: 0.0082, segments: 12 },
      segments: 22,
      scaleAlong: { shape: 'bell', from: 0.45, to: 1.0, bias: 1 },
      material: 'skin',
    },
    {
      op: 'boolean',
      id: 'head_brow',
      note: 'The brow fused in. It has to be part of the skull surface, because the socket is cut through it in the next steps and a cut through a merged part would leave the two surfaces floating.',
      mode: 'union',
      base: 'head_jaw',
      tools: ['brow_ridge'],
    },
    {
      op: 'sweep',
      id: 'cheek_bone',
      note: 'One zygomatic arch, running from beside the nose out and back toward the ear. The cheekbone is what gives a face its width at eye level and the plane change below it; a face without one is a balloon.',
      curve: {
        type: 'bezier',
        p0: [0.021, 1.653, 0.0835],
        p1: [0.046, 1.654, 0.0725],
        p2: [0.062, 1.658, 0.034],
        p3: [0.068, 1.662, -0.004],
      },
      profile: { type: 'ellipse', radiusX: 0.011, radiusY: 0.009, segments: 12 },
      segments: 16,
      scaleAlong: { shape: 'bell', from: 0.4, to: 1.0, bias: 1.2 },
      material: 'skin',
    },
    {
      op: 'mirror',
      id: 'cheek_bones',
      note: 'Both cheekbones. Mirroring rather than writing the second one keeps the face symmetric — a face modelled side by side by hand acquires an asymmetry that reads as a deformity.',
      source: 'cheek_bone',
      axis: 'x',
    },
    {
      op: 'boolean',
      id: 'head_cheeks',
      note: 'Cheekbones fused into the skull, completing the bone structure the soft features are then placed on.',
      mode: 'union',
      base: 'head_brow',
      tools: ['cheek_bones'],
    },
    {
      op: 'loft',
      id: 'nose',
      note: 'The nose: bridge, ball and the underside sweeping back to the base. Its first section starts inside the skull so the union has material to fuse with, and the ball reaches z=0.112 — around two centimetres clear of the cheek, which is what makes it project in profile.',
      sections: [
        { at: [0, 1.694, 0.062], profile: { type: 'ellipse', radiusX: 0.0058, radiusY: 0.006, segments: 16 } },
        { at: [0, 1.687, 0.082], profile: { type: 'ellipse', radiusX: 0.0064, radiusY: 0.0068, segments: 16 } },
        { at: [0, 1.676, 0.098], profile: { type: 'ellipse', radiusX: 0.0076, radiusY: 0.0076, segments: 16 } },
        { at: [0, 1.66, 0.106], profile: { type: 'ellipse', radiusX: 0.0098, radiusY: 0.009, segments: 16 } },
        { at: [0, 1.649, 0.112], profile: { type: 'ellipse', radiusX: 0.0128, radiusY: 0.0104, segments: 16 } },
        { at: [0, 1.643, 0.113], profile: { type: 'ellipse', radiusX: 0.0138, radiusY: 0.0098, segments: 16 } },
        { at: [0, 1.639, 0.107], profile: { type: 'ellipse', radiusX: 0.0134, radiusY: 0.0078, segments: 16 } },
        { at: [0, 1.637, 0.097], profile: { type: 'ellipse', radiusX: 0.0114, radiusY: 0.006, segments: 16 } },
      ],
      material: 'skin',
    },
    {
      op: 'boolean',
      id: 'head_nose',
      note: 'The nose fused into the face. A merged nose leaves a hard crease all round its base where a real nose blends into the cheek over about a centimetre.',
      mode: 'union',
      base: 'head_cheeks',
      tools: ['nose'],
    },
    {
      op: 'primitive',
      id: 'nostril_cut',
      note: 'One nostril, cut rather than painted. A dark spot on the underside of a nose is visible as a dark spot; a hole reads as a hole from every angle.',
      shape: 'sphere',
      centre: [0.0074, 1.6365, 0.103],
      radius: 0.0044,
      segments: 12,
      material: 'skin',
    },
    {
      op: 'mirror',
      id: 'nostril_cuts',
      note: 'Both nostrils, mirrored so they are the same size — which they must be, because the eye reads a difference of a millimetre here as a broken nose.',
      source: 'nostril_cut',
      axis: 'x',
    },
    {
      op: 'boolean',
      id: 'head_nostrils',
      note: 'The nostrils subtracted from the head, leaving two openings in the underside of the nose.',
      mode: 'subtract',
      base: 'head_nose',
      tools: ['nostril_cuts'],
    },
    {
      op: 'primitive',
      id: 'socket_cut',
      note: 'One eye socket, subtracted from the skull before the eyeball goes in. This is what makes the eye sit inside the head: a sphere placed on an uncut face reads as a bead stuck to it, whatever else is done around it.',
      shape: 'sphere',
      centre: [0.0325, 1.6772, 0.0885],
      radius: 0.0168,
      segments: 16,
      material: 'skin',
    },
    {
      op: 'mirror',
      id: 'socket_cuts',
      note: 'Both sockets. Their separation — 62mm between centres — is the single measurement a viewer is most sensitive to on a face.',
      source: 'socket_cut',
      axis: 'x',
    },
    {
      op: 'boolean',
      id: 'head_sockets',
      note: 'The sockets cut into the face, leaving two recesses under the brow ridge for the eyeballs.',
      mode: 'subtract',
      base: 'head_nostrils',
      tools: ['socket_cuts'],
    },
    {
      op: 'sweep',
      id: 'lip_upper',
      note: 'The upper lip, swept across the mouth on a curve that bows forward and dips at the centre, so it carries the cupid‑s bow rather than being a straight bar.',
      curve: {
        type: 'spline',
        points: [
          [-0.027, 1.6105, 0.0785],
          [-0.0132, 1.6138, 0.0912],
          [0.0, 1.6122, 0.0935],
          [0.0132, 1.6138, 0.0912],
          [0.027, 1.6105, 0.0785],
        ],
        closed: false,
      },
      profile: { type: 'ellipse', radiusX: 0.0062, radiusY: 0.0044, segments: 12 },
      segments: 18,
      scaleAlong: { shape: 'bell', from: 0.5, to: 1.15, bias: 1.1 },
      material: 'lip',
    },
    {
      op: 'sweep',
      id: 'lip_lower',
      note: 'The lower lip, fuller than the upper one and set very slightly further back. Two separate volumes with a gap between them is what produces a mouth; one volume with a groove scratched in it does not.',
      curve: {
        type: 'spline',
        points: [
          [-0.0258, 1.6035, 0.0778],
          [-0.012, 1.6012, 0.0905],
          [0.0, 1.6006, 0.0928],
          [0.012, 1.6012, 0.0905],
          [0.0258, 1.6035, 0.0778],
        ],
        closed: false,
      },
      profile: { type: 'ellipse', radiusX: 0.0068, radiusY: 0.0054, segments: 12 },
      segments: 18,
      scaleAlong: { shape: 'bell', from: 0.5, to: 1.2, bias: 1.1 },
      material: 'lip',
    },
    {
      op: 'primitive',
      id: 'mouth_line_cut',
      note: 'A thin wedge subtracted along the join of the lips. The lips are built touching so the mouth is closed; this cut is what turns the contact into a visible line from a distance where a shading difference would disappear.',
      shape: 'box',
      centre: [0, 1.6068, 0.089],
      size: [0.066, 0.0016, 0.028],
      segments: 4,
      material: 'lip',
    },
    {
      op: 'boolean',
      id: 'mouth',
      note: 'The two lips joined and then split by the mouth line, so they read as one mouth with an opening rather than as two sausages.',
      mode: 'subtract',
      base: 'lip_upper',
      tools: ['mouth_line_cut'],
    },
    {
      op: 'merge',
      id: 'lips',
      note: 'Upper and lower lip together. They are kept out of the head union deliberately: they carry their own material, and a boolean would weld them into the skin and lose the colour break at the lip line.',
      sources: ['mouth', 'lip_lower'],
    },
    {
      op: 'primitive',
      id: 'eyeball',
      note: 'One eyeball, 24mm across as a real one is, seated inside the cut socket so the lids cross it rather than clip it.',
      shape: 'sphere',
      centre: [0.0325, 1.677, 0.0845],
      radius: 0.0118,
      segments: 20,
      material: 'sclera',
    },
    {
      op: 'mirror',
      id: 'eyeballs',
      note: 'Both eyeballs, mirrored so the gaze is level. An eye a millimetre higher than its fellow is read instantly as a face that is wrong without the viewer knowing why.',
      source: 'eyeball',
      axis: 'x',
    },
    {
      op: 'primitive',
      id: 'iris',
      note: 'The iris, a small dark cap set on the front of the eyeball. The dark-against-white contrast is what makes a gaze legible at conversational distance, and it is the reason the eye is two materials rather than one.',
      shape: 'sphere',
      centre: [0.0325, 1.677, 0.0928],
      radius: 0.0068,
      segments: 14,
      material: 'iris',
    },
    {
      op: 'mirror',
      id: 'irises',
      note: 'Both irises, aimed straight ahead so the character meets the camera.',
      source: 'iris',
      axis: 'x',
    },
    {
      op: 'sweep',
      id: 'lid_upper',
      note: 'The upper eyelid, swept as an arc across the top of the eyeball. It covers the top sixth of the eye, which is what real lids do at rest and what stops the character looking startled.',
      curve: {
        type: 'spline',
        points: [
          [0.0168, 1.6802, 0.0838],
          [0.0262, 1.6862, 0.0938],
          [0.0352, 1.6866, 0.0954],
          [0.0448, 1.6806, 0.0851],
        ],
        closed: false,
      },
      profile: { type: 'ellipse', radiusX: 0.0058, radiusY: 0.005, segments: 10 },
      segments: 14,
      scaleAlong: { shape: 'bell', from: 0.55, to: 1.15, bias: 1 },
      material: 'skin',
    },
    {
      op: 'sweep',
      id: 'lid_lower',
      note: 'The lower lid, thinner than the upper one and sitting on the bottom of the eyeball. It closes the socket underneath so the eye is not a sphere in an open pit.',
      curve: {
        type: 'spline',
        points: [
          [0.0172, 1.6748, 0.0838],
          [0.0264, 1.6714, 0.0944],
          [0.0354, 1.6714, 0.0958],
          [0.0446, 1.6752, 0.0851],
        ],
        closed: false,
      },
      profile: { type: 'ellipse', radiusX: 0.0048, radiusY: 0.0042, segments: 10 },
      segments: 14,
      scaleAlong: { shape: 'bell', from: 0.55, to: 1.05, bias: 1 },
      material: 'skin',
    },
    {
      op: 'merge',
      id: 'lid_pair',
      note: 'One eye_s pair of lids, collected so a single mirror produces both eyes rather than four separate steps.',
      sources: ['lid_upper', 'lid_lower'],
    },
    {
      op: 'mirror',
      id: 'lids',
      note: 'Lids on both eyes.',
      source: 'lid_pair',
      axis: 'x',
    },
    {
      op: 'loft',
      id: 'ear',
      note: 'One ear, lofted front-to-back so it is a thin shell standing proud of the skull. Its centre sits at x=0.076, which puts most of its thickness outside the head, and it spans from the brow line to the base of the nose as a real ear does.',
      sections: [
        { at: [0.0705, 1.663, -0.026], profile: { type: 'ellipse', radiusX: 0.0038, radiusY: 0.014, segments: 14 } },
        { at: [0.0745, 1.669, -0.008], profile: { type: 'ellipse', radiusX: 0.0078, radiusY: 0.028, segments: 14 } },
        { at: [0.0765, 1.671, 0.008], profile: { type: 'ellipse', radiusX: 0.0086, radiusY: 0.031, segments: 14 } },
        { at: [0.0752, 1.668, 0.023], profile: { type: 'ellipse', radiusX: 0.0072, radiusY: 0.027, segments: 14 } },
        { at: [0.0722, 1.661, 0.034], profile: { type: 'ellipse', radiusX: 0.004, radiusY: 0.016, segments: 14 } },
      ],
      material: 'skin',
    },
    {
      op: 'primitive',
      id: 'concha_cut',
      note: 'The bowl of the ear, subtracted from the outer shell. An ear without a hollow is a flap; the shadow inside the bowl is most of what identifies it at a distance.',
      shape: 'sphere',
      centre: [0.0962, 1.6705, 0.006],
      radius: 0.016,
      segments: 12,
      material: 'skin',
    },
    {
      op: 'boolean',
      id: 'ear_shaped',
      note: 'The bowl cut into the ear, leaving a rim standing round a recess.',
      mode: 'subtract',
      base: 'ear',
      tools: ['concha_cut'],
    },
    {
      op: 'mirror',
      id: 'ears',
      note: 'Both ears at the same height, which is what the side and three-quarter views are checked on.',
      source: 'ear_shaped',
      axis: 'x',
    },
    {
      op: 'loft',
      id: 'hair_shell',
      note: 'The hair as a shell a centimetre proud of the skull, following the same sections so it sits on the head instead of hovering. It is cut back to a hairline in the next steps rather than being modelled as a cap, because the hairline is what places the forehead.',
      sections: [
        { at: [0, 1.701, -0.101], profile: { type: 'ellipse', radiusX: 0.027, radiusY: 0.034, segments: 22 } },
        { at: [0, 1.695, -0.086], profile: { type: 'ellipse', radiusX: 0.054, radiusY: 0.067, segments: 22 } },
        { at: [0, 1.686, -0.064], profile: { type: 'ellipse', radiusX: 0.072, radiusY: 0.093, segments: 22 } },
        { at: [0, 1.676, -0.032], profile: { type: 'ellipse', radiusX: 0.0805, radiusY: 0.109, segments: 22 } },
        { at: [0, 1.671, 0.0], profile: { type: 'ellipse', radiusX: 0.0825, radiusY: 0.117, segments: 22 } },
        { at: [0, 1.667, 0.03], profile: { type: 'ellipse', radiusX: 0.0815, radiusY: 0.117, segments: 22 } },
        { at: [0, 1.664, 0.054], profile: { type: 'ellipse', radiusX: 0.0775, radiusY: 0.115, segments: 22 } },
        { at: [0, 1.661, 0.072], profile: { type: 'ellipse', radiusX: 0.07, radiusY: 0.109, segments: 22 } },
      ],
      material: 'hair',
    },
    {
      op: 'primitive',
      id: 'hairline_cut',
      note: 'The block that removes the hair from the face. Everything forward of the temples and below the hairline is cut away, which is what leaves a forehead and lets the ears show.',
      shape: 'box',
      centre: [0, 1.5, 0.118],
      size: [0.34, 0.42, 0.185],
      segments: 4,
      material: 'hair',
    },
    {
      op: 'primitive',
      id: 'napeline_cut',
      note: 'The block that takes the hair off the neck and the lower skull at the back. Without it the shell reaches the jawline all the way round and the character wears a bob.',
      shape: 'box',
      centre: [0, 1.49, -0.04],
      size: [0.4, 0.34, 0.34],
      segments: 4,
      material: 'hair',
    },
    {
      op: 'boolean',
      id: 'hair',
      note: 'The hair shell cut back to a hairline at the front and a nape line at the back, leaving hair over the crown and the upper back of the skull only.',
      mode: 'subtract',
      base: 'hair_shell',
      tools: ['hairline_cut', 'napeline_cut'],
    },
    {
      op: 'sweep',
      id: 'eyebrow',
      note: 'One eyebrow, swept along the top of the brow ridge in the hair material. Brows carry more of a face_s expression than any other feature of comparable size, and their absence is why an untextured head looks blank.',
      curve: {
        type: 'spline',
        points: [
          [0.016, 1.6918, 0.0968],
          [0.0294, 1.6938, 0.0971],
          [0.043, 1.6922, 0.0892],
          [0.056, 1.6888, 0.0722],
        ],
        closed: false,
      },
      profile: { type: 'ellipse', radiusX: 0.0052, radiusY: 0.0028, segments: 10 },
      segments: 14,
      scaleAlong: { shape: 'bell', from: 0.7, to: 1.1, bias: 1 },
      material: 'hair',
    },
    {
      op: 'mirror',
      id: 'eyebrows',
      note: 'Both brows, level with each other.',
      source: 'eyebrow',
      axis: 'x',
    },

    // ----------------------------------------------------------- upper body --
    {
      op: 'sweep',
      id: 'neck',
      note: 'The neck, swept vertically and thickening toward the base where the trapezius carries it into the shoulders. A neck of constant thickness makes the head look screwed on.',
      curve: { type: 'line', from: [0, 1.352, -0.004], to: [0, 1.556, 0.0] },
      profile: { type: 'superellipse', radiusX: 0.058, radiusY: 0.055, exponent: 2.4, segments: 20 },
      segments: 8,
      scaleAlong: { shape: 'easeOut', from: 1.36, to: 0.8, bias: 1.6 },
      material: 'skin',
    },
    {
      op: 'sweep',
      id: 'torso',
      note: 'The trunk from hips to collar in the jacket material. The keyed scale is the whole shape: 0.95 at the hips, pulling to 0.84 at the waist, swelling to 1.1 across the shoulders, then closing hard to 0.54 at the top so the last section forms a collar. Without the collar the neck emerges from a flat-topped barrel and sixteen centimetres of it are bare, which is what makes a figure look like a giraffe.',
      curve: { type: 'line', from: [0, 0.9, 0.0], to: [0, 1.478, 0.008] },
      profile: { type: 'superellipse', radiusX: 0.112, radiusY: 0.163, exponent: 2.7, segments: 28 },
      segments: 26,
      scaleAlong: {
        keys: [
          { t: 0, value: 0.95 },
          { t: 0.19, value: 0.84 },
          { t: 0.39, value: 0.96 },
          { t: 0.63, value: 1.06 },
          { t: 0.8, value: 1.1 },
          { t: 0.87, value: 1.03 },
          { t: 1, value: 0.54 },
        ],
      },
      material: 'jacket',
    },
    {
      op: 'sweep',
      id: 'hips',
      note: 'The pelvis, wider than the waist and deeper than the ribcage. It is a separate sweep in the trouser material so the waistband falls where a waistband falls.',
      curve: { type: 'line', from: [0, 0.8, 0.0], to: [0, 0.96, 0.0] },
      profile: { type: 'superellipse', radiusX: 0.098, radiusY: 0.15, exponent: 2.9, segments: 24 },
      segments: 6,
      scaleAlong: { shape: 'bell', from: 0.86, to: 1.02, bias: 1.4 },
      material: 'trousers',
    },
    {
      op: 'primitive',
      id: 'shoulder',
      note: 'The deltoid capping the shoulder joint. The arm has to hang from a ball here, not from the side of the ribcage, or the figure reads as having its arms attached to its neck.',
      shape: 'sphere',
      centre: [0.178, 1.352, 0.004],
      radius: 0.068,
      segments: 18,
      material: 'jacket',
    },

    // ------------------------------------------------------------ right arm --
    {
      op: 'sweep',
      id: 'upper_arm',
      note: 'Humerus to elbow, angling very slightly outward as a relaxed arm does, and tapering from the deltoid to the joint.',
      curve: { type: 'line', from: [0.179, 1.358, 0.004], to: [0.198, 1.1, 0.012] },
      profile: { type: 'ellipse', radiusX: 0.053, radiusY: 0.053, segments: 16 },
      segments: 10,
      scaleAlong: { shape: 'easeIn', from: 1.04, to: 0.76, bias: 1.3 },
      material: 'jacket',
    },
    {
      op: 'primitive',
      id: 'elbow',
      note: 'The elbow, a joint the arm visibly changes direction at. Two tapered tubes meeting without one produce a kink that reads as a break.',
      shape: 'sphere',
      centre: [0.198, 1.1, 0.012],
      radius: 0.041,
      segments: 14,
      material: 'jacket',
    },
    {
      op: 'sweep',
      id: 'forearm',
      note: 'Elbow to wrist, thickest just below the elbow where the forearm muscles sit and narrowing to the wrist, which is the thinnest part of the whole arm.',
      curve: { type: 'line', from: [0.198, 1.1, 0.012], to: [0.217, 0.862, 0.022] },
      profile: { type: 'ellipse', radiusX: 0.045, radiusY: 0.045, segments: 16 },
      segments: 10,
      scaleAlong: {
        keys: [
          { t: 0, value: 0.98 },
          { t: 0.25, value: 1.02 },
          { t: 1, value: 0.62 },
        ],
      },
      material: 'jacket',
    },
    {
      op: 'sweep',
      id: 'palm',
      note: 'The palm: broad front-to-back, thin across, because a hand hanging at rest presents its edge to the viewer. In a vertical sweep the profile_s x lies along Z and its y along X, so the 42mm half-width here is the hand_s breadth and the 13mm is its thickness.',
      curve: { type: 'line', from: [0.218, 0.855, 0.02], to: [0.222, 0.762, 0.018] },
      profile: { type: 'superellipse', radiusX: 0.042, radiusY: 0.0135, exponent: 2.8, segments: 20 },
      segments: 6,
      scaleAlong: {
        keys: [
          { t: 0, value: 0.78 },
          { t: 0.35, value: 1.0 },
          { t: 1, value: 0.96 },
        ],
      },
      material: 'skin',
    },
    {
      op: 'sweep',
      id: 'finger_index',
      note: 'The index finger, swept along its own spline with a slight curl and tapering to the tip. One sweep per finger is what separates a hand from a mitten, and it costs almost nothing.',
      curve: {
        type: 'spline',
        points: [
          [0.222, 0.766, 0.05],
          [0.223, 0.73, 0.049],
          [0.224, 0.702, 0.043],
          [0.2245, 0.686, 0.032],
        ],
        closed: false,
      },
      profile: { type: 'ellipse', radiusX: 0.0092, radiusY: 0.0092, segments: 10 },
      segments: 10,
      scaleAlong: { shape: 'easeIn', from: 1.0, to: 0.68, bias: 1.2 },
      material: 'skin',
    },
    {
      op: 'sweep',
      id: 'finger_middle',
      note: 'The middle finger, the longest of the four, reaching about a centimetre below the index.',
      curve: {
        type: 'spline',
        points: [
          [0.222, 0.766, 0.028],
          [0.223, 0.726, 0.027],
          [0.224, 0.696, 0.021],
          [0.2245, 0.678, 0.009],
        ],
        closed: false,
      },
      profile: { type: 'ellipse', radiusX: 0.0095, radiusY: 0.0095, segments: 10 },
      segments: 10,
      scaleAlong: { shape: 'easeIn', from: 1.0, to: 0.68, bias: 1.2 },
      material: 'skin',
    },
    {
      op: 'sweep',
      id: 'finger_ring',
      note: 'The ring finger, slightly shorter than the middle and set behind it in the hand_s breadth.',
      curve: {
        type: 'spline',
        points: [
          [0.222, 0.766, 0.006],
          [0.223, 0.728, 0.005],
          [0.224, 0.7, -0.002],
          [0.2245, 0.684, -0.013],
        ],
        closed: false,
      },
      profile: { type: 'ellipse', radiusX: 0.009, radiusY: 0.009, segments: 10 },
      segments: 10,
      scaleAlong: { shape: 'easeIn', from: 1.0, to: 0.68, bias: 1.2 },
      material: 'skin',
    },
    {
      op: 'sweep',
      id: 'finger_little',
      note: 'The little finger, noticeably shorter and thinner than the rest. Four fingers of equal length is one of the clearest tells of a hand that was not observed.',
      curve: {
        type: 'spline',
        points: [
          [0.222, 0.766, -0.014],
          [0.2225, 0.736, -0.016],
          [0.223, 0.714, -0.023],
          [0.2235, 0.702, -0.032],
        ],
        closed: false,
      },
      profile: { type: 'ellipse', radiusX: 0.0075, radiusY: 0.0075, segments: 10 },
      segments: 10,
      scaleAlong: { shape: 'easeIn', from: 1.0, to: 0.66, bias: 1.2 },
      material: 'skin',
    },
    {
      op: 'sweep',
      id: 'thumb',
      note: 'The thumb, leaving the palm forward and outward at roughly forty degrees to the fingers. An opposed thumb is what makes the shape read as a human hand rather than as a paw, and it is the one digit that must not be parallel to the others.',
      curve: {
        type: 'spline',
        points: [
          [0.216, 0.806, 0.048],
          [0.211, 0.79, 0.066],
          [0.208, 0.776, 0.079],
          [0.207, 0.766, 0.087],
        ],
        closed: false,
      },
      profile: { type: 'ellipse', radiusX: 0.0105, radiusY: 0.0105, segments: 10 },
      segments: 10,
      scaleAlong: { shape: 'easeIn', from: 1.0, to: 0.72, bias: 1.2 },
      material: 'skin',
    },
    {
      op: 'merge',
      id: 'arm',
      note: 'The whole right arm with its hand, collected so one mirror produces the left. Building the second arm by hand is how a figure ends up with mismatched limbs.',
      sources: [
        'upper_arm',
        'elbow',
        'forearm',
        'palm',
        'finger_index',
        'finger_middle',
        'finger_ring',
        'finger_little',
        'thumb',
        'shoulder',
      ],
    },
    {
      op: 'mirror',
      id: 'arms',
      note: 'Both arms and both hands.',
      source: 'arm',
      axis: 'x',
    },

    // ----------------------------------------------------------- right leg --
    {
      op: 'sweep',
      id: 'thigh',
      note: 'Hip to knee, the thickest limb segment on the body, converging slightly inward toward the knee as a standing leg does.',
      curve: { type: 'line', from: [0.086, 0.9, 0.002], to: [0.096, 0.5, 0.008] },
      profile: { type: 'ellipse', radiusX: 0.082, radiusY: 0.078, segments: 18 },
      segments: 12,
      scaleAlong: { shape: 'easeIn', from: 1.02, to: 0.72, bias: 1.25 },
      material: 'trousers',
    },
    {
      op: 'primitive',
      id: 'knee',
      note: 'The knee joint, where the leg changes direction from thigh to shin. Without it the leg is one continuous cone and reads as a stilt.',
      shape: 'sphere',
      centre: [0.096, 0.5, 0.01],
      radius: 0.057,
      segments: 14,
      material: 'trousers',
    },
    {
      op: 'sweep',
      id: 'calf',
      note: 'Knee to ankle. The keyed scale puts the calf_s widest point at about a third of the way down, which is where the gastrocnemius sits, and pulls hard into the ankle — the narrowest point of the leg.',
      curve: { type: 'line', from: [0.096, 0.5, 0.008], to: [0.1, 0.085, -0.006] },
      profile: { type: 'ellipse', radiusX: 0.062, radiusY: 0.058, segments: 18 },
      segments: 14,
      scaleAlong: {
        keys: [
          { t: 0, value: 0.94 },
          { t: 0.3, value: 1.0 },
          { t: 0.75, value: 0.66 },
          { t: 1, value: 0.56 },
        ],
      },
      material: 'trousers',
    },
    {
      op: 'loft',
      id: 'boot',
      note: 'The boot, lofted front-to-back with the heel behind the ankle and the toe well forward of it. A foot modelled as a slab under the leg is the commonest reason a standing figure looks like it is sinking into the floor.',
      sections: [
        { at: [0.1, 0.066, -0.062], profile: { type: 'ellipse', radiusX: 0.031, radiusY: 0.058, segments: 16 } },
        { at: [0.1, 0.05, -0.03], profile: { type: 'ellipse', radiusX: 0.038, radiusY: 0.05, segments: 16 } },
        { at: [0.1, 0.041, 0.02], profile: { type: 'ellipse', radiusX: 0.043, radiusY: 0.041, segments: 16 } },
        { at: [0.1, 0.033, 0.078], profile: { type: 'ellipse', radiusX: 0.042, radiusY: 0.033, segments: 16 } },
        { at: [0.1, 0.026, 0.118], profile: { type: 'ellipse', radiusX: 0.033, radiusY: 0.026, segments: 16 } },
        { at: [0.1, 0.022, 0.138], profile: { type: 'ellipse', radiusX: 0.018, radiusY: 0.02, segments: 16 } },
      ],
      material: 'boot',
    },
    {
      op: 'merge',
      id: 'leg',
      note: 'The whole right leg with its boot, ready to mirror.',
      sources: ['thigh', 'knee', 'calf', 'boot'],
    },
    {
      op: 'mirror',
      id: 'legs',
      note: 'Both legs, standing at the same height so the figure does not lean.',
      source: 'leg',
      axis: 'x',
    },
  ],

  outputs: [
    'head_sockets',
    'lips',
    'eyeballs',
    'irises',
    'lids',
    'ears',
    'hair',
    'eyebrows',
    'neck',
    'torso',
    'hips',
    'arms',
    'legs',
  ],
});

/** The palette this character is authored against, in the order the materials index it. */
export const AVATAR_PALETTE: readonly string[] = [
  '#c98d6d', // 0 skin
  '#9c5747', // 1 lips
  '#241a14', // 2 hair
  '#f4f1ec', // 3 sclera
  '#2f2015', // 4 iris
  '#3a4657', // 5 jacket
  '#232830', // 6 trousers
  '#15181d', // 7 boots
];

export { EYE_X, EYE_Y };
