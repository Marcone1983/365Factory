import {
  PolyMesh,
  loft,
  superellipseProfile,
  ellipseProfile,
  subdivide,
  triangulate,
  v3,
  type Station,
  type Vec3,
} from '@/lib/graphics/mesh-kernel';
import { Rng } from '@/lib/util/random';
import { bakeAnimation, bindSkin, buildSkeleton, skeletonNodes, skinFor, type AnimationSpec, type JointSpec, type Skeleton } from './skeleton';
import type { GlbAnimation, GlbMesh, GlbNode, GlbSkin, MeshPrimitiveData } from '@/lib/graphics/gltf';

/**
 * Humanoid character generator.
 *
 * All dimensions derive from a single anthropometric table expressed as
 * fractions of stature — biacromial breadth, chest depth, bitrochanteric width,
 * segment lengths — so the figure is proportioned like a person instead of like
 * a stack of primitives. Cross-sections are superellipses, which is what gives a
 * torso its "soft rectangle" section, and the whole body is assembled first and
 * Catmull-Clark subdivided second so the shoulder, neck and hip junctions fuse
 * into one continuous surface.
 *
 * Material slots: 0 skin, 1 hair, 2 garment, 3 accent/boots, 4 eyes.
 */

export const CHARACTER_MATERIALS = { skin: 0, hair: 1, garment: 2, accent: 3, eyes: 4 } as const;

export interface CharacterProportions {
  readonly height: number;
  /** 0 = lean, 1 = heavy. Scales circumferences, never lengths. */
  readonly build: number;
  readonly shoulderRatio: number;
  readonly headRatio: number;
  readonly legRatio: number;
  readonly hipRatio: number;
  readonly neckRatio: number;
}

export interface CharacterStyle {
  readonly hair: 'short' | 'long' | 'tied' | 'bald' | 'crest';
  readonly outfit: 'suit' | 'armour' | 'jacket' | 'robe' | 'athletic';
  readonly footwear: 'boots' | 'shoes' | 'barefoot';
}

export interface CharacterRequest {
  readonly name: string;
  readonly seed: number;
  readonly proportions?: Partial<CharacterProportions>;
  readonly style?: Partial<CharacterStyle>;
  readonly smoothness?: number;
}

export interface GeneratedCharacter {
  readonly meshes: readonly GlbMesh[];
  readonly nodes: readonly GlbNode[];
  readonly skins: readonly GlbSkin[];
  readonly animations: readonly GlbAnimation[];
  readonly triangleCount: number;
  readonly skeleton: Skeleton;
}

/**
 * Resolved skeleton geometry shared by every builder, so the mesh, the rig and
 * the animation curves cannot disagree about where a joint is.
 */
interface BodyMetrics {
  readonly height: number;
  readonly mass: number;
  readonly groundY: number;
  readonly hipY: number;
  readonly waistY: number;
  readonly chestY: number;
  readonly shoulderY: number;
  readonly neckTopY: number;
  readonly headTopY: number;
  readonly shoulderHalf: number;
  readonly chestHalf: number;
  readonly waistHalf: number;
  readonly hipHalf: number;
  readonly chestDepth: number;
  readonly waistDepth: number;
  readonly hipDepth: number;
  readonly neckRadius: number;
  readonly headHeight: number;
  readonly headWidth: number;
  readonly headDepth: number;
  readonly armX: number;
  readonly upperArm: number;
  readonly foreArm: number;
  readonly armRadius: number;
  readonly legX: number;
  readonly thigh: number;
  readonly shin: number;
  readonly thighRadius: number;
}

function metricsFor(p: CharacterProportions): BodyMetrics {
  const h = p.height;
  const mass = 0.9 + p.build * 0.35;
  // Build changes circumference far more than it changes skeletal breadth:
  // applying `mass` directly to shoulder and hip width produces a figure whose
  // head looks too small. Breadth therefore uses a damped exponent.
  const breadth = mass ** 0.5;

  const hipY = h * p.legRatio;
  const headHeight = h * p.headRatio;
  const neckLength = h * p.neckRatio;
  const shoulderY = h - headHeight - neckLength;
  const chestY = hipY + (shoulderY - hipY) * 0.66;
  const waistY = hipY + (shoulderY - hipY) * 0.26;

  // Breadths from anthropometric fractions of stature.
  const shoulderHalf = (h * p.shoulderRatio * breadth) / 2;
  const chestHalf = shoulderHalf * 0.86;
  const waistHalf = h * 0.078 * mass;
  const hipHalf = (h * p.hipRatio * breadth) / 2;

  const armRadius = h * 0.028 * mass;
  const thighRadius = h * 0.048 * mass;

  return {
    height: h,
    mass,
    groundY: 0,
    hipY,
    waistY,
    chestY,
    shoulderY,
    neckTopY: shoulderY + neckLength,
    headTopY: h,
    shoulderHalf,
    chestHalf,
    waistHalf,
    hipHalf,
    chestDepth: chestHalf * 1.12,
    waistDepth: waistHalf * 1.18,
    hipDepth: hipHalf * 1.02,
    neckRadius: h * 0.029 * mass,
    headHeight,
    headWidth: headHeight * 0.66,
    headDepth: headHeight * 0.8,
    // Arms hang clear of the torso: their centre sits outboard of the deltoid.
    armX: shoulderHalf + armRadius * 0.72,
    upperArm: h * 0.172,
    foreArm: h * 0.157,
    armRadius,
    legX: hipHalf * 0.52,
    thigh: hipY * 0.53,
    shin: hipY * 0.43,
    thighRadius,
  };
}

function defaultProportions(rng: Rng): CharacterProportions {
  return {
    height: rng.float(1.64, 1.9),
    build: rng.float(0.25, 0.72),
    shoulderRatio: rng.float(0.222, 0.245),
    headRatio: rng.float(0.128, 0.14),
    legRatio: rng.float(0.475, 0.51),
    hipRatio: rng.float(0.168, 0.19),
    neckRatio: rng.float(0.048, 0.06),
  };
}

/** Lofts a tapered limb through elliptical sections. */
function limb(sections: ReadonlyArray<{ at: Vec3; rx: number; ry: number }>, material: number, segments = 14): PolyMesh {
  return loft(
    sections.map((s) => ({ center: s.at, profile: ellipseProfile(s.rx, s.ry, segments), right: v3(1, 0, 0), up: v3(0, 0, 1), material })),
    { closeRing: true, capStart: true, capEnd: true, material },
  );
}

function buildTorso(m: BodyMetrics, style: CharacterStyle, rng: Rng): PolyMesh {
  const bulk = style.outfit === 'armour' ? 1.14 : style.outfit === 'jacket' ? 1.07 : style.outfit === 'robe' ? 1.1 : 1;
  const material = style.outfit === 'athletic' ? CHARACTER_MATERIALS.skin : CHARACTER_MATERIALS.garment;

  // Superellipse exponents: hips and chest are fuller, the waist is rounder.
  const section = (y: number, halfWidth: number, depth: number, exponent: number, z = 0): Station => ({
    center: v3(0, y, z),
    profile: superellipseProfile(halfWidth * bulk, depth * bulk, exponent, 24),
    right: v3(1, 0, 0),
    up: v3(0, 0, 1),
    material,
  });

  const torso = loft(
    [
      section(m.hipY - m.height * 0.055, m.hipHalf * 0.9, m.hipDepth * 0.9, 2.3),
      section(m.hipY, m.hipHalf, m.hipDepth, 2.5),
      section(m.waistY, m.waistHalf, m.waistDepth, 2.3, m.height * 0.004),
      section(m.chestY, m.chestHalf, m.chestDepth, 2.7, m.height * 0.006 + rng.float(-0.002, 0.002) * m.height),
      section(m.shoulderY - m.height * 0.03, m.shoulderHalf, m.chestDepth * 0.94, 2.9),
      section(m.shoulderY, m.shoulderHalf * 0.9, m.chestDepth * 0.78, 2.6),
    ],
    { closeRing: true, capStart: true, capEnd: true, material },
  );

  // Deltoid caps bridge the torso to the arms, so the shoulder is a continuous
  // mass instead of a tube poking out of a slab.
  for (const side of [-1, 1]) {
    const deltoid = limb(
      [
        { at: v3(side * m.shoulderHalf * 0.55, m.shoulderY - m.height * 0.012, 0), rx: m.armRadius * 1.5, ry: m.armRadius * 1.5 },
        { at: v3(side * m.armX, m.shoulderY - m.height * 0.03, 0), rx: m.armRadius * 1.32, ry: m.armRadius * 1.32 },
      ],
      material,
      14,
    );
    torso.merge(deltoid);
  }

  // Neck: a real column, otherwise the head appears to float.
  const neck = limb(
    [
      { at: v3(0, m.shoulderY - m.height * 0.015, -m.height * 0.004), rx: m.neckRadius * 1.35, ry: m.neckRadius * 1.35 },
      { at: v3(0, m.shoulderY + (m.neckTopY - m.shoulderY) * 0.55, 0), rx: m.neckRadius, ry: m.neckRadius * 1.05 },
      { at: v3(0, m.neckTopY + m.height * 0.006, 0), rx: m.neckRadius * 1.12, ry: m.neckRadius * 1.15 },
    ],
    CHARACTER_MATERIALS.skin,
    14,
  );
  torso.merge(neck);
  return torso;
}

function buildHead(m: BodyMetrics, rng: Rng): PolyMesh {
  const base = m.neckTopY;
  const w = m.headWidth;
  const d = m.headDepth;
  const hh = m.headHeight;

  // Jaw → cheek → cheekbone → brow → cranium → crown. The forward offsets build
  // a face profile; a constant offset would give a sphere.
  const section = (t: number, sx: number, sz: number, forward: number): Station => ({
    center: v3(0, base + hh * t, d * forward),
    profile: superellipseProfile(w * sx, d * sz, 2.4, 20),
    right: v3(1, 0, 0),
    up: v3(0, 0, 1),
    material: CHARACTER_MATERIALS.skin,
  });

  const head = loft(
    [
      section(0.02, 0.36, 0.36, 0.02),
      section(0.14, 0.44, 0.46, 0.06),
      section(0.32, 0.5, 0.54, 0.05),
      section(0.52, 0.53, 0.56, 0.02),
      section(0.72, 0.52, 0.55, -0.01),
      section(0.9, 0.42, 0.44, -0.04),
      section(1.0, 0.2, 0.22, -0.06),
    ],
    { closeRing: true, capStart: true, capEnd: true, material: CHARACTER_MATERIALS.skin },
  );

  // Brow ridge and nose bridge give the profile a face silhouette.
  const nose = limb(
    [
      { at: v3(0, base + hh * 0.62, d * 0.5), rx: w * 0.075, ry: w * 0.075 },
      { at: v3(0, base + hh * 0.48, d * 0.58), rx: w * 0.085, ry: w * 0.09 },
      { at: v3(0, base + hh * 0.4, d * 0.5), rx: w * 0.07, ry: w * 0.07 },
    ],
    CHARACTER_MATERIALS.skin,
    10,
  );
  head.merge(nose);

  for (const side of [-1, 1]) {
    const eye = limb(
      [
        { at: v3(side * w * 0.24, base + hh * 0.6, d * 0.42), rx: hh * 0.05, ry: hh * 0.05 },
        { at: v3(side * w * 0.25, base + hh * 0.6, d * 0.5), rx: hh * 0.032, ry: hh * 0.032 },
      ],
      CHARACTER_MATERIALS.eyes,
      10,
    );
    head.merge(eye);

    const ear = limb(
      [
        { at: v3(side * w * 0.5, base + hh * 0.58, -d * 0.02), rx: hh * 0.04, ry: hh * 0.07 },
        { at: v3(side * w * 0.6, base + hh * 0.56, -d * 0.03), rx: hh * 0.025, ry: hh * 0.06 },
      ],
      CHARACTER_MATERIALS.skin,
      8,
    );
    head.merge(ear);
  }

  void rng;
  return head;
}

function buildHair(m: BodyMetrics, style: CharacterStyle): PolyMesh {
  const mesh = new PolyMesh();
  if (style.hair === 'bald') return mesh;
  const base = m.neckTopY;
  const w = m.headWidth;
  const d = m.headDepth;
  const hh = m.headHeight;
  const H = CHARACTER_MATERIALS.hair;

  const cap = loft(
    [
      { center: v3(0, base + hh * 0.5, -d * 0.03), profile: superellipseProfile(w * 0.56, d * 0.6, 2.4, 20), right: v3(1, 0, 0), up: v3(0, 0, 1), material: H },
      { center: v3(0, base + hh * 0.76, -d * 0.05), profile: superellipseProfile(w * 0.55, d * 0.58, 2.4, 20), right: v3(1, 0, 0), up: v3(0, 0, 1), material: H },
      { center: v3(0, base + hh * 0.99, -d * 0.07), profile: superellipseProfile(w * 0.26, d * 0.28, 2.4, 20), right: v3(1, 0, 0), up: v3(0, 0, 1), material: H },
    ],
    { closeRing: true, capStart: true, capEnd: true, material: H },
  );
  mesh.merge(cap);

  if (style.hair === 'long' || style.hair === 'tied') {
    const drop = style.hair === 'tied' ? hh * 0.9 : hh * 2.1;
    mesh.merge(
      limb(
        [
          { at: v3(0, base + hh * 0.72, -d * 0.44), rx: w * 0.3, ry: d * 0.18 },
          { at: v3(0, base + hh * 0.1, -d * 0.5), rx: w * 0.27, ry: d * 0.16 },
          { at: v3(0, base - drop, -d * 0.44), rx: w * 0.15, ry: d * 0.1 },
        ],
        H,
        12,
      ),
    );
  }

  if (style.hair === 'crest') {
    mesh.merge(
      loft(
        [
          { center: v3(0, base + hh * 0.92, d * 0.28), profile: ellipseProfile(w * 0.05, hh * 0.14, 8), right: v3(0, 0, 1), up: v3(0, 1, 0), material: H },
          { center: v3(0, base + hh * 1.06, 0), profile: ellipseProfile(w * 0.06, hh * 0.22, 8), right: v3(0, 0, 1), up: v3(0, 1, 0), material: H },
          { center: v3(0, base + hh * 0.9, -d * 0.3), profile: ellipseProfile(w * 0.05, hh * 0.12, 8), right: v3(0, 0, 1), up: v3(0, 1, 0), material: H },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: H },
      ),
    );
  }
  return mesh;
}

function buildArm(m: BodyMetrics, style: CharacterStyle, side: number): PolyMesh {
  const r = m.armRadius;
  const x = side * m.armX;
  const shoulderTop = m.shoulderY - m.height * 0.025;
  const elbowY = shoulderTop - m.upperArm;
  const wristY = elbowY - m.foreArm;
  const sleeved = style.outfit !== 'athletic';
  const sleeve = sleeved ? CHARACTER_MATERIALS.garment : CHARACTER_MATERIALS.skin;

  const arm = new PolyMesh();
  arm.merge(
    limb(
      [
        { at: v3(x, shoulderTop, 0), rx: r * 1.26, ry: r * 1.26 },
        { at: v3(x * 1.02, shoulderTop - m.upperArm * 0.42, 0), rx: r * 1.08, ry: r * 1.1 },
        { at: v3(x * 1.03, elbowY + r * 0.4, 0), rx: r * 0.84, ry: r * 0.88 },
        { at: v3(x * 1.03, elbowY, 0), rx: r * 0.82, ry: r * 0.86 },
        { at: v3(x * 1.03, elbowY - m.foreArm * 0.3, 0), rx: r * 0.92, ry: r * 0.94 },
        { at: v3(x * 1.02, wristY, 0), rx: r * 0.56, ry: r * 0.62 },
      ],
      sleeve,
      14,
    ),
  );

  // Hand: palm block tapering into a mitten of fingers — reads correctly at
  // gameplay distance and stays inside the triangle budget.
  arm.merge(
    limb(
      [
        { at: v3(x * 1.02, wristY, 0), rx: r * 0.54, ry: r * 0.6 },
        { at: v3(x * 1.02, wristY - m.height * 0.028, r * 0.14), rx: r * 0.72, ry: r * 0.4 },
        { at: v3(x * 1.02, wristY - m.height * 0.062, r * 0.18), rx: r * 0.66, ry: r * 0.34 },
        { at: v3(x * 1.02, wristY - m.height * 0.085, r * 0.14), rx: r * 0.4, ry: r * 0.22 },
      ],
      CHARACTER_MATERIALS.skin,
      12,
    ),
  );
  return arm;
}

function buildLeg(m: BodyMetrics, style: CharacterStyle, side: number): PolyMesh {
  const r = m.thighRadius;
  const x = side * m.legX;
  const kneeY = m.hipY - m.thigh;
  const ankleY = kneeY - m.shin;
  const material = CHARACTER_MATERIALS.garment;

  const leg = new PolyMesh();
  leg.merge(
    limb(
      [
        { at: v3(x, m.hipY + m.height * 0.015, 0), rx: r * 1.22, ry: r * 1.24 },
        { at: v3(x, m.hipY - m.thigh * 0.38, 0), rx: r * 1.08, ry: r * 1.12 },
        { at: v3(x, kneeY + r * 0.5, 0), rx: r * 0.84, ry: r * 0.88 },
        { at: v3(x, kneeY, r * 0.04), rx: r * 0.8, ry: r * 0.84 },
        // Calf mass sits high and behind: the shape that reads as a leg.
        { at: v3(x, kneeY - m.shin * 0.28, -r * 0.1), rx: r * 0.92, ry: r * 0.98 },
        { at: v3(x, ankleY + m.shin * 0.12, 0), rx: r * 0.58, ry: r * 0.6 },
        { at: v3(x, ankleY, 0), rx: r * 0.44, ry: r * 0.5 },
      ],
      material,
      14,
    ),
  );

  if (style.footwear !== 'barefoot') {
    const bootHeight = style.footwear === 'boots' ? m.height * 0.06 : m.height * 0.028;
    leg.merge(
      limb(
        [
          { at: v3(x, ankleY + bootHeight, 0), rx: r * 0.56, ry: r * 0.62 },
          { at: v3(x, ankleY + bootHeight * 0.3, r * 0.16), rx: r * 0.62, ry: r * 0.8 },
          { at: v3(x, ankleY * 0.995, r * 0.5), rx: r * 0.6, ry: r * 1.15 },
          { at: v3(x, ankleY * 0.99, r * 1.05), rx: r * 0.5, ry: r * 0.9 },
        ],
        CHARACTER_MATERIALS.accent,
        12,
      ),
    );
  }
  return leg;
}

function characterSkeleton(m: BodyMetrics): Skeleton {
  const shoulderTop = m.shoulderY - m.height * 0.025;
  const kneeY = m.hipY - m.thigh;
  const ankleY = kneeY - m.shin;

  const specs: JointSpec[] = [
    { name: 'hips', parent: null, position: v3(0, m.hipY, 0), radius: m.hipHalf * 1.5 },
    { name: 'spine', parent: 'hips', position: v3(0, m.waistY, 0), radius: m.waistHalf * 1.7 },
    { name: 'chest', parent: 'spine', position: v3(0, m.chestY, 0), radius: m.chestHalf * 1.7 },
    { name: 'neck', parent: 'chest', position: v3(0, m.shoulderY, 0), radius: m.neckRadius * 2.4 },
    { name: 'head', parent: 'neck', position: v3(0, m.neckTopY + m.headHeight * 0.35, 0), radius: m.headHeight * 0.8 },
  ];

  for (const [name, side] of [['left', 1], ['right', -1]] as const) {
    specs.push(
      { name: `${name}_shoulder`, parent: 'chest', position: v3(side * m.shoulderHalf * 0.55, shoulderTop, 0), radius: m.armRadius * 2.2 },
      { name: `${name}_arm`, parent: `${name}_shoulder`, position: v3(side * m.armX, shoulderTop, 0), radius: m.armRadius * 2 },
      { name: `${name}_forearm`, parent: `${name}_arm`, position: v3(side * m.armX, shoulderTop - m.upperArm, 0), radius: m.armRadius * 1.8 },
      { name: `${name}_hand`, parent: `${name}_forearm`, position: v3(side * m.armX, shoulderTop - m.upperArm - m.foreArm, 0), radius: m.armRadius * 2.2 },
      { name: `${name}_thigh`, parent: 'hips', position: v3(side * m.legX, m.hipY, 0), radius: m.thighRadius * 2 },
      { name: `${name}_shin`, parent: `${name}_thigh`, position: v3(side * m.legX, kneeY, 0), radius: m.thighRadius * 1.8 },
      { name: `${name}_foot`, parent: `${name}_shin`, position: v3(side * m.legX, ankleY, 0), radius: m.thighRadius * 1.8 },
    );
  }
  return buildSkeleton(specs);
}

function locomotionAnimations(m: BodyMetrics): AnimationSpec[] {
  const tau = Math.PI * 2;
  const zero = { pitch: 0, yaw: 0, roll: 0 };

  const idle: AnimationSpec = {
    name: 'idle',
    durationSeconds: 3.2,
    keyframes: 25,
    loop: true,
    curves: [
      { joint: 'spine', rotation: (t) => ({ pitch: Math.sin(t * tau) * 0.022, yaw: Math.sin(t * tau * 0.5) * 0.014, roll: 0 }) },
      { joint: 'chest', rotation: (t) => ({ pitch: Math.sin(t * tau + 0.6) * 0.03, yaw: 0, roll: Math.sin(t * tau * 0.5) * 0.012 }) },
      { joint: 'head', rotation: (t) => ({ pitch: Math.sin(t * tau * 0.5 + 1.2) * 0.05, yaw: Math.sin(t * tau * 0.33) * 0.08, roll: 0 }) },
      { joint: 'left_arm', rotation: (t) => ({ pitch: Math.sin(t * tau) * 0.03, yaw: 0, roll: -0.1 }) },
      { joint: 'right_arm', rotation: (t) => ({ pitch: Math.sin(t * tau + Math.PI) * 0.03, yaw: 0, roll: 0.1 }) },
      { joint: 'hips', rotation: () => zero, translation: (t) => v3(0, Math.sin(t * tau) * m.height * 0.004, 0) },
    ],
  };

  const gait = (name: string, duration: number, swing: number, lift: number, lean: number): AnimationSpec => ({
    name,
    durationSeconds: duration,
    keyframes: 21,
    loop: true,
    curves: [
      { joint: 'hips', rotation: (t) => ({ pitch: lean, yaw: Math.sin(t * tau) * 0.06, roll: 0 }), translation: (t) => v3(0, Math.abs(Math.sin(t * tau)) * m.height * lift, 0) },
      { joint: 'spine', rotation: (t) => ({ pitch: 0, yaw: -Math.sin(t * tau) * 0.05, roll: 0 }) },
      { joint: 'chest', rotation: (t) => ({ pitch: 0, yaw: -Math.sin(t * tau) * 0.08, roll: 0 }) },
      { joint: 'left_thigh', rotation: (t) => ({ pitch: Math.sin(t * tau) * swing, yaw: 0, roll: 0 }) },
      { joint: 'right_thigh', rotation: (t) => ({ pitch: Math.sin(t * tau + Math.PI) * swing, yaw: 0, roll: 0 }) },
      // A knee only bends backwards; the clamp is what prevents inverted joints.
      { joint: 'left_shin', rotation: (t) => ({ pitch: -Math.max(0, Math.sin(t * tau - 0.9)) * swing * 1.15, yaw: 0, roll: 0 }) },
      { joint: 'right_shin', rotation: (t) => ({ pitch: -Math.max(0, Math.sin(t * tau + Math.PI - 0.9)) * swing * 1.15, yaw: 0, roll: 0 }) },
      { joint: 'left_foot', rotation: (t) => ({ pitch: Math.sin(t * tau + 0.7) * swing * 0.35, yaw: 0, roll: 0 }) },
      { joint: 'right_foot', rotation: (t) => ({ pitch: Math.sin(t * tau + Math.PI + 0.7) * swing * 0.35, yaw: 0, roll: 0 }) },
      { joint: 'left_arm', rotation: (t) => ({ pitch: Math.sin(t * tau + Math.PI) * swing * 0.7, yaw: 0, roll: -0.1 }) },
      { joint: 'right_arm', rotation: (t) => ({ pitch: Math.sin(t * tau) * swing * 0.7, yaw: 0, roll: 0.1 }) },
      { joint: 'left_forearm', rotation: (t) => ({ pitch: -Math.max(0, Math.sin(t * tau + Math.PI)) * swing * 0.5 - 0.12, yaw: 0, roll: 0 }) },
      { joint: 'right_forearm', rotation: (t) => ({ pitch: -Math.max(0, Math.sin(t * tau)) * swing * 0.5 - 0.12, yaw: 0, roll: 0 }) },
    ],
  });

  const attack: AnimationSpec = {
    name: 'attack',
    durationSeconds: 0.72,
    keyframes: 17,
    loop: false,
    curves: [
      { joint: 'chest', rotation: (t) => ({ pitch: 0, yaw: -0.5 * windup(t), roll: 0 }) },
      { joint: 'right_shoulder', rotation: (t) => ({ pitch: 0, yaw: 0, roll: 0.35 * windup(t) }) },
      { joint: 'right_arm', rotation: (t) => ({ pitch: -1.9 * windup(t), yaw: 0, roll: 0.18 }) },
      { joint: 'right_forearm', rotation: (t) => ({ pitch: -1.1 * Math.max(0, 1 - Math.abs(t - 0.42) * 4), yaw: 0, roll: 0 }) },
      { joint: 'hips', rotation: (t) => ({ pitch: 0, yaw: 0.22 * windup(t), roll: 0 }) },
    ],
  };

  return [idle, gait('walk', 1.15, 0.5, 0.012, 0.03), gait('run', 0.72, 0.84, 0.028, 0.12), attack];
}

/** Slow wind-up, fast snap-through, settle — the shape of any strike. */
function windup(t: number): number {
  if (t < 0.35) return -(t / 0.35) * 0.6;
  if (t < 0.55) return -0.6 + ((t - 0.35) / 0.2) * 1.6;
  return 1 - (t - 0.55) / 0.45;
}

export function generateCharacter(request: CharacterRequest): GeneratedCharacter {
  const rng = new Rng(request.seed);
  const proportions: CharacterProportions = { ...defaultProportions(rng), ...request.proportions };
  const style: CharacterStyle = {
    hair: request.style?.hair ?? rng.pick(['short', 'long', 'tied', 'crest', 'bald'] as const),
    outfit: request.style?.outfit ?? rng.pick(['suit', 'armour', 'jacket', 'robe', 'athletic'] as const),
    footwear: request.style?.footwear ?? rng.pick(['boots', 'shoes'] as const),
  };
  const metrics = metricsFor(proportions);

  const body = new PolyMesh();
  body.merge(buildTorso(metrics, style, rng));
  body.merge(buildHead(metrics, rng));
  body.merge(buildHair(metrics, style));
  body.merge(buildArm(metrics, style, 1));
  body.merge(buildArm(metrics, style, -1));
  body.merge(buildLeg(metrics, style, 1));
  body.merge(buildLeg(metrics, style, -1));

  const smooth = subdivide(body, Math.max(0, Math.min(3, request.smoothness ?? 2)));
  const skeleton = characterSkeleton(metrics);
  bindSkin(smooth, skeleton, { falloff: 2.6 });

  const triangulated = triangulate(smooth, { smoothAngleDegrees: 78 });
  const primitives: MeshPrimitiveData[] = triangulated.materialGroups.map((group) => ({
    name: `${request.name}_mat${group.material}`,
    positions: triangulated.positions,
    normals: triangulated.normals,
    uvs: triangulated.uvs,
    joints: triangulated.joints,
    weights: triangulated.weights,
    indices: triangulated.indices.slice(group.start, group.start + group.count),
    materialIndex: group.material,
  }));

  const meshNode: GlbNode = { name: request.name, mesh: 0, skin: 0 };
  const joints = skeletonNodes(skeleton, 1);
  const skin = skinFor(skeleton, 1, `${request.name}_skin`);
  const animations = locomotionAnimations(metrics).map((spec) => bakeAnimation(spec, skeleton, 1));

  return {
    meshes: [{ name: request.name, primitives }],
    nodes: [meshNode, ...joints],
    skins: [skin],
    animations,
    triangleCount: triangulated.indices.length / 3,
    skeleton,
  };
}
