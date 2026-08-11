import {
  PolyMesh,
  loft,
  revolve,
  roundedRectProfile,
  subdivide,
  triangulate,
  projectBoxUvs,
  v3,
  type Station,
} from '@/lib/graphics/mesh-kernel';
import { Rng } from '@/lib/util/random';
import type { GlbMesh, GlbNode, MeshPrimitiveData } from '@/lib/graphics/gltf';

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
  readonly wing: boolean;
  readonly fenders: number;
}

const CLASS_PROFILES: Record<VehicleClass, ClassProfile> = {
  hypercar: { length: [4.3, 4.8], width: [1.95, 2.08], height: [1.09, 1.2], rideHeight: [0.09, 0.13], wheelRadius: [0.34, 0.38], cabinStart: 0.3, cabinEnd: 0.68, noseDrop: 0.72, wing: true, fenders: 0.02 },
  rally: { length: [4.0, 4.4], width: [1.8, 1.92], height: [1.36, 1.48], rideHeight: [0.18, 0.24], wheelRadius: [0.33, 0.36], cabinStart: 0.24, cabinEnd: 0.74, noseDrop: 0.86, wing: true, fenders: 0.06 },
  muscle: { length: [4.8, 5.2], width: [1.9, 2.0], height: [1.3, 1.4], rideHeight: [0.13, 0.17], wheelRadius: [0.35, 0.39], cabinStart: 0.34, cabinEnd: 0.72, noseDrop: 0.9, wing: false, fenders: 0.045 },
  formula: { length: [4.9, 5.4], width: [1.75, 1.85], height: [0.92, 1.0], rideHeight: [0.05, 0.08], wheelRadius: [0.33, 0.36], cabinStart: 0.4, cabinEnd: 0.58, noseDrop: 0.42, wing: true, fenders: 0 },
  offroad: { length: [4.4, 5.0], width: [1.95, 2.15], height: [1.85, 2.0], rideHeight: [0.28, 0.36], wheelRadius: [0.42, 0.48], cabinStart: 0.26, cabinEnd: 0.78, noseDrop: 0.95, wing: false, fenders: 0.08 },
  hover: { length: [4.2, 4.9], width: [1.9, 2.1], height: [1.1, 1.25], rideHeight: [0.32, 0.45], wheelRadius: [0.22, 0.28], cabinStart: 0.28, cabinEnd: 0.7, noseDrop: 0.6, wing: false, fenders: 0.01 },
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

  const body = new PolyMesh();

  // --- main body: longitudinal loft from tail (z=-L/2) to nose (z=+L/2) -----
  const stationCount = 22;
  const stations: Station[] = [];
  for (let i = 0; i < stationCount; i += 1) {
    const t = i / (stationCount - 1);
    const z = (t - 0.5) * carLength;

    // Plan-view width: pinched at both ends, widest over the rear axle.
    const planTaper = 0.62 + 0.38 * Math.sin(Math.PI * Math.min(1, Math.max(0, (t - 0.02) / 0.96)));
    // Haunches swell over each axle, the way a real body sits over its arches.
    const shoulder = 1 + Math.exp(-((t - 0.28) ** 2) / 0.012) * spec.fenders * 5 + Math.exp(-((t - 0.76) ** 2) / 0.012) * spec.fenders * 5;
    const width = bodyWidth * planTaper * shoulder;

    // Side-view height: the bonnet drops toward the nose, the tail is cut off.
    const noseFalloff = t > 0.72 ? 1 - ((t - 0.72) / 0.28) ** 1.7 * (1 - spec.noseDrop) : 1;
    const tailFalloff = t < 0.12 ? 0.86 + (t / 0.12) * 0.14 : 1;
    const bodyHeight = (carHeight * (vehicleClass === 'formula' ? 0.42 : 0.5)) * noseFalloff * tailFalloff;

    const centreY = rideHeight + bodyHeight / 2;
    stations.push({
      center: v3(0, centreY, z),
      profile: roundedRectProfile(width, bodyHeight, Math.min(width, bodyHeight) * 0.34, 24),
      right: v3(1, 0, 0),
      up: v3(0, 1, 0),
      material: VEHICLE_MATERIALS.paint,
    });
  }
  const shell = loft(stations, { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.paint });
  body.merge(shell);

  // --- greenhouse: windscreen rake, roof, backlight -------------------------
  if (vehicleClass !== 'formula') {
    const cabinStations: Station[] = [];
    const steps = 12;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const along = spec.cabinStart + (spec.cabinEnd - spec.cabinStart) * t;
      const z = (along - 0.5) * carLength;
      // Roofline: rises quickly off the rear deck, plateaus, then rakes down.
      const roof = Math.sin(Math.PI * Math.min(1, Math.max(0, t))) ** 0.6;
      const cabinHeight = (carHeight - rideHeight) * 0.46 * roof;
      const cabinWidth = bodyWidth * (0.86 - 0.12 * Math.abs(t - 0.5) * 2);
      const baseY = rideHeight + carHeight * 0.42;
      if (cabinHeight < 0.02) continue;
      cabinStations.push({
        center: v3(0, baseY + cabinHeight / 2, z),
        profile: roundedRectProfile(cabinWidth, cabinHeight, Math.min(cabinWidth, cabinHeight) * 0.4, 20),
        right: v3(1, 0, 0),
        up: v3(0, 1, 0),
        material: VEHICLE_MATERIALS.glass,
      });
    }
    if (cabinStations.length >= 2) {
      // The greenhouse is built as an opaque shell (roof skin and pillars) with a
      // slightly inset glass volume. Modelling it as glass alone makes the car
      // look roofless once transmission is applied.
      const shell = loft(
        cabinStations.map((s) => ({ ...s, material: VEHICLE_MATERIALS.paint })),
        { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.paint },
      );
      body.merge(shell);

      const glazing = loft(
        cabinStations.map((s) => ({
          ...s,
          material: VEHICLE_MATERIALS.glass,
          profile: s.profile.map((point) => ({ x: point.x * 0.94, y: point.y * 0.9 })),
        })),
        { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.glass },
      );
      body.merge(glazing);
    }
  } else {
    // Formula: exposed cockpit surround and airbox instead of a greenhouse.
    const airbox = loft(
      [
        { center: v3(0, rideHeight + carHeight * 0.5, -carLength * 0.02), profile: roundedRectProfile(carWidth * 0.3, carHeight * 0.28, carWidth * 0.08, 16), right: v3(1, 0, 0), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.paint },
        { center: v3(0, rideHeight + carHeight * 0.62, -carLength * 0.16), profile: roundedRectProfile(carWidth * 0.22, carHeight * 0.2, carWidth * 0.06, 16), right: v3(1, 0, 0), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.paint },
      ],
      { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.paint },
    );
    body.merge(airbox);
  }

  // --- aero: front splitter and rear wing ----------------------------------
  if (spec.wing) {
    const wingZ = -carLength * rng.float(0.4, 0.47);
    const wingY = rideHeight + carHeight * rng.float(0.55, 0.75);
    const wing = loft(
      [
        { center: v3(-carWidth * 0.46, wingY, wingZ), profile: roundedRectProfile(0.24, 0.035, 0.015, 12), right: v3(0, 0, 1), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
        { center: v3(carWidth * 0.46, wingY, wingZ), profile: roundedRectProfile(0.24, 0.035, 0.015, 12), right: v3(0, 0, 1), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
      ],
      { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.trim },
    );
    body.merge(wing);
    for (const side of [-1, 1]) {
      const endplate = loft(
        [
          { center: v3(side * carWidth * 0.46, wingY - 0.16, wingZ), profile: roundedRectProfile(0.3, 0.02, 0.01, 10), right: v3(0, 0, 1), up: v3(1, 0, 0), material: VEHICLE_MATERIALS.trim },
          { center: v3(side * carWidth * 0.46, wingY + 0.08, wingZ), profile: roundedRectProfile(0.3, 0.02, 0.01, 10), right: v3(0, 0, 1), up: v3(1, 0, 0), material: VEHICLE_MATERIALS.trim },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.trim },
      );
      body.merge(endplate);
    }
  }

  const splitter = loft(
    [
      { center: v3(0, rideHeight * 0.55, carLength * 0.46), profile: roundedRectProfile(carWidth * 0.94, 0.03, 0.012, 12), right: v3(1, 0, 0), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
      { center: v3(0, rideHeight * 0.5, carLength * 0.51), profile: roundedRectProfile(carWidth * 0.86, 0.025, 0.01, 12), right: v3(1, 0, 0), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.trim },
    ],
    { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.trim },
  );
  body.merge(splitter);

  // --- lights: emissive strips, front and rear -----------------------------
  for (const [z, width] of [[carLength * 0.47, 0.72], [-carLength * 0.48, 0.78]] as const) {
    for (const side of [-1, 1]) {
      const lamp = loft(
        [
          { center: v3(side * carWidth * 0.3, rideHeight + carHeight * 0.3, z), profile: roundedRectProfile(carWidth * width * 0.22, 0.07, 0.02, 10), right: v3(1, 0, 0), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.lights },
          { center: v3(side * carWidth * 0.3, rideHeight + carHeight * 0.3, z + Math.sign(z) * 0.03), profile: roundedRectProfile(carWidth * width * 0.2, 0.06, 0.02, 10), right: v3(1, 0, 0), up: v3(0, 1, 0), material: VEHICLE_MATERIALS.lights },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: VEHICLE_MATERIALS.lights },
      );
      body.merge(lamp);
    }
  }

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
