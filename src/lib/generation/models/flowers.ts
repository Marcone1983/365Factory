import { PolyMesh, ellipseProfile, subdivide, triangulate, projectBoxUvs, v3 } from '@/lib/graphics/mesh-kernel';
import { arrayRadial, bend, bezier, catmullRom, sweep, taper, twist } from '@/lib/graphics/shape-ops';
import { Rng } from '@/lib/util/random';
import type { GlbMesh, GlbNode, MeshPrimitiveData } from '@/lib/graphics/gltf';

/**
 * A bouquet, built entirely from the shape operators.
 *
 * This file exists as proof that the operator set is general. There is no
 * flower-specific machinery in the kernel: a stem is a profile swept along a
 * Bézier curve, a petal is a tapered swept blade bent along its length, a
 * corolla is a radial array of petals with a per-ring tilt, and the bouquet is a
 * radial array of stems. Every one of those operators was written for cars,
 * buildings and railings just as much as for flowers.
 *
 * That generality is the point. The previous architecture needed a new
 * hand-written generator for every category, which cannot reach "any asset the
 * programming AI asks for".
 *
 * Material slots: 0 petal, 1 stem, 2 leaf, 3 centre.
 */

export const FLOWER_MATERIALS = { petal: 0, stem: 1, leaf: 2, centre: 3 } as const;

export type FlowerSpecies = 'rose' | 'tulip' | 'daisy' | 'lily';

export interface BouquetRequest {
  readonly name: string;
  readonly seed: number;
  readonly species?: FlowerSpecies;
  readonly stemCount?: number;
  readonly smoothness?: number;
}

export interface GeneratedBouquet {
  readonly meshes: readonly GlbMesh[];
  readonly nodes: readonly GlbNode[];
  readonly triangleCount: number;
  readonly species: FlowerSpecies;
  readonly stems: number;
}

interface SpeciesProfile {
  /** Petals per whorl, and how many whorls the head has. */
  readonly petalsPerWhorl: number;
  readonly whorls: number;
  /** Petal outline: length, width, and how sharply it points. */
  readonly petalLength: [number, number];
  readonly petalWidth: [number, number];
  readonly petalPoint: number;
  /** How far each whorl opens from vertical, in radians. */
  readonly openAt: (whorl: number, whorls: number) => number;
  /** Curl along the petal's own length. */
  readonly petalCurl: [number, number];
  readonly headScale: number;
  readonly centreRadius: number;
}

const SPECIES: Record<FlowerSpecies, SpeciesProfile> = {
  // A rose is many tightly-wrapped whorls that open progressively outward.
  rose: {
    petalsPerWhorl: 6,
    whorls: 4,
    petalLength: [0.05, 0.075],
    petalWidth: [0.032, 0.045],
    petalPoint: 2.2,
    openAt: (w, n) => 0.12 + (w / Math.max(1, n - 1)) ** 1.25 * 1.28,
    petalCurl: [-0.9, -1.5],
    headScale: 1,
    centreRadius: 0.012,
  },
  // A tulip is one closed cup: few petals, barely opened, strongly curled in.
  tulip: {
    petalsPerWhorl: 6,
    whorls: 1,
    petalLength: [0.08, 0.1],
    petalWidth: [0.04, 0.05],
    petalPoint: 1.6,
    openAt: () => 0.26,
    petalCurl: [-0.5, -0.8],
    headScale: 1,
    centreRadius: 0.01,
  },
  // A daisy is a flat disc of narrow rays around a large centre.
  daisy: {
    petalsPerWhorl: 16,
    whorls: 2,
    petalLength: [0.05, 0.065],
    petalWidth: [0.012, 0.018],
    petalPoint: 3,
    openAt: (w, n) => 1.32 + (w / Math.max(1, n - 1)) * 0.2,
    petalCurl: [-0.2, -0.45],
    headScale: 1,
    centreRadius: 0.022,
  },
  // A lily is six long recurved tepals that bend back on themselves.
  lily: {
    petalsPerWhorl: 3,
    whorls: 2,
    petalLength: [0.1, 0.13],
    petalWidth: [0.03, 0.042],
    petalPoint: 2.6,
    openAt: (w) => 1.05 + w * 0.32,
    petalCurl: [-1.6, -2.2],
    headScale: 1,
    centreRadius: 0.011,
  },
};

/**
 * One petal: a blade swept along a gently arcing curve, tapered toward the tip
 * and curled along its length. Sweeping rather than extruding is what gives the
 * petal thickness that varies and an edge that reads as a real margin.
 */
function buildPetal(length: number, width: number, point: number, curl: number, rng: Rng): PolyMesh {
  // The spine arcs forward slightly, so the petal is never a flat card.
  const spine = bezier(
    v3(0, 0, 0),
    v3(0, length * 0.3, width * 0.12),
    v3(0, length * 0.72, width * 0.2),
    v3(0, length, width * rng.float(0.1, 0.3)),
  );

  // A flattened profile: petals are thin across their width and thinner still
  // at the margin, which an ellipse gives directly.
  const profile = ellipseProfile(width / 2, width * 0.055, 8);

  const blade = sweep(spine, profile, {
    segments: 11,
    // Wide at the shoulder, drawn to a point at the tip.
    scaleAt: (t) => Math.sin(Math.PI * Math.min(1, t * 0.92 + 0.06)) ** (1 / point) * (1 - t * 0.12),
    capStart: true,
    capEnd: true,
    material: FLOWER_MATERIALS.petal,
  });

  // Curl: the petal rolls back on itself along its length.
  const curled = bend(blade, { along: 'y', about: 'x', angle: curl });
  // A little twist stops every petal in a whorl from being identical.
  return twist(curled, 'y', rng.float(-0.06, 0.06));
}

/** The seed head: a domed disc that the petals are arranged around. */
function buildCentre(radius: number, rng: Rng): PolyMesh {
  const dome = sweep(
    bezier(v3(0, 0, 0), v3(0, radius * 0.5, 0), v3(0, radius * 0.9, 0), v3(0, radius * 1.1, 0)),
    ellipseProfile(radius, radius, 12),
    {
      segments: 10,
      scaleAt: (t) => Math.cos((t * Math.PI) / 2) ** 0.55,
      capStart: true,
      capEnd: false,
      material: FLOWER_MATERIALS.centre,
    },
  );
  return rng.float(0, 1) > 0.5 ? twist(dome, 'y', 0.1) : dome;
}

/** A flower head: whorls of petals arrayed radially around the centre. */
function buildHead(profile: SpeciesProfile, rng: Rng): PolyMesh {
  const head = new PolyMesh();
  head.merge(buildCentre(profile.centreRadius, rng));

  for (let whorl = 0; whorl < profile.whorls; whorl += 1) {
    const t = profile.whorls === 1 ? 0 : whorl / (profile.whorls - 1);
    const length = rng.float(profile.petalLength[0], profile.petalLength[1]) * (0.72 + 0.28 * t + 0.35 * t);
    const width = rng.float(profile.petalWidth[0], profile.petalWidth[1]) * (0.8 + 0.3 * t);
    const curl = rng.float(profile.petalCurl[0], profile.petalCurl[1]);

    const petal = buildPetal(length, width, profile.petalPoint, curl, rng);
    const open = profile.openAt(whorl, profile.whorls);

    const ring = arrayRadial(petal, profile.petalsPerWhorl, v3(0, 1, 0), {
      radius: profile.centreRadius * (0.55 + t * 0.35),
      // Each whorl opens further from vertical than the one inside it, which is
      // what makes a rose read as a rose rather than as a shuttlecock.
      tiltAt: () => open,
    });

    // Offset alternate whorls so petals sit in the gaps of the ring below.
    const stagger = (Math.PI / profile.petalsPerWhorl) * (whorl % 2);
    const placed = arrayRadial(ring, 1, v3(0, 1, 0), { sweep: stagger * 2 });
    placed.translate(v3(0, profile.centreRadius * (0.85 - t * 0.5), 0));
    head.merge(placed);
  }
  return head;
}

/** A leaf: a broad short blade, bent down and twisted off the stem. */
function buildLeaf(size: number, rng: Rng): PolyMesh {
  const blade = sweep(
    bezier(v3(0, 0, 0), v3(0, size * 0.35, size * 0.1), v3(0, size * 0.75, size * 0.16), v3(0, size, size * 0.1)),
    ellipseProfile(size * 0.24, size * 0.016, 8),
    {
      segments: 9,
      scaleAt: (t) => Math.sin(Math.PI * Math.min(1, t * 0.95 + 0.05)) ** 0.62,
      material: FLOWER_MATERIALS.leaf,
    },
  );
  return twist(bend(blade, { along: 'y', about: 'x', angle: rng.float(0.5, 1.1) }), 'y', rng.float(-0.2, 0.2));
}

/** One stem with its head and leaves, standing at the origin. */
function buildStem(profile: SpeciesProfile, height: number, lean: number, rng: Rng): PolyMesh {
  const stem = new PolyMesh();

  // Stems are never straight: a Catmull-Rom through jittered waypoints gives a
  // natural sway that a single arc cannot.
  const waypoints = [
    v3(0, 0, 0),
    v3(rng.float(-0.01, 0.01), height * 0.35, rng.float(-0.01, 0.01)),
    v3(rng.float(-0.02, 0.02), height * 0.72, rng.float(-0.02, 0.02)),
    v3(Math.sin(lean) * height * 0.16, height, Math.cos(lean) * height * 0.16),
  ];
  const spine = catmullRom(waypoints);

  const shaft = sweep(spine, ellipseProfile(0.006, 0.006, 6), {
    segments: 14,
    scaleAt: (t) => 1.15 - t * 0.4,
    material: FLOWER_MATERIALS.stem,
  });
  stem.merge(shaft);

  const leaves = rng.pick([1, 2, 2, 3]);
  for (let i = 0; i < leaves; i += 1) {
    const t = rng.float(0.25, 0.7);
    const leaf = buildLeaf(rng.float(0.05, 0.085), rng);
    const rotated = arrayRadial(leaf, 1, v3(0, 1, 0), { sweep: rng.float(0, Math.PI * 2) * 2 });
    rotated.translate(spine.at(t));
    stem.merge(rotated);
  }

  const head = buildHead(profile, rng);
  const tip = spine.at(1);
  const tilt = arrayRadial(head, 1, v3(0, 1, 0), { sweep: rng.float(0, Math.PI * 2) * 2 });
  tilt.translate(tip);
  stem.merge(tilt);

  return stem;
}

export function generateBouquet(request: BouquetRequest): GeneratedBouquet {
  const rng = new Rng(request.seed);
  const species = request.species ?? rng.pick(['rose', 'tulip', 'daisy', 'lily'] as const);
  const profile = SPECIES[species];
  const stemCount = Math.max(3, Math.min(24, request.stemCount ?? rng.pick([7, 9, 11, 12])));

  const bouquet = new PolyMesh();

  for (let i = 0; i < stemCount; i += 1) {
    // Stems fan outward from a bound centre: the further from the middle, the
    // more the stem leans and the shorter it stands.
    const ring = i === 0 ? 0 : 1 + Math.floor((i - 1) / 6);
    const spread = ring * 0.055;
    const angle = (i / stemCount) * Math.PI * 2 + rng.float(-0.3, 0.3);
    const height = rng.float(0.34, 0.46) - ring * 0.035;

    const stem = buildStem(profile, height, angle, rng);
    // Lean the whole stem outward from the binding point.
    const leaned = arrayRadial(stem, 1, v3(Math.cos(angle), 0, Math.sin(angle)), {
      sweep: (ring === 0 ? 0 : rng.float(0.1, 0.22)) * 2,
    });
    leaned.translate(v3(Math.cos(angle) * spread, 0, Math.sin(angle) * spread));
    bouquet.merge(leaned);
  }

  // The binding: a tapered wrap around the gathered stems.
  const wrap = taper(
    sweep(bezier(v3(0, 0.02, 0), v3(0, 0.05, 0), v3(0, 0.08, 0), v3(0, 0.11, 0)), ellipseProfile(0.05, 0.05, 12), {
      segments: 8,
      scaleAt: (t) => 0.72 + t * 0.5,
      capStart: true,
      capEnd: false,
      material: FLOWER_MATERIALS.leaf,
    }),
    'y',
    1.1,
  );
  bouquet.merge(wrap);

  projectBoxUvs(bouquet, 1.4);
  // A bouquet is hundreds of small swept parts, so each subdivision level costs
  // four times over every one of them. One level is the practical ceiling.
  const smoothed = subdivide(bouquet, Math.max(0, Math.min(1, request.smoothness ?? 1)));
  const triangulated = triangulate(smoothed, { smoothAngleDegrees: 42 });

  const primitives: MeshPrimitiveData[] = triangulated.materialGroups.map((group) => ({
    name: `${request.name}_mat${group.material}`,
    positions: triangulated.positions,
    normals: triangulated.normals,
    uvs: triangulated.uvs,
    indices: triangulated.indices.slice(group.start, group.start + group.count),
    materialIndex: group.material,
  }));

  return {
    meshes: [{ name: `${request.name}_bouquet`, primitives }],
    nodes: [{ name: `${request.name}_bouquet`, mesh: 0 }],
    triangleCount: triangulated.indices.length / 3,
    species,
    stems: stemCount,
  };
}
