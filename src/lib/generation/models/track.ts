import { PolyMesh, subdivide, triangulate, projectBoxUvs, normalize, cross, sub, add, scale, length, v3, type Vec3 } from '@/lib/graphics/mesh-kernel';
import { Rng } from '@/lib/util/random';
import type { GlbMesh, GlbNode, MeshPrimitiveData } from '@/lib/graphics/gltf';

/**
 * Race circuit generator.
 *
 * A circuit is authored the way real ones are described: a closed centre-line
 * with per-station width, banking and elevation. From that single curve the
 * generator lofts the road ribbon, the kerbs at corner apexes and exits, the
 * run-off and the barriers, and emits the gameplay data a racing game needs —
 * checkpoints, a racing line, corner classification and sector splits — so the
 * coding agent does not have to reverse-engineer the geometry it was given.
 *
 * Material slots: 0 asphalt, 1 kerb, 2 barrier, 3 run-off, 4 line markings.
 */

export const TRACK_MATERIALS = { asphalt: 0, kerb: 1, barrier: 2, runoff: 3, markings: 4 } as const;

export type TrackStyle = 'circuit' | 'street' | 'rally_stage' | 'oval' | 'canyon';

export interface TrackRequest {
  readonly name: string;
  readonly seed: number;
  readonly style?: TrackStyle;
  /** Approximate lap length in metres. */
  readonly targetLength?: number;
  readonly cornerDensity?: number;
}

export interface TrackNodePoint {
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly right: Vec3;
  readonly width: number;
  readonly banking: number;
  /** Signed curvature: positive left, negative right. */
  readonly curvature: number;
  readonly distance: number;
}

export interface Checkpoint {
  readonly index: number;
  readonly position: Vec3;
  readonly forward: Vec3;
  readonly width: number;
  readonly distance: number;
}

export interface CornerInfo {
  readonly index: number;
  readonly apexDistance: number;
  readonly radius: number;
  readonly direction: 'left' | 'right';
  readonly severity: 'hairpin' | 'slow' | 'medium' | 'fast' | 'kink';
}

export interface GeneratedTrack {
  readonly meshes: readonly GlbMesh[];
  readonly nodes: readonly GlbNode[];
  readonly triangleCount: number;
  readonly centreLine: readonly TrackNodePoint[];
  readonly racingLine: readonly Vec3[];
  readonly checkpoints: readonly Checkpoint[];
  readonly corners: readonly CornerInfo[];
  readonly lapLength: number;
  readonly startPosition: Vec3;
  readonly startForward: Vec3;
  readonly style: TrackStyle;
}

/** Closed Catmull-Rom evaluation — C1 continuous, passes through its controls. */
function catmullRom(points: readonly Vec3[], t: number): Vec3 {
  const n = points.length;
  const scaled = t * n;
  const i = Math.floor(scaled) % n;
  const f = scaled - Math.floor(scaled);
  const p0 = points[(i - 1 + n) % n] as Vec3;
  const p1 = points[i] as Vec3;
  const p2 = points[(i + 1) % n] as Vec3;
  const p3 = points[(i + 2) % n] as Vec3;
  const f2 = f * f;
  const f3 = f2 * f;
  const blend = (a: number, b: number, c: number, d: number): number =>
    0.5 * (2 * b + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f2 + (-a + 3 * b - 3 * c + d) * f3);
  return v3(blend(p0.x, p1.x, p2.x, p3.x), blend(p0.y, p1.y, p2.y, p3.y), blend(p0.z, p1.z, p2.z, p3.z));
}

function controlPoints(rng: Rng, style: TrackStyle, targetLength: number, cornerDensity: number): Vec3[] {
  const count = Math.max(6, Math.round(6 + cornerDensity * 14));
  const baseRadius = targetLength / (Math.PI * 2);
  const points: Vec3[] = [];

  for (let i = 0; i < count; i += 1) {
    const angle = (i / count) * Math.PI * 2;
    let radial = baseRadius;
    let elevation = 0;

    switch (style) {
      case 'oval':
        radial = baseRadius * (1 + 0.45 * Math.cos(angle * 2));
        elevation = 0;
        break;
      case 'street':
        // Street circuits are angular: alternate long straights with tight turns.
        radial = baseRadius * (i % 2 === 0 ? rng.float(0.78, 0.92) : rng.float(1.1, 1.32));
        elevation = rng.float(-2, 2);
        break;
      case 'rally_stage':
        radial = baseRadius * rng.float(0.6, 1.5);
        elevation = rng.float(-18, 18);
        break;
      case 'canyon':
        radial = baseRadius * rng.float(0.7, 1.35);
        elevation = Math.sin(angle * 3) * 22 + rng.float(-6, 6);
        break;
      case 'circuit':
      default:
        radial = baseRadius * rng.float(0.82, 1.24);
        elevation = Math.sin(angle * 2 + rng.float(0, 1)) * 6 + rng.float(-3, 3);
        break;
    }
    points.push(v3(Math.cos(angle) * radial, elevation, Math.sin(angle) * radial));
  }
  return points;
}

export function generateTrack(request: TrackRequest): GeneratedTrack {
  const rng = new Rng(request.seed);
  const style = request.style ?? rng.pick(['circuit', 'street', 'rally_stage', 'oval', 'canyon'] as const);
  const targetLength = request.targetLength ?? rng.float(2600, 5200);
  const cornerDensity = request.cornerDensity ?? rng.float(0.35, 0.9);

  const controls = controlPoints(rng, style, targetLength, cornerDensity);
  const samples = Math.max(180, Math.round(targetLength / 8));

  // Sample the spline, then compute an arc-length parameterisation so stations
  // are evenly spaced — uneven spacing is what makes generated roads pulse.
  const raw: Vec3[] = [];
  for (let i = 0; i < samples; i += 1) raw.push(catmullRom(controls, i / samples));

  const widthBase = style === 'rally_stage' ? rng.float(7, 9) : style === 'oval' ? rng.float(14, 18) : rng.float(11, 15);
  const centreLine: TrackNodePoint[] = [];
  let distance = 0;

  for (let i = 0; i < raw.length; i += 1) {
    const current = raw[i] as Vec3;
    const next = raw[(i + 1) % raw.length] as Vec3;
    const previous = raw[(i - 1 + raw.length) % raw.length] as Vec3;
    const forward = normalize(sub(next, previous));
    const right = normalize(cross(v3(0, 1, 0), forward));

    // Signed curvature from the turn angle between the incoming and outgoing legs.
    const incoming = normalize(sub(current, previous));
    const outgoing = normalize(sub(next, current));
    const turn = Math.atan2(cross(incoming, outgoing).y, incoming.x * outgoing.x + incoming.z * outgoing.z);
    const segment = length(sub(next, current));
    const curvature = segment > 1e-6 ? turn / segment : 0;

    // Real circuits widen at corner entry and bank into the turn.
    const widen = 1 + Math.min(0.35, Math.abs(curvature) * 22);
    const banking = Math.max(-0.22, Math.min(0.22, -curvature * (style === 'oval' ? 42 : 16)));

    centreLine.push({ position: current, forward, right, width: widthBase * widen, banking, curvature, distance });
    distance += segment;
  }

  const lapLength = distance;

  // --- road ribbon ---------------------------------------------------------
  const road = new PolyMesh();
  const leftEdge: number[] = [];
  const rightEdge: number[] = [];

  for (const [i, node] of centreLine.entries()) {
    const half = node.width / 2;
    const bankOffset = Math.tan(node.banking) * half;
    const l = add(add(node.position, scale(node.right, -half)), v3(0, -bankOffset, 0));
    const r = add(add(node.position, scale(node.right, half)), v3(0, bankOffset, 0));
    const v = node.distance / 12;
    leftEdge.push(road.addVertex(l, { u: 0, v }));
    rightEdge.push(road.addVertex(r, { u: 1, v }));
    void i;
  }
  for (let i = 0; i < centreLine.length; i += 1) {
    const j = (i + 1) % centreLine.length;
    road.addFace(
      [leftEdge[i] as number, rightEdge[i] as number, rightEdge[j] as number, leftEdge[j] as number],
      TRACK_MATERIALS.asphalt,
    );
  }
  // The road edge must stay razor sharp against the kerb after subdivision.
  for (let i = 0; i < centreLine.length; i += 1) {
    const j = (i + 1) % centreLine.length;
    road.crease(leftEdge[i] as number, leftEdge[j] as number, 4);
    road.crease(rightEdge[i] as number, rightEdge[j] as number, 4);
  }

  // --- kerbs at corners ----------------------------------------------------
  const kerbs = new PolyMesh();
  const kerbWidth = 1.1;
  for (let i = 0; i < centreLine.length; i += 1) {
    const node = centreLine[i] as TrackNodePoint;
    if (Math.abs(node.curvature) < 0.004) continue;
    const j = (i + 1) % centreLine.length;
    const next = centreLine[j] as TrackNodePoint;
    const side = node.curvature > 0 ? -1 : 1;

    const innerA = add(node.position, scale(node.right, (side * node.width) / 2));
    const outerA = add(node.position, scale(node.right, side * (node.width / 2 + kerbWidth)));
    const innerB = add(next.position, scale(next.right, (side * next.width) / 2));
    const outerB = add(next.position, scale(next.right, side * (next.width / 2 + kerbWidth)));
    const lift = v3(0, 0.06, 0);

    const a = kerbs.addVertex(innerA, { u: 0, v: node.distance / 4 });
    const b = kerbs.addVertex(add(outerA, lift), { u: 1, v: node.distance / 4 });
    const c = kerbs.addVertex(add(outerB, lift), { u: 1, v: next.distance / 4 });
    const d = kerbs.addVertex(innerB, { u: 0, v: next.distance / 4 });
    kerbs.addFace([a, b, c, d], TRACK_MATERIALS.kerb, true);
  }

  // --- barriers ------------------------------------------------------------
  const barriers = new PolyMesh();
  const barrierHeight = style === 'street' ? 1.3 : 0.95;
  const barrierOffset = style === 'rally_stage' ? 6 : 3.2;
  for (const side of [-1, 1]) {
    const bottom: number[] = [];
    const top: number[] = [];
    for (const node of centreLine) {
      const base = add(node.position, scale(node.right, side * (node.width / 2 + barrierOffset)));
      bottom.push(barriers.addVertex(base, { u: 0, v: node.distance / 6 }));
      top.push(barriers.addVertex(add(base, v3(0, barrierHeight, 0)), { u: 1, v: node.distance / 6 }));
    }
    for (let i = 0; i < centreLine.length; i += 1) {
      const j = (i + 1) % centreLine.length;
      const face = side > 0
        ? [bottom[i] as number, top[i] as number, top[j] as number, bottom[j] as number]
        : [bottom[j] as number, top[j] as number, top[i] as number, bottom[i] as number];
      barriers.addFace(face, TRACK_MATERIALS.barrier, true);
    }
  }

  // --- run-off apron -------------------------------------------------------
  const runoff = new PolyMesh();
  for (const side of [-1, 1]) {
    const inner: number[] = [];
    const outer: number[] = [];
    for (const node of centreLine) {
      const i0 = add(node.position, scale(node.right, side * (node.width / 2)));
      const o0 = add(add(node.position, scale(node.right, side * (node.width / 2 + barrierOffset))), v3(0, -0.05, 0));
      inner.push(runoff.addVertex(i0, { u: 0, v: node.distance / 10 }));
      outer.push(runoff.addVertex(o0, { u: 1, v: node.distance / 10 }));
    }
    for (let i = 0; i < centreLine.length; i += 1) {
      const j = (i + 1) % centreLine.length;
      const face = side > 0
        ? [inner[i] as number, outer[i] as number, outer[j] as number, inner[j] as number]
        : [inner[j] as number, outer[j] as number, outer[i] as number, inner[i] as number];
      runoff.addFace(face, TRACK_MATERIALS.runoff);
    }
  }

  const world = new PolyMesh();
  world.merge(road);
  world.merge(kerbs);
  world.merge(barriers);
  world.merge(runoff);
  projectBoxUvs(world, 0.08);

  const smooth = subdivide(world, 1);
  const triangulated = triangulate(smooth, { smoothAngleDegrees: 30 });
  const primitives: MeshPrimitiveData[] = triangulated.materialGroups.map((group) => ({
    name: `${request.name}_mat${group.material}`,
    positions: triangulated.positions,
    normals: triangulated.normals,
    uvs: triangulated.uvs,
    indices: triangulated.indices.slice(group.start, group.start + group.count),
    materialIndex: group.material,
  }));

  // --- gameplay data -------------------------------------------------------
  const checkpointCount = Math.max(8, Math.round(lapLength / 220));
  const checkpoints: Checkpoint[] = Array.from({ length: checkpointCount }, (_value, index) => {
    const node = centreLine[Math.round((index / checkpointCount) * centreLine.length) % centreLine.length] as TrackNodePoint;
    return { index, position: node.position, forward: node.forward, width: node.width, distance: node.distance };
  });

  // Racing line: bias toward the inside of each corner, with an outside entry.
  const racingLine: Vec3[] = centreLine.map((node, index) => {
    const lookahead = centreLine[(index + 6) % centreLine.length] as TrackNodePoint;
    const blended = node.curvature * 0.6 + lookahead.curvature * 0.4;
    const bias = Math.max(-0.72, Math.min(0.72, -blended * 90));
    return add(node.position, scale(node.right, (bias * node.width) / 2));
  });

  const corners = classifyCorners(centreLine);
  const start = centreLine[0] as TrackNodePoint;

  return {
    meshes: [{ name: request.name, primitives }],
    nodes: [{ name: request.name, mesh: 0 }],
    triangleCount: triangulated.indices.length / 3,
    centreLine,
    racingLine,
    checkpoints,
    corners,
    lapLength,
    startPosition: add(start.position, v3(0, 0.5, 0)),
    startForward: start.forward,
    style,
  };
}

function classifyCorners(centreLine: readonly TrackNodePoint[]): CornerInfo[] {
  const corners: CornerInfo[] = [];
  let insideCorner = false;
  let apex = 0;
  let peak = 0;

  for (let i = 0; i < centreLine.length; i += 1) {
    const node = centreLine[i] as TrackNodePoint;
    const magnitude = Math.abs(node.curvature);
    if (magnitude > 0.006) {
      if (!insideCorner) {
        insideCorner = true;
        apex = i;
        peak = magnitude;
      } else if (magnitude > peak) {
        peak = magnitude;
        apex = i;
      }
    } else if (insideCorner) {
      insideCorner = false;
      const node0 = centreLine[apex] as TrackNodePoint;
      const radius = peak > 1e-6 ? 1 / peak : 1e6;
      corners.push({
        index: corners.length,
        apexDistance: node0.distance,
        radius,
        direction: node0.curvature > 0 ? 'left' : 'right',
        severity: radius < 25 ? 'hairpin' : radius < 60 ? 'slow' : radius < 130 ? 'medium' : radius < 300 ? 'fast' : 'kink',
      });
    }
  }
  return corners;
}
