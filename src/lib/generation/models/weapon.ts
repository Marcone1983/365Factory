import {
  PolyMesh,
  loft,
  revolve,
  roundedRectProfile,
  ellipseProfile,
  subdivide,
  triangulate,
  projectBoxUvs,
  v3,
  type Station,
} from '@/lib/graphics/mesh-kernel';
import { Rng } from '@/lib/util/random';
import type { GlbMesh, GlbNode, MeshPrimitiveData } from '@/lib/graphics/gltf';

/**
 * Weapon generator.
 *
 * Weapons are assembled from lofted functional components — receiver, barrel,
 * handguard, stock, magazine, optic, or blade, fuller, guard, grip, pommel —
 * rather than from primitive solids, and each component carries its own creased
 * silhouette so subdivision rounds the grips without softening the machined
 * edges.
 *
 * The muzzle / tip and grip transforms are exported as nodes so the game can
 * attach effects and hand IK without measuring the mesh.
 *
 * Material slots: 0 body/metal, 1 grip/polymer, 2 accent, 3 emissive.
 */

export const WEAPON_MATERIALS = { body: 0, grip: 1, accent: 2, emissive: 3 } as const;

export type WeaponFamily = 'rifle' | 'pistol' | 'launcher' | 'blade' | 'hammer' | 'bow' | 'energy';

export interface WeaponRequest {
  readonly name: string;
  readonly seed: number;
  readonly family?: WeaponFamily;
  /** 0 = utilitarian, 1 = ornate. Drives detail count and accents. */
  readonly ornamentation?: number;
  readonly smoothness?: number;
}

export interface GeneratedWeapon {
  readonly meshes: readonly GlbMesh[];
  readonly nodes: readonly GlbNode[];
  readonly triangleCount: number;
  readonly family: WeaponFamily;
  readonly muzzleOffset: readonly [number, number, number];
  readonly gripOffset: readonly [number, number, number];
  readonly overallLength: number;
}

function tube(
  from: number,
  to: number,
  radiusFrom: number,
  radiusTo: number,
  material: number,
  segments = 14,
  offsetY = 0,
): PolyMesh {
  const stations: Station[] = [
    { center: v3(0, offsetY, from), profile: ellipseProfile(radiusFrom, radiusFrom, segments), right: v3(1, 0, 0), up: v3(0, 1, 0), material },
    { center: v3(0, offsetY, to), profile: ellipseProfile(radiusTo, radiusTo, segments), right: v3(1, 0, 0), up: v3(0, 1, 0), material },
  ];
  return loft(stations, { closeRing: true, capStart: true, capEnd: true, material });
}

function block(width: number, height: number, from: number, to: number, material: number, offsetY = 0, radius = 0.01): PolyMesh {
  const profile = roundedRectProfile(width, height, radius, 16);
  return loft(
    [
      { center: v3(0, offsetY, from), profile, right: v3(1, 0, 0), up: v3(0, 1, 0), material },
      { center: v3(0, offsetY, to), profile, right: v3(1, 0, 0), up: v3(0, 1, 0), material },
    ],
    { closeRing: true, capStart: true, capEnd: true, material },
  );
}

function buildFirearm(rng: Rng, family: 'rifle' | 'pistol' | 'launcher' | 'energy', ornamentation: number): { mesh: PolyMesh; muzzleZ: number; gripZ: number; length: number } {
  const mesh = new PolyMesh();
  const isPistol = family === 'pistol';
  const isLauncher = family === 'launcher';
  const isEnergy = family === 'energy';

  const barrelLength = isPistol ? rng.float(0.11, 0.16) : isLauncher ? rng.float(0.34, 0.46) : rng.float(0.38, 0.54);
  const barrelRadius = isLauncher ? rng.float(0.038, 0.05) : isPistol ? rng.float(0.008, 0.011) : rng.float(0.009, 0.013);
  const receiverLength = isPistol ? rng.float(0.14, 0.18) : rng.float(0.24, 0.32);
  const receiverHeight = isPistol ? rng.float(0.05, 0.062) : rng.float(0.055, 0.075);
  const receiverWidth = rng.float(0.032, 0.046);

  const receiverFrom = 0;
  const receiverTo = receiverLength;
  mesh.merge(block(receiverWidth, receiverHeight, receiverFrom, receiverTo, WEAPON_MATERIALS.body, receiverHeight / 2, 0.008));

  // Barrel with a slight step down at the gas block, plus a muzzle device.
  const barrelFrom = receiverTo;
  const barrelTo = barrelFrom + barrelLength;
  mesh.merge(tube(barrelFrom, barrelFrom + barrelLength * 0.6, barrelRadius * 1.25, barrelRadius, WEAPON_MATERIALS.body, 14, receiverHeight * 0.62));
  mesh.merge(tube(barrelFrom + barrelLength * 0.6, barrelTo, barrelRadius, barrelRadius * 0.95, WEAPON_MATERIALS.body, 14, receiverHeight * 0.62));
  mesh.merge(tube(barrelTo, barrelTo + 0.045, barrelRadius * 1.6, barrelRadius * 1.45, WEAPON_MATERIALS.accent, 12, receiverHeight * 0.62));

  if (!isPistol) {
    // Handguard shrouding the barrel, with vent slots suggested by an inner tube.
    const guardTo = barrelFrom + barrelLength * rng.float(0.5, 0.75);
    mesh.merge(block(receiverWidth * 0.92, receiverHeight * 0.62, barrelFrom, guardTo, WEAPON_MATERIALS.grip, receiverHeight * 0.62, 0.012));
  }

  // Grip, raked back the way a real pistol grip is.
  const gripZ = isPistol ? receiverLength * 0.28 : receiverLength * 0.34;
  const gripMesh = loft(
    [
      { center: v3(0, receiverHeight * 0.1, gripZ), profile: roundedRectProfile(receiverWidth * 0.78, 0.036, 0.012, 14), right: v3(1, 0, 0), up: v3(0, 0, 1), material: WEAPON_MATERIALS.grip },
      { center: v3(0, -receiverHeight * 0.55, gripZ - 0.022), profile: roundedRectProfile(receiverWidth * 0.82, 0.04, 0.014, 14), right: v3(1, 0, 0), up: v3(0, 0, 1), material: WEAPON_MATERIALS.grip },
      { center: v3(0, -receiverHeight * 1.35, gripZ - 0.05), profile: roundedRectProfile(receiverWidth * 0.76, 0.038, 0.014, 14), right: v3(1, 0, 0), up: v3(0, 0, 1), material: WEAPON_MATERIALS.grip },
    ],
    { closeRing: true, capStart: true, capEnd: true, material: WEAPON_MATERIALS.grip },
  );
  mesh.merge(gripMesh);

  if (!isPistol) {
    // Magazine and stock.
    mesh.merge(
      loft(
        [
          { center: v3(0, -receiverHeight * 0.1, gripZ + 0.075), profile: roundedRectProfile(receiverWidth * 0.6, 0.026, 0.008, 12), right: v3(1, 0, 0), up: v3(0, 0, 1), material: WEAPON_MATERIALS.accent },
          { center: v3(0, -receiverHeight * 1.9, gripZ + 0.095), profile: roundedRectProfile(receiverWidth * 0.58, 0.026, 0.008, 12), right: v3(1, 0, 0), up: v3(0, 0, 1), material: WEAPON_MATERIALS.accent },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: WEAPON_MATERIALS.accent },
      ),
    );
    const stockLength = rng.float(0.16, 0.24);
    mesh.merge(
      loft(
        [
          { center: v3(0, receiverHeight * 0.5, -0.005), profile: roundedRectProfile(receiverWidth * 0.7, receiverHeight * 0.7, 0.01, 14), right: v3(1, 0, 0), up: v3(0, 1, 0), material: WEAPON_MATERIALS.grip },
          { center: v3(0, receiverHeight * 0.42, -stockLength * 0.5), profile: roundedRectProfile(receiverWidth * 0.5, receiverHeight * 0.45, 0.01, 14), right: v3(1, 0, 0), up: v3(0, 1, 0), material: WEAPON_MATERIALS.grip },
          { center: v3(0, receiverHeight * 0.35, -stockLength), profile: roundedRectProfile(receiverWidth * 0.8, receiverHeight * 0.95, 0.014, 14), right: v3(1, 0, 0), up: v3(0, 1, 0), material: WEAPON_MATERIALS.grip },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: WEAPON_MATERIALS.grip },
      ),
    );
  }

  // Optic rail and sight.
  if (ornamentation > 0.3 || !isPistol) {
    mesh.merge(block(receiverWidth * 0.5, 0.008, receiverLength * 0.15, receiverLength * 0.92, WEAPON_MATERIALS.accent, receiverHeight + 0.004, 0.002));
    mesh.merge(block(receiverWidth * 0.62, 0.028, receiverLength * 0.4, receiverLength * 0.72, WEAPON_MATERIALS.body, receiverHeight + 0.026, 0.006));
  }

  if (isEnergy) {
    // Emissive cells along the receiver read as a charged weapon.
    const cells = 2 + Math.round(ornamentation * 4);
    for (let i = 0; i < cells; i += 1) {
      const z = receiverLength * (0.2 + (i / cells) * 0.6);
      mesh.merge(block(receiverWidth * 1.02, 0.01, z, z + 0.018, WEAPON_MATERIALS.emissive, receiverHeight * 0.55, 0.003));
    }
    mesh.merge(tube(barrelTo + 0.045, barrelTo + 0.075, barrelRadius * 1.3, barrelRadius * 0.7, WEAPON_MATERIALS.emissive, 12, receiverHeight * 0.62));
  }

  const total = barrelTo + 0.08;
  return { mesh, muzzleZ: total, gripZ, length: total };
}

function buildMelee(rng: Rng, family: 'blade' | 'hammer' | 'bow', ornamentation: number): { mesh: PolyMesh; muzzleZ: number; gripZ: number; length: number } {
  const mesh = new PolyMesh();

  if (family === 'bow') {
    const limbLength = rng.float(0.5, 0.72);
    const stations: Station[] = [];
    const steps = 14;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const y = (t - 0.5) * 2 * limbLength;
      // Recurve: the limb curves forward then flicks back at the tip.
      const z = Math.sin(t * Math.PI) * 0.12 - Math.sin(t * Math.PI * 2) * 0.05;
      const thickness = 0.026 * (1 - Math.abs(t - 0.5) * 1.2);
      stations.push({
        center: v3(0, y, z),
        profile: roundedRectProfile(Math.max(0.008, thickness), Math.max(0.005, thickness * 0.5), 0.004, 10),
        right: v3(1, 0, 0),
        up: v3(0, 0, 1),
        material: WEAPON_MATERIALS.body,
      });
    }
    mesh.merge(loft(stations, { closeRing: true, capStart: true, capEnd: true, material: WEAPON_MATERIALS.body }));
    mesh.merge(block(0.03, 0.11, -0.02, 0.02, WEAPON_MATERIALS.grip, 0, 0.01));
    // Bowstring.
    mesh.merge(
      loft(
        [
          { center: v3(0, -limbLength, 0.07), profile: ellipseProfile(0.0022, 0.0022, 6), right: v3(1, 0, 0), up: v3(0, 0, 1), material: WEAPON_MATERIALS.accent },
          { center: v3(0, limbLength, 0.07), profile: ellipseProfile(0.0022, 0.0022, 6), right: v3(1, 0, 0), up: v3(0, 0, 1), material: WEAPON_MATERIALS.accent },
        ],
        { closeRing: true, capStart: true, capEnd: true, material: WEAPON_MATERIALS.accent },
      ),
    );
    return { mesh, muzzleZ: 0.12, gripZ: 0, length: limbLength * 2 };
  }

  const gripLength = rng.float(0.11, 0.19);
  const headLength = family === 'hammer' ? rng.float(0.16, 0.24) : rng.float(0.62, 0.98);

  // Grip with a swell and a pommel.
  mesh.merge(
    loft(
      [
        { center: v3(0, -gripLength - 0.02, 0), profile: ellipseProfile(0.022, 0.022, 12), right: v3(1, 0, 0), up: v3(0, 0, 1), material: WEAPON_MATERIALS.accent },
        { center: v3(0, -gripLength, 0), profile: ellipseProfile(0.016, 0.016, 12), right: v3(1, 0, 0), up: v3(0, 0, 1), material: WEAPON_MATERIALS.grip },
        { center: v3(0, -gripLength * 0.45, 0), profile: ellipseProfile(0.019, 0.019, 12), right: v3(1, 0, 0), up: v3(0, 0, 1), material: WEAPON_MATERIALS.grip },
        { center: v3(0, 0, 0), profile: ellipseProfile(0.017, 0.017, 12), right: v3(1, 0, 0), up: v3(0, 0, 1), material: WEAPON_MATERIALS.grip },
      ],
      { closeRing: true, capStart: true, capEnd: true, material: WEAPON_MATERIALS.grip },
    ),
  );

  if (family === 'blade') {
    // Guard, then a blade that tapers in both width and thickness to the point,
    // with a fuller implied by the narrow mid-profile.
    mesh.merge(block(0.13, 0.022, -0.012, 0.012, WEAPON_MATERIALS.accent, 0.01, 0.006).rotateY(Math.PI / 2));
    const bladeStations: Station[] = [];
    const steps = 10;
    for (let i = 0; i <= steps; i += 1) {
      const t = i / steps;
      const width = 0.052 * (1 - t ** 1.9) + 0.004;
      const thickness = 0.011 * (1 - t * 0.75);
      bladeStations.push({
        center: v3(0, 0.02 + t * headLength, 0),
        profile: [
          { x: -width / 2, y: 0 },
          { x: -width * 0.18, y: thickness / 2 },
          { x: width * 0.18, y: thickness / 2 },
          { x: width / 2, y: 0 },
          { x: width * 0.18, y: -thickness / 2 },
          { x: -width * 0.18, y: -thickness / 2 },
        ],
        right: v3(1, 0, 0),
        up: v3(0, 0, 1),
        material: WEAPON_MATERIALS.body,
      });
    }
    mesh.merge(loft(bladeStations, { closeRing: true, capStart: true, capEnd: true, material: WEAPON_MATERIALS.body }));
    if (ornamentation > 0.5) {
      mesh.merge(block(0.006, 0.006, 0.06, 0.06 + headLength * 0.7, WEAPON_MATERIALS.emissive, 0, 0.002).rotateX(Math.PI / 2).translate(v3(0, 0.06, 0)));
    }
    return { mesh, muzzleZ: 0, gripZ: -gripLength * 0.5, length: gripLength + headLength };
  }

  // Hammer: a tapered head with a striking face and a counterweight spike.
  const head = revolve(
    [
      { x: 0.0, y: 0 },
      { x: 0.05, y: 0.008 },
      { x: 0.058, y: 0.06 },
      { x: 0.05, y: headLength - 0.01 },
      { x: 0.0, y: headLength },
    ],
    12,
    Math.PI * 2,
    WEAPON_MATERIALS.body,
  );
  head.rotateX(Math.PI / 2).translate(v3(0, 0.02, -headLength / 2));
  mesh.merge(head);
  return { mesh, muzzleZ: 0, gripZ: -gripLength * 0.5, length: gripLength + headLength };
}

export function generateWeapon(request: WeaponRequest): GeneratedWeapon {
  const rng = new Rng(request.seed);
  const family = request.family ?? rng.pick(['rifle', 'pistol', 'launcher', 'blade', 'hammer', 'bow', 'energy'] as const);
  const ornamentation = request.ornamentation ?? rng.float(0.2, 0.9);

  const built =
    family === 'blade' || family === 'hammer' || family === 'bow'
      ? buildMelee(rng, family, ornamentation)
      : buildFirearm(rng, family, ornamentation);

  projectBoxUvs(built.mesh, 4);
  const smooth = subdivide(built.mesh, Math.max(0, Math.min(2, request.smoothness ?? 1)));
  const triangulated = triangulate(smooth, { smoothAngleDegrees: 42 });

  const primitives: MeshPrimitiveData[] = triangulated.materialGroups.map((group) => ({
    name: `${request.name}_mat${group.material}`,
    positions: triangulated.positions,
    normals: triangulated.normals,
    uvs: triangulated.uvs,
    indices: triangulated.indices.slice(group.start, group.start + group.count),
    materialIndex: group.material,
  }));

  const muzzle: [number, number, number] = [0, 0, built.muzzleZ];
  const grip: [number, number, number] = [0, 0, built.gripZ];

  return {
    meshes: [{ name: request.name, primitives }],
    nodes: [
      { name: request.name, mesh: 0, children: [1, 2] },
      { name: 'muzzle', translation: muzzle },
      { name: 'grip', translation: grip },
    ],
    triangleCount: triangulated.indices.length / 3,
    family,
    muzzleOffset: muzzle,
    gripOffset: grip,
    overallLength: built.length,
  };
}
