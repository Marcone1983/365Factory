import {
  PolyMesh,
  loft,
  revolve,
  roundedRectProfile,
  subdivide,
  triangulate,
  projectBoxUvs,
  v3,
} from '@/lib/graphics/mesh-kernel';
import { Rng } from '@/lib/util/random';
import type { GlbMesh, GlbNode, MeshPrimitiveData } from '@/lib/graphics/gltf';
import { buildBody, type BodyLayout, type BuiltBody } from './vehicle-body';
import { halfWidthAt, type SectionPoint } from './vehicle-section';

/**
 * Vehicle generator.
 *
 * A car silhouette is a longitudinal loft: the body is defined by how its
 * cross-section changes from front bumper to tail, and by a separate greenhouse
 * (cabin) loft that establishes the windscreen rake and roofline. That is how
 * vehicles are actually surfaced, and it is why the result reads as a car rather
 * than as a stack of boxes.
 *
 * Panel lines, the shoulder crease and the wheel arch openings are marked as
 * creased edges so subdivision keeps them crisp while the sheet metal between
 * them stays continuous.
 *
 * Wheels are emitted as separate nodes so the game can steer and spin them.
 *
 * Material slots: 0 paint, 1 glass, 2 tyre, 3 rim/trim, 4 lights (emissive).
 */

export const VEHICLE_MATERIALS = { paint: 0, glass: 1, tyre: 2, trim: 3, lights: 4 } as const;

export type VehicleClass = 'hypercar' | 'rally' | 'muscle' | 'formula' | 'offroad' | 'hover';

export interface VehicleRequest {
  readonly name: string;
  readonly seed: number;
  readonly vehicleClass?: VehicleClass;
  readonly smoothness?: number;
}

export interface GeneratedVehicle {
  readonly meshes: readonly GlbMesh[];
  readonly nodes: readonly GlbNode[];
  readonly triangleCount: number;
  readonly dimensions: { length: number; width: number; height: number; wheelbase: number; track: number; wheelRadius: number };
  readonly vehicleClass: VehicleClass;
}

interface ClassProfile {
  readonly length: [number, number];
  readonly width: [number, number];
  readonly height: [number, number];
  readonly rideHeight: [number, number];
  readonly wheelRadius: [number, number];
  readonly cabinStart: number;
  readonly cabinEnd: number;
  readonly noseDrop: number;
  readonly deckDrop: number;
  readonly wing: boolean;
  readonly fenders: number;
}

const CLASS_PROFILES: Record<VehicleClass, ClassProfile> = {
  hypercar: { length: [4.3, 4.8], width: [1.95, 2.08], height: [1.09, 1.2], rideHeight: [0.09, 0.13], wheelRadius: [0.34, 0.38], cabinStart: 0.3, cabinEnd: 0.68, noseDrop: 0.72, deckDrop: 0.3, wing: true, fenders: 0.02 },
  rally: { length: [4.0, 4.4], width: [1.8, 1.92], height: [1.36, 1.48], rideHeight: [0.18, 0.24], wheelRadius: [0.33, 0.36], cabinStart: 0.24, cabinEnd: 0.74, noseDrop: 0.86, deckDrop: 0.16, wing: true, fenders: 0.06 },
  muscle: { length: [4.8, 5.2], width: [1.9, 2.0], height: [1.3, 1.4], rideHeight: [0.13, 0.17], wheelRadius: [0.35, 0.39], cabinStart: 0.34, cabinEnd: 0.72, noseDrop: 0.9, deckDrop: 0.2, wing: false, fenders: 0.045 },
  formula: { length: [4.9, 5.4], width: [1.75, 1.85], height: [0.92, 1.0], rideHeight: [0.05, 0.08], wheelRadius: [0.33, 0.36], cabinStart: 0.4, cabinEnd: 0.58, noseDrop: 0.42, deckDrop: 0.34, wing: true, fenders: 0 },
  offroad: { length: [4.4, 5.0], width: [1.95, 2.15], height: [1.85, 2.0], rideHeight: [0.28, 0.36], wheelRadius: [0.42, 0.48], cabinStart: 0.26, cabinEnd: 0.78, noseDrop: 0.95, deckDrop: 0.08, wing: false, fenders: 0.08 },
  hover: { length: [4.2, 4.9], width: [1.9, 2.1], height: [1.1, 1.25], rideHeight: [0.32, 0.45], wheelRadius: [0.22, 0.28], cabinStart: 0.28, cabinEnd: 0.7, noseDrop: 0.6, deckDrop: 0.26, wing: false, fenders: 0.01 },
};

function pick(rng: Rng, range: [number, number]): number {
  return rng.float(range[0], range[1]);
}

export function generateVehicle(request: VehicleRequest): GeneratedVehicle {
  const rng = new Rng(request.seed);
  const vehicleClass = request.vehicleClass ?? rng.pick(['hypercar', 'rally', 'muscle', 'formula', 'offroad', 'hover'] as const);
  const spec = CLASS_PROFILES[vehicleClass];

  const carLength = pick(rng, spec.length);
  const carWidth = pick(rng, spec.width);
  const carHeight = pick(rng, spec.height);
  const rideHeight = pick(rng, spec.rideHeight);
  const wheelRadius = pick(rng, spec.wheelRadius);
  const wheelWidth = carWidth * rng.float(0.13, 0.18);
  const wheelbase = carLength * rng.float(0.58, 0.64);
  // Wheel centres sit so the tyre's outer face is flush with the widest point of
  // the car. The body is then narrower than the overall width, which is what
  // leaves the wheels proud instead of sunk into the bodywork.
  const track = carWidth - wheelWidth;
  const bodyWidth = carWidth - wheelWidth * 1.35;

  // --- outer skin ----------------------------------------------------------
  // One continuous lofted surface carries the whole silhouette: bonnet, roof,
  // boot and the wheel arch openings. See vehicle-body.ts for why it is not
  // built as a hull with a cabin volume placed on top.
  const frontAxleZ = wheelbase / 2;
  const rearAxleZ = -wheelbase / 2;
  const archRadius = wheelRadius * 1.22;

  const layout: BodyLayout = {
    carLength,
    carWidth,
    carHeight,
    rideHeight,
    bodyHalfWidth: bodyWidth / 2,
    wheelRadius,
    wheelWidth,
    wheelbase,
    track,
    frontAxleZ,
    rearAxleZ,
    archRadius,
    archInnerHalfWidth: track / 2 - wheelWidth * 0.62,
    cabinStart: spec.cabinStart,
    cabinEnd: spec.cabinEnd,
    noseDrop: spec.noseDrop,
    deckDrop: spec.deckDrop,
    overWheelHalfWidth: track / 2 + wheelWidth * 0.54,
    fenderSwell: spec.fenders,
    roofRatio: vehicleClass === 'formula' ? 0 : 0.36,
    // The belt line has to clear the top of the tyre. Below that the shoulder
    // sits inside the wheel arch and the car reads as though it is sinking.
    beltRatio: vehicleClass === 'formula' ? 0.34 : 0.52,
  };

  const built = buildBody(layout, {
    paint: VEHICLE_MATERIALS.paint,
    glass: VEHICLE_MATERIALS.glass,
    trim: VEHICLE_MATERIALS.trim,
  });
  const body = built.mesh;

  addDetails(body, layout, built, vehicleClass, spec, rng);

  projectBoxUvs(body, 0.35);
  const smoothBody = subdivide(body, Math.max(0, Math.min(2, request.smoothness ?? 1)));
  const bodyTriangles = triangulate(smoothBody, { smoothAngleDegrees: 48 });

  // --- wheel: tyre carcass + rim, revolved --------------------------------
  const wheel = buildWheel(wheelRadius, wheelWidth, rng);
  const wheelTriangles = triangulate(subdivide(wheel, 1), { smoothAngleDegrees: 40 });

  const meshes: GlbMesh[] = [
    { name: `${request.name}_body`, primitives: groupPrimitives(`${request.name}_body`, bodyTriangles) },
    { name: `${request.name}_wheel`, primitives: groupPrimitives(`${request.name}_wheel`, wheelTriangles) },
  ];

  const wheelPositions: Array<[string, number, number]> = [
    ['wheel_fl', -track / 2, wheelbase / 2],
    ['wheel_fr', track / 2, wheelbase / 2],
    ['wheel_rl', -track / 2, -wheelbase / 2],
    ['wheel_rr', track / 2, -wheelbase / 2],
  ];

  const nodes: GlbNode[] = [
    { name: `${request.name}_body`, mesh: 0 },
    ...wheelPositions.map(([name, x, z]) => ({
      name,
      mesh: 1,
      translation: [x, wheelRadius, z] as [number, number, number],
      // Mirror the right-hand wheels so the tread faces outward on both sides.
      scale: (x > 0 ? [1, 1, 1] : [-1, 1, 1]) as [number, number, number],
    })),
  ];

  return {
    meshes,
    nodes,
    triangleCount: bodyTriangles.indices.length / 3 + (wheelTriangles.indices.length / 3) * 4,
    dimensions: { length: carLength, width: carWidth, height: carHeight, wheelbase, track, wheelRadius },
    vehicleClass,
  };
}

function buildWheel(radius: number, width: number, rng: Rng): PolyMesh {
  const half = width / 2;
  // Tyre section: sidewall bulge and a crowned tread, revolved about Y then
  // laid on its side, which is how a tyre cross-section is actually drawn.
  const tyreProfile: Array<{ x: number; y: number }> = [
    { x: radius * 0.62, y: -half * 0.9 },
    { x: radius * 0.9, y: -half },
    { x: radius * 0.99, y: -half * 0.72 },
    { x: radius, y: 0 },
    { x: radius * 0.99, y: half * 0.72 },
    { x: radius * 0.9, y: half },
    { x: radius * 0.62, y: half * 0.9 },
  ];
  const tyre = revolve(tyreProfile, 28, Math.PI * 2, VEHICLE_MATERIALS.tyre);
  tyre.rotateZ(Math.PI / 2);

  const rimProfile: Array<{ x: number; y: number }> = [
    { x: radius * 0.16, y: -half * 0.55 },
    { x: radius * 0.6, y: -half * 0.7 },
    { x: radius * 0.64, y: half * 0.2 },
    { x: radius * 0.3, y: half * 0.45 },
    { x: radius * 0.12, y: half * 0.3 },
  ];
  const rim = revolve(rimProfile, 24, Math.PI * 2, VEHICLE_MATERIALS.trim);
  rim.rotateZ(Math.PI / 2);

  const wheel = new PolyMesh();
  wheel.merge(tyre);
  wheel.merge(rim);

  // Spokes give the rim real depth instead of a flat disc.
  const spokes = rng.pick([5, 6, 7, 8, 10]);
  for (let i = 0; i < spokes; i += 1) {
    const angle = (i / spokes) * Math.PI * 2;
    const spoke = loft(
      [
        { center: v3(half * 0.35, Math.sin(angle) * radius * 0.2, Math.cos(angle) * radius * 0.2), profile: roundedRectProfile(radius * 0.16, half * 0.3, radius * 0.03, 8), right: v3(0, Math.cos(angle), -Math.sin(angle)), up: v3(1, 0, 0), material: VEHICLE_MATERIALS.trim },
        { center: v3(half * 0.35, Math.sin(angle) * radius * 0.62, Math.cos(angle) * radius * 0.62), profile: roundedRectProfile(radius * 0.1, half * 0.26, radius * 0.02, 8), right: v3(0, Math.cos(angle), -Math.sin(angle)), up: v3(1, 0, 0), material: VEHICLE_MATERIALS.trim },
      ],
      { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.trim },
    );
    wheel.merge(spoke);
  }
  return wheel;
}

function groupPrimitives(name: string, triangulated: ReturnType<typeof triangulate>): MeshPrimitiveData[] {
  return triangulated.materialGroups.map((group) => ({
    name: `${name}_mat${group.material}`,
    positions: triangulated.positions,
    normals: triangulated.normals,
    uvs: triangulated.uvs,
    indices: triangulated.indices.slice(group.start, group.start + group.count),
    materialIndex: group.material,
  }));
}

/**
 * Adds the details that separate a car shape from a car.
 *
 * Everything here is placed against the real skin: a lamp is sunk into the
 * section's actual half-width at its own height, not at a guessed offset. That
 * is why the previous generation had lamps sticking out sideways past the
 * bodywork — they were positioned as a fraction of overall width while the nose
 * had already tapered well inside it.
 */
function addDetails(
  body: PolyMesh,
  layout: BodyLayout,
  built: BuiltBody,
  vehicleClass: VehicleClass,
  spec: ClassProfile,
  rng: Rng,
): void {
  const sectionAt = (z: number): { z: number; points: readonly SectionPoint[] } => {
    let nearest = built.sections[0];
    for (const section of built.sections) {
      if (!nearest || Math.abs(section.z - z) < Math.abs(nearest.z - z)) nearest = section;
    }
    return nearest ?? { z, points: [] };
  };

  const surfaceHalfWidth = (z: number, y: number): number => halfWidthAt(sectionAt(z).points, y);

  // --- head and tail lamps, sunk into the surface --------------------------
  for (const [zEnd, isFront] of [
    [layout.carLength * 0.46, true],
    [-layout.carLength * 0.47, false],
  ] as const) {
    const lampY = layout.rideHeight + layout.carHeight * (isFront ? 0.34 : 0.38);
    const available = surfaceHalfWidth(zEnd, lampY);
    if (available < 0.05) continue;

    const lampHalf = available * 0.34;
    const lampCentre = available * 0.55;
    for (const side of [-1, 1]) {
      const lamp = loft(
        [
          {
            center: v3(side * lampCentre, lampY, zEnd),
            profile: roundedRectProfile(lampHalf * 1.8, layout.carHeight * 0.085, layout.carHeight * 0.025, 12),
            right: v3(1, 0, 0),
            up: v3(0, 1, 0),
            material: VEHICLE_MATERIALS.lights,
          },
          {
            center: v3(side * lampCentre * 0.97, lampY, zEnd + (isFront ? 0.05 : -0.05)),
            profile: roundedRectProfile(lampHalf * 1.6, layout.carHeight * 0.07, layout.carHeight * 0.02, 12),
            right: v3(1, 0, 0),
            up: v3(0, 1, 0),
            material: VEHICLE_MATERIALS.lights,
          },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.lights },
      );
      body.merge(lamp);
    }
  }

  // --- front grille --------------------------------------------------------
  const grilleZ = layout.carLength * 0.475;
  const grilleY = layout.rideHeight + layout.carHeight * 0.19;
  const grilleWidth = surfaceHalfWidth(grilleZ, grilleY) * 1.25;
  if (grilleWidth > 0.08) {
    const grille = loft(
      [
        { center: v3(0, grilleY, grilleZ - 0.02), profile: roundedRectProfile(grilleWidth, layout.carHeight * 0.16, 0.03, 14), right: v3(1, 0, 0), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
        { center: v3(0, grilleY, grilleZ + 0.03), profile: roundedRectProfile(grilleWidth * 0.9, layout.carHeight * 0.13, 0.025, 14), right: v3(1, 0, 0), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
      ],
      { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.trim },
    );
    body.merge(grille);

    // Horizontal slats: real geometry, so the grille reads as an opening rather
    // than as a darker patch of paint.
    const slats = rng.pick([3, 4, 5]);
    for (let i = 0; i < slats; i += 1) {
      const y = grilleY - layout.carHeight * 0.05 + (i / Math.max(1, slats - 1)) * layout.carHeight * 0.1;
      const slat = loft(
        [
          { center: v3(0, y, grilleZ + 0.01), profile: roundedRectProfile(grilleWidth * 0.86, layout.carHeight * 0.012, 0.004, 8), right: v3(1, 0, 0), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
          { center: v3(0, y, grilleZ + 0.045), profile: roundedRectProfile(grilleWidth * 0.84, layout.carHeight * 0.01, 0.004, 8), right: v3(1, 0, 0), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.trim },
      );
      body.merge(slat);
    }
  }

  // --- side intakes, ahead of the rear arch --------------------------------
  if (vehicleClass === 'hypercar' || vehicleClass === 'formula' || vehicleClass === 'rally') {
    const intakeZ = layout.rearAxleZ + layout.archRadius * 1.5;
    const intakeY = layout.rideHeight + layout.carHeight * 0.3;
    const flank = surfaceHalfWidth(intakeZ, intakeY);
    for (const side of [-1, 1]) {
      const intake = loft(
        [
          { center: v3(side * flank * 0.99, intakeY, intakeZ + 0.22), profile: roundedRectProfile(0.26, layout.carHeight * 0.15, 0.03, 12), right: v3(0, 0, 1), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
          { center: v3(side * flank * 0.86, intakeY, intakeZ - 0.06), profile: roundedRectProfile(0.16, layout.carHeight * 0.1, 0.025, 12), right: v3(0, 0, 1), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.trim },
      );
      body.merge(intake);
    }
  }

  // --- mirrors -------------------------------------------------------------
  if (vehicleClass !== 'formula') {
    const mirrorZ = (layout.cabinStart + 0.06 - 0.5) * layout.carLength;
    const mirrorY = built.beltYAt(mirrorZ) + layout.carHeight * 0.02;
    const flank = surfaceHalfWidth(mirrorZ, mirrorY);
    for (const side of [-1, 1]) {
      const stalk = loft(
        [
          { center: v3(side * flank * 0.94, mirrorY, mirrorZ), profile: roundedRectProfile(0.05, 0.035, 0.015, 8), right: v3(0, 0, 1), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
          { center: v3(side * (flank + 0.11), mirrorY + 0.03, mirrorZ + 0.02), profile: roundedRectProfile(0.09, 0.055, 0.02, 10), right: v3(0, 0, 1), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.trim },
      );
      body.merge(stalk);

      const glass = loft(
        [
          { center: v3(side * (flank + 0.115), mirrorY + 0.03, mirrorZ + 0.005), profile: roundedRectProfile(0.075, 0.045, 0.015, 10), right: v3(0, 0, 1), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.glass },
          { center: v3(side * (flank + 0.125), mirrorY + 0.03, mirrorZ + 0.015), profile: roundedRectProfile(0.07, 0.04, 0.015, 10), right: v3(0, 0, 1), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.glass },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.glass },
      );
      body.merge(glass);
    }
  }

  // --- exhausts ------------------------------------------------------------
  const exhaustZ = -layout.carLength * 0.485;
  const exhaustY = layout.rideHeight + layout.carHeight * 0.1;
  const rearFlank = surfaceHalfWidth(exhaustZ, exhaustY);
  for (const side of [-1, 1]) {
    const pipe = revolve(
      [
        { x: 0.03, y: -0.02 },
        { x: 0.05, y: 0 },
        { x: 0.05, y: 0.09 },
        { x: 0.035, y: 0.1 },
      ],
      14,
      Math.PI * 2,
      VEHICLE_MATERIALS.trim,
    );
    pipe.rotateX(Math.PI / 2);
    pipe.translate(v3(side * rearFlank * 0.55, exhaustY, exhaustZ - 0.02));
    body.merge(pipe);
  }

  // --- front splitter, attached to the bumper rather than floating ---------
  const splitterZ = layout.carLength * 0.4;
  const splitterWidth = surfaceHalfWidth(splitterZ, layout.rideHeight * 1.2) * 2.0;
  const splitter = loft(
    [
      { center: v3(0, layout.rideHeight * 0.95, splitterZ - 0.05), profile: roundedRectProfile(splitterWidth, 0.04, 0.016, 12), right: v3(1, 0, 0), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
      { center: v3(0, layout.rideHeight * 0.82, splitterZ + 0.12), profile: roundedRectProfile(splitterWidth * 0.9, 0.03, 0.012, 12), right: v3(1, 0, 0), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
    ],
    { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.trim },
  );
  body.merge(splitter);

  // --- rear wing -----------------------------------------------------------
  if (spec.wing) {
    const wingZ = -layout.carLength * rng.float(0.4, 0.46);
    const wingY = built.beltYAt(wingZ) + layout.carHeight * rng.float(0.16, 0.3);
    const wingHalf = surfaceHalfWidth(wingZ, built.beltYAt(wingZ)) * 1.02;

    const plane = loft(
      [
        { center: v3(-wingHalf, wingY, wingZ), profile: roundedRectProfile(0.3, 0.035, 0.015, 12), right: v3(0, 0, 1), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
        { center: v3(wingHalf, wingY, wingZ), profile: roundedRectProfile(0.3, 0.035, 0.015, 12), right: v3(0, 0, 1), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
      ],
      { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.trim },
    );
    body.merge(plane);

    for (const side of [-1, 1]) {
      const endplate = loft(
        [
          { center: v3(side * wingHalf, wingY - 0.06, wingZ), profile: roundedRectProfile(0.34, 0.018, 0.008, 10), right: v3(0, 0, 1), up: v3(1, 0, 0), material: VEHICLE_MATERIALS.trim },
          { center: v3(side * wingHalf, wingY + 0.09, wingZ), profile: roundedRectProfile(0.34, 0.018, 0.008, 10), right: v3(0, 0, 1), up: v3(1, 0, 0), material: VEHICLE_MATERIALS.trim },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.trim },
      );
      body.merge(endplate);

      // Pylons: a wing floating above the deck with nothing holding it up is one
      // of the clearest tells that a model was assembled rather than designed.
      const pylon = loft(
        [
          { center: v3(side * wingHalf * 0.55, built.beltYAt(wingZ) - 0.02, wingZ), profile: roundedRectProfile(0.05, 0.14, 0.015, 8), right: v3(1, 0, 0), up: v3(0, 0, 1), material: VEHICLE_MATERIALS.trim },
          { center: v3(side * wingHalf * 0.55, wingY, wingZ), profile: roundedRectProfile(0.04, 0.12, 0.012, 8), right: v3(1, 0, 0), up: v3(0, 0, 1), material: VEHICLE_MATERIALS.trim },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.trim },
      );
      body.merge(pylon);
    }
  }
}
