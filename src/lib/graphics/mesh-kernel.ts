/**
 * Polygon mesh kernel.
 *
 * The difference between "geometric crap" and a model worth shipping is almost
 * never triangle count — it is *surface continuity*. A box stays a box at any
 * resolution. This kernel therefore works on a general polygon mesh with real
 * connectivity and provides the operators that produce continuous surfaces:
 *
 *   - Catmull-Clark subdivision (the film/game standard for organic surfaces)
 *   - lofting along a rail with per-station profiles (car bodies, tracks, barrels)
 *   - revolution, extrusion and bevelling
 *   - creased edges, so a subdivided car keeps its panel lines instead of melting
 *   - smooth vertex normals with an angle threshold, and quadric-error decimation
 *     for LODs
 *
 * Everything downstream — vehicles, tracks, characters, weapons — is expressed
 * with these operators rather than with primitive solids.
 */

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export function v3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

export function dot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

export function length(a: Vec3): number {
  return Math.hypot(a.x, a.y, a.z);
}

export function normalize(a: Vec3): Vec3 {
  const l = length(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: a.z + (b.z - a.z) * t };
}

export interface Face {
  /** Vertex indices in winding order. Any arity ≥ 3. */
  readonly vertices: number[];
  /** Material slot this face belongs to. */
  material: number;
  /** Marks the face as sharp so subdivision does not round its border. */
  sharp?: boolean;
}

export interface Vertex {
  position: Vec3;
  uv?: { u: number; v: number };
  /** Skin binding, filled by the character generator. */
  joints?: [number, number, number, number];
  weights?: [number, number, number, number];
  /** Vertices marked as creased are pinned during subdivision. */
  crease?: number;
}

/** An editable polygon mesh. Triangulated only at export time. */
export class PolyMesh {
  readonly vertices: Vertex[] = [];
  readonly faces: Face[] = [];
  /** Edge crease weights keyed by "min:max" vertex pair. */
  readonly creases = new Map<string, number>();

  static edgeKey(a: number, b: number): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }

  addVertex(position: Vec3, uv?: { u: number; v: number }): number {
    this.vertices.push({ position, uv });
    return this.vertices.length - 1;
  }

  addFace(vertices: number[], material = 0, sharp = false): number {
    this.faces.push({ vertices, material, sharp });
    return this.faces.length - 1;
  }

  crease(a: number, b: number, weight = 1): void {
    this.creases.set(PolyMesh.edgeKey(a, b), weight);
  }

  /** Marks every edge of a face as creased — used for panel lines and hard trim. */
  creaseFace(faceIndex: number, weight = 1): void {
    const face = this.faces[faceIndex];
    if (!face) return;
    for (let i = 0; i < face.vertices.length; i += 1) {
      this.crease(face.vertices[i] as number, face.vertices[(i + 1) % face.vertices.length] as number, weight);
    }
  }

  clone(): PolyMesh {
    const copy = new PolyMesh();
    for (const vertex of this.vertices) {
      copy.vertices.push({
        position: { ...vertex.position },
        uv: vertex.uv ? { ...vertex.uv } : undefined,
        joints: vertex.joints ? ([...vertex.joints] as [number, number, number, number]) : undefined,
        weights: vertex.weights ? ([...vertex.weights] as [number, number, number, number]) : undefined,
        crease: vertex.crease,
      });
    }
    for (const face of this.faces) copy.faces.push({ vertices: [...face.vertices], material: face.material, sharp: face.sharp });
    for (const [key, value] of this.creases) copy.creases.set(key, value);
    return copy;
  }

  /** Appends `other`, offsetting its indices. Returns the vertex offset applied. */
  merge(other: PolyMesh, materialOffset = 0): number {
    const offset = this.vertices.length;
    for (const vertex of other.vertices) {
      this.vertices.push({
        position: { ...vertex.position },
        uv: vertex.uv ? { ...vertex.uv } : undefined,
        joints: vertex.joints ? ([...vertex.joints] as [number, number, number, number]) : undefined,
        weights: vertex.weights ? ([...vertex.weights] as [number, number, number, number]) : undefined,
        crease: vertex.crease,
      });
    }
    for (const face of other.faces) {
      this.faces.push({
        vertices: face.vertices.map((i) => i + offset),
        material: face.material + materialOffset,
        sharp: face.sharp,
      });
    }
    for (const [key, weight] of other.creases) {
      const [a, b] = key.split(':').map(Number);
      this.crease((a as number) + offset, (b as number) + offset, weight);
    }
    return offset;
  }

  transform(fn: (position: Vec3, index: number) => Vec3): this {
    this.vertices.forEach((vertex, index) => {
      vertex.position = fn(vertex.position, index);
    });
    return this;
  }

  translate(offset: Vec3): this {
    return this.transform((p) => add(p, offset));
  }

  scaleBy(factor: Vec3): this {
    return this.transform((p) => ({ x: p.x * factor.x, y: p.y * factor.y, z: p.z * factor.z }));
  }

  rotateY(radians: number): this {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return this.transform((p) => ({ x: p.x * c + p.z * s, y: p.y, z: -p.x * s + p.z * c }));
  }

  rotateX(radians: number): this {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return this.transform((p) => ({ x: p.x, y: p.y * c - p.z * s, z: p.y * s + p.z * c }));
  }

  rotateZ(radians: number): this {
    const c = Math.cos(radians);
    const s = Math.sin(radians);
    return this.transform((p) => ({ x: p.x * c - p.y * s, y: p.x * s + p.y * c, z: p.z }));
  }

  /** Mirrors across X and reverses winding, for symmetric models. */
  mirroredX(): PolyMesh {
    const mirror = this.clone();
    mirror.transform((p) => ({ x: -p.x, y: p.y, z: p.z }));
    for (const face of mirror.faces) face.vertices.reverse();
    return mirror;
  }

  bounds(): { min: Vec3; max: Vec3 } {
    const min = v3(Infinity, Infinity, Infinity);
    const max = v3(-Infinity, -Infinity, -Infinity);
    for (const { position } of this.vertices) {
      min.x = Math.min(min.x, position.x);
      min.y = Math.min(min.y, position.y);
      min.z = Math.min(min.z, position.z);
      max.x = Math.max(max.x, position.x);
      max.y = Math.max(max.y, position.y);
      max.z = Math.max(max.z, position.z);
    }
    return { min, max };
  }

  get triangleCount(): number {
    return this.faces.reduce((sum, face) => sum + Math.max(0, face.vertices.length - 2), 0);
  }
}

// ------------------------------------------------------- Catmull-Clark ------

interface EdgeRecord {
  a: number;
  b: number;
  faces: number[];
  pointIndex: number;
}

/**
 * One Catmull-Clark subdivision step.
 *
 * Standard formulation: face points, edge points, then vertex repositioning by
 * (F + 2R + (n-3)P) / n. Creased edges and sharp faces bypass the smoothing
 * rules so hard features (panel gaps, weapon rails, kerb edges) stay crisp while
 * everything else becomes a continuous surface.
 */
export function subdivideCatmullClark(mesh: PolyMesh): PolyMesh {
  const out = new PolyMesh();
  const facePoints: number[] = [];
  const edges = new Map<string, EdgeRecord>();

  // 1. Face points.
  mesh.faces.forEach((face, faceIndex) => {
    let sum = v3();
    for (const index of face.vertices) sum = add(sum, (mesh.vertices[index] as Vertex).position);
    const centroid = scale(sum, 1 / face.vertices.length);
    facePoints[faceIndex] = out.addVertex(centroid, averageUv(mesh, face.vertices));
  });

  // 2. Edge topology.
  mesh.faces.forEach((face, faceIndex) => {
    for (let i = 0; i < face.vertices.length; i += 1) {
      const a = face.vertices[i] as number;
      const b = face.vertices[(i + 1) % face.vertices.length] as number;
      const key = PolyMesh.edgeKey(a, b);
      const existing = edges.get(key);
      if (existing) existing.faces.push(faceIndex);
      else edges.set(key, { a, b, faces: [faceIndex], pointIndex: -1 });
    }
  });

  // 3. Edge points.
  for (const record of edges.values()) {
    const pa = (mesh.vertices[record.a] as Vertex).position;
    const pb = (mesh.vertices[record.b] as Vertex).position;
    const creaseWeight = mesh.creases.get(PolyMesh.edgeKey(record.a, record.b)) ?? 0;
    const boundary = record.faces.length < 2;
    let point: Vec3;
    if (boundary || creaseWeight >= 1) {
      point = scale(add(pa, pb), 0.5);
    } else {
      let sum = add(pa, pb);
      for (const faceIndex of record.faces) sum = add(sum, (out.vertices[facePoints[faceIndex] as number] as Vertex).position);
      const smooth = scale(sum, 1 / (2 + record.faces.length));
      const sharp = scale(add(pa, pb), 0.5);
      point = creaseWeight > 0 ? lerp3(smooth, sharp, Math.min(1, creaseWeight)) : smooth;
    }
    record.pointIndex = out.addVertex(point, averageUv(mesh, [record.a, record.b]));
  }

  // 4. Repositioned original vertices.
  const vertexPoints: number[] = [];
  const incidentFaces: number[][] = mesh.vertices.map(() => []);
  mesh.faces.forEach((face, faceIndex) => {
    for (const index of face.vertices) (incidentFaces[index] as number[]).push(faceIndex);
  });
  const incidentEdges: EdgeRecord[][] = mesh.vertices.map(() => []);
  for (const record of edges.values()) {
    (incidentEdges[record.a] as EdgeRecord[]).push(record);
    (incidentEdges[record.b] as EdgeRecord[]).push(record);
  }

  mesh.vertices.forEach((vertex, index) => {
    const faces = incidentFaces[index] as number[];
    const vertexEdges = incidentEdges[index] as EdgeRecord[];
    const boundaryEdges = vertexEdges.filter((e) => e.faces.length < 2);
    const creasedEdges = vertexEdges.filter((e) => (mesh.creases.get(PolyMesh.edgeKey(e.a, e.b)) ?? 0) >= 1);
    const sharpEdges = boundaryEdges.length > 0 ? boundaryEdges : creasedEdges;

    let position: Vec3;
    if ((vertex.crease ?? 0) >= 1 || sharpEdges.length > 2 || faces.length === 0) {
      position = vertex.position; // corner: pinned
    } else if (sharpEdges.length === 2) {
      // Crease rule: (P*6 + neighbour + neighbour) / 8 keeps the crease a smooth curve.
      const n1 = otherEnd(sharpEdges[0] as EdgeRecord, index);
      const n2 = otherEnd(sharpEdges[1] as EdgeRecord, index);
      position = scale(
        add(add(scale(vertex.position, 6), (mesh.vertices[n1] as Vertex).position), (mesh.vertices[n2] as Vertex).position),
        1 / 8,
      );
    } else {
      let faceSum = v3();
      for (const faceIndex of faces) faceSum = add(faceSum, (out.vertices[facePoints[faceIndex] as number] as Vertex).position);
      const f = scale(faceSum, 1 / faces.length);

      let edgeSum = v3();
      for (const record of vertexEdges) {
        const midpoint = scale(add((mesh.vertices[record.a] as Vertex).position, (mesh.vertices[record.b] as Vertex).position), 0.5);
        edgeSum = add(edgeSum, midpoint);
      }
      const r = scale(edgeSum, 1 / Math.max(1, vertexEdges.length));
      const n = faces.length;
      position = scale(add(add(f, scale(r, 2)), scale(vertex.position, n - 3)), 1 / n);
    }
    vertexPoints[index] = out.addVertex(position, vertex.uv);
    const created = out.vertices[vertexPoints[index] as number] as Vertex;
    created.joints = vertex.joints;
    created.weights = vertex.weights;
    created.crease = vertex.crease;
  });

  // 5. Emit one quad per original corner.
  mesh.faces.forEach((face, faceIndex) => {
    const count = face.vertices.length;
    for (let i = 0; i < count; i += 1) {
      const previous = face.vertices[(i + count - 1) % count] as number;
      const current = face.vertices[i] as number;
      const next = face.vertices[(i + 1) % count] as number;
      const edgeIn = edges.get(PolyMesh.edgeKey(previous, current)) as EdgeRecord;
      const edgeOut = edges.get(PolyMesh.edgeKey(current, next)) as EdgeRecord;
      out.addFace(
        [vertexPoints[current] as number, edgeOut.pointIndex, facePoints[faceIndex] as number, edgeIn.pointIndex],
        face.material,
        face.sharp,
      );
      if (face.sharp) {
        out.crease(vertexPoints[current] as number, edgeOut.pointIndex, 1);
        out.crease(vertexPoints[current] as number, edgeIn.pointIndex, 1);
      }
    }
  });

  // Preserve creases across the level so multiple steps keep hard edges hard.
  for (const record of edges.values()) {
    const weight = mesh.creases.get(PolyMesh.edgeKey(record.a, record.b)) ?? 0;
    if (weight <= 0) continue;
    const next = Math.max(0, weight - 1);
    if (next <= 0) continue;
    out.crease(vertexPoints[record.a] as number, record.pointIndex, next);
    out.crease(vertexPoints[record.b] as number, record.pointIndex, next);
  }

  return out;
}

function otherEnd(edge: EdgeRecord, index: number): number {
  return edge.a === index ? edge.b : edge.a;
}

function averageUv(mesh: PolyMesh, indices: readonly number[]): { u: number; v: number } | undefined {
  const uvs = indices.map((i) => (mesh.vertices[i] as Vertex).uv).filter((uv): uv is { u: number; v: number } => Boolean(uv));
  if (uvs.length === 0) return undefined;
  return {
    u: uvs.reduce((sum, uv) => sum + uv.u, 0) / uvs.length,
    v: uvs.reduce((sum, uv) => sum + uv.v, 0) / uvs.length,
  };
}

export function subdivide(mesh: PolyMesh, levels: number): PolyMesh {
  let current = mesh;
  for (let i = 0; i < Math.max(0, levels); i += 1) current = subdivideCatmullClark(current);
  return current;
}

export interface RelaxOptions {
  /** Passes of the λ/μ pair. Two is enough to take the edge off a boolean seam. */
  readonly iterations?: number;
  /** Inward step. Larger smooths faster and distorts more. */
  readonly lambda?: number;
  /**
   * Outward step. Taubin's method follows every shrinking pass with a slightly
   * larger expanding one, which is what separates it from plain Laplacian
   * smoothing: Laplacian smoothing works, and it deflates the model while it
   * works, so a face smoothed enough to lose its seams has also lost its nose.
   */
  readonly mu?: number;
  /**
   * Edges meeting at more than this angle are treated as intended features and
   * their vertices are left alone. Without it a panel gap, a chamfer or the rim
   * of a wheel arch dissolves along with the artefacts.
   */
  readonly preserveAngleDegrees?: number;
}

/**
 * Taubin λ/μ relaxation, feature-preserving.
 *
 * Booleans leave creases where two surfaces cross that are real geometry but
 * not intended form: the union of a jaw and a skull is one solid, and the ridge
 * along their intersection is an artefact of how it was built rather than
 * anything anatomical. Subdivision does not remove it — it is a genuine crease
 * in the control mesh, so subdivision faithfully reproduces it — and the render
 * shows it as a hard wedge across an otherwise smooth cheek.
 *
 * Relaxation moves each vertex toward the average of its neighbours, which
 * dissolves exactly that kind of high-frequency ridge while leaving the broad
 * form alone. The angle test is what keeps it honest: a vertex sitting on an
 * edge sharper than the threshold is a corner someone asked for, and it does
 * not move.
 */
export function relax(mesh: PolyMesh, options: RelaxOptions = {}): PolyMesh {
  const iterations = Math.max(0, Math.min(8, options.iterations ?? 2));
  if (iterations === 0 || mesh.vertices.length === 0) return mesh;
  const lambda = options.lambda ?? 0.5;
  const mu = options.mu ?? -0.53;
  const threshold = Math.cos(((options.preserveAngleDegrees ?? 42) * Math.PI) / 180);

  const out = mesh.clone();

  // Neighbours, and the faces each vertex belongs to, computed once.
  const neighbours: Set<number>[] = out.vertices.map(() => new Set<number>());
  const vertexFaces: number[][] = out.vertices.map(() => []);
  out.faces.forEach((face, faceIndex) => {
    const ring = face.vertices;
    for (let i = 0; i < ring.length; i += 1) {
      const current = ring[i] as number;
      const next = ring[(i + 1) % ring.length] as number;
      (neighbours[current] as Set<number>).add(next);
      (neighbours[next] as Set<number>).add(current);
      (vertexFaces[current] as number[]).push(faceIndex);
    }
  });

  // A vertex is pinned when any two faces around it disagree by more than the
  // threshold. Computed against the original mesh so the pinned set cannot
  // wander as the surface relaxes.
  const normals = out.faces.map((face) => faceNormal(out, face));
  const pinned = out.vertices.map((_, index) => {
    const faces = vertexFaces[index] as number[];
    for (let i = 0; i < faces.length; i += 1) {
      for (let j = i + 1; j < faces.length; j += 1) {
        if (dot(normals[faces[i] as number] as Vec3, normals[faces[j] as number] as Vec3) < threshold) return true;
      }
    }
    // A boundary vertex — fewer faces than neighbours — is an edge of an open
    // surface and moving it opens a gap against whatever it meets.
    return faces.length < (neighbours[index] as Set<number>).size;
  });

  const step = (factor: number): void => {
    const moved: Vec3[] = out.vertices.map((vertex, index) => {
      if (pinned[index]) return vertex.position;
      const ring = neighbours[index] as Set<number>;
      if (ring.size === 0) return vertex.position;
      let sum = v3();
      for (const other of ring) sum = add(sum, (out.vertices[other] as Vertex).position);
      const average = scale(sum, 1 / ring.size);
      return add(vertex.position, scale(sub(average, vertex.position), factor));
    });
    out.vertices.forEach((vertex, index) => {
      vertex.position = moved[index] as Vec3;
    });
  };

  for (let i = 0; i < iterations; i += 1) {
    step(lambda);
    step(mu);
  }
  return out;
}

// ------------------------------------------------------------ construction --

export interface Station {
  /** Centre of the cross-section along the rail. */
  readonly center: Vec3;
  /** Profile points in the section's local XY plane. */
  readonly profile: ReadonlyArray<{ x: number; y: number }>;
  /** Section basis; derived from the rail tangent when omitted. */
  readonly right?: Vec3;
  readonly up?: Vec3;
  readonly material?: number;
}

/**
 * Lofts a surface through a sequence of cross-sections. This is how real
 * vehicle bodies, gun barrels, boat hulls and road surfaces are modelled: the
 * silhouette is authored as curves, not assembled from primitives.
 */
export function loft(stations: readonly Station[], options: { closeRing?: boolean; capStart?: boolean; capEnd?: boolean; material?: number } = {}): PolyMesh {
  const mesh = new PolyMesh();
  if (stations.length < 2) return mesh;
  const ringSize = (stations[0] as Station).profile.length;
  const closeRing = options.closeRing ?? true;
  const rings: number[][] = [];

  stations.forEach((station, stationIndex) => {
    const tangent = stationTangent(stations, stationIndex);
    const up = station.up ?? pickUp(tangent);
    const right = station.right ?? normalize(cross(up, tangent));
    const trueUp = normalize(cross(tangent, right));
    const ring: number[] = [];
    station.profile.forEach((point, profileIndex) => {
      const position = add(station.center, add(scale(right, point.x), scale(trueUp, point.y)));
      ring.push(
        mesh.addVertex(position, {
          u: profileIndex / Math.max(1, station.profile.length - (closeRing ? 0 : 1)),
          v: stationIndex / Math.max(1, stations.length - 1),
        }),
      );
    });
    rings.push(ring);
  });

  for (let s = 0; s + 1 < rings.length; s += 1) {
    const a = rings[s] as number[];
    const b = rings[s + 1] as number[];
    const limit = closeRing ? ringSize : ringSize - 1;
    for (let i = 0; i < limit; i += 1) {
      const i2 = (i + 1) % ringSize;
      mesh.addFace([a[i] as number, a[i2] as number, b[i2] as number, b[i] as number], stations[s]?.material ?? options.material ?? 0);
    }
  }

  if (options.capStart) capRing(mesh, rings[0] as number[], true, options.material ?? 0);
  if (options.capEnd) capRing(mesh, rings[rings.length - 1] as number[], false, options.material ?? 0);
  return mesh;
}

function capRing(mesh: PolyMesh, ring: readonly number[], reverse: boolean, material: number): void {
  if (ring.length < 3) return;
  let sum = v3();
  for (const index of ring) sum = add(sum, (mesh.vertices[index] as Vertex).position);
  const center = mesh.addVertex(scale(sum, 1 / ring.length), { u: 0.5, v: 0.5 });
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i] as number;
    const b = ring[(i + 1) % ring.length] as number;
    mesh.addFace(reverse ? [center, b, a] : [center, a, b], material);
  }
}

function stationTangent(stations: readonly Station[], index: number): Vec3 {
  const previous = stations[Math.max(0, index - 1)] as Station;
  const next = stations[Math.min(stations.length - 1, index + 1)] as Station;
  const tangent = sub(next.center, previous.center);
  return length(tangent) < 1e-6 ? v3(0, 0, 1) : normalize(tangent);
}

function pickUp(tangent: Vec3): Vec3 {
  return Math.abs(tangent.y) > 0.94 ? v3(0, 0, 1) : v3(0, 1, 0);
}

/** Closed elliptical profile with optional corner rounding — the loft workhorse. */
export function roundedRectProfile(width: number, height: number, radius: number, segments = 16): Array<{ x: number; y: number }> {
  const r = Math.max(0, Math.min(radius, width / 2, height / 2));
  const points: Array<{ x: number; y: number }> = [];
  const corners: Array<[number, number, number]> = [
    [width / 2 - r, height / 2 - r, 0],
    [-(width / 2 - r), height / 2 - r, Math.PI / 2],
    [-(width / 2 - r), -(height / 2 - r), Math.PI],
    [width / 2 - r, -(height / 2 - r), (3 * Math.PI) / 2],
  ];
  const perCorner = Math.max(2, Math.round(segments / 4));
  for (const [cx, cy, startAngle] of corners) {
    for (let i = 0; i <= perCorner; i += 1) {
      const angle = startAngle + (i / perCorner) * (Math.PI / 2);
      points.push({ x: cx + Math.cos(angle) * r, y: cy + Math.sin(angle) * r });
    }
  }
  return points;
}

/**
 * Superellipse profile: |x/a|^n + |y/b|^n = 1.
 *
 * n = 2 is an ellipse, n → ∞ approaches a rectangle. Values around 2.3-2.8 give
 * the "soft rectangle" cross-section that real torsos, limbs and car bodies
 * have — rounder than a box, fuller than an ellipse — which is the single
 * biggest reason a generated body reads as anatomy rather than as a tube.
 */
export function superellipseProfile(radiusX: number, radiusY: number, exponent = 2.5, segments = 20): Array<{ x: number; y: number }> {
  const n = 2 / Math.max(0.2, exponent);
  return Array.from({ length: segments }, (_value, i) => {
    const angle = (i / segments) * Math.PI * 2;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      x: Math.sign(cos) * Math.abs(cos) ** n * radiusX,
      y: Math.sign(sin) * Math.abs(sin) ** n * radiusY,
    };
  });
}

export function ellipseProfile(radiusX: number, radiusY: number, segments = 16): Array<{ x: number; y: number }> {
  return Array.from({ length: segments }, (_value, i) => {
    const angle = (i / segments) * Math.PI * 2;
    return { x: Math.cos(angle) * radiusX, y: Math.sin(angle) * radiusY };
  });
}

/** Revolves a profile about the Y axis — bottles, wheels, domes, columns. */
export function revolve(profile: ReadonlyArray<{ x: number; y: number }>, segments: number, sweep = Math.PI * 2, material = 0): PolyMesh {
  const mesh = new PolyMesh();
  const closed = Math.abs(sweep - Math.PI * 2) < 1e-6;
  const rings: number[][] = [];
  const ringCount = closed ? segments : segments + 1;

  for (let s = 0; s < ringCount; s += 1) {
    const angle = (s / segments) * sweep;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const ring: number[] = [];
    profile.forEach((point, i) => {
      ring.push(mesh.addVertex(v3(point.x * cos, point.y, point.x * sin), { u: s / segments, v: i / Math.max(1, profile.length - 1) }));
    });
    rings.push(ring);
  }

  for (let s = 0; s < (closed ? ringCount : ringCount - 1); s += 1) {
    const a = rings[s] as number[];
    const b = rings[(s + 1) % ringCount] as number[];
    for (let i = 0; i + 1 < profile.length; i += 1) {
      mesh.addFace([a[i] as number, b[i] as number, b[i + 1] as number, a[i + 1] as number], material);
    }
  }
  return mesh;
}

/** Extrudes a closed 2D outline along +Y with capped ends. */
export function extrude(outline: ReadonlyArray<{ x: number; y: number }>, height: number, material = 0): PolyMesh {
  return loft(
    [
      { center: v3(0, 0, 0), profile: outline, right: v3(1, 0, 0), up: v3(0, 0, 1), material },
      { center: v3(0, height, 0), profile: outline, right: v3(1, 0, 0), up: v3(0, 0, 1), material },
    ],
    { closeRing: true, capStart: true, capEnd: true, material },
  );
}

// ---------------------------------------------------------------- triangles --

export interface TriangulatedMesh {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly indices: Uint32Array;
  readonly joints?: Uint16Array;
  readonly weights?: Float32Array;
  readonly materialGroups: ReadonlyArray<{ material: number; start: number; count: number }>;
}

/**
 * Triangulates and computes vertex normals.
 *
 * Vertices are split when the angle between adjacent face normals exceeds
 * `smoothAngle`, which is what makes a car body read as smooth sheet metal while
 * its panel gaps and wheel arches keep a hard edge.
 */
export function triangulate(mesh: PolyMesh, options: { smoothAngleDegrees?: number } = {}): TriangulatedMesh {
  const threshold = Math.cos(((options.smoothAngleDegrees ?? 62) * Math.PI) / 180);

  const faceNormals = mesh.faces.map((face) => faceNormal(mesh, face));
  // Face normals are averaged by area, not by count. A boolean leaves a few
  // large faces surrounded by many slivers, and counting each one equally lets a
  // sliver a thousandth of the size swing the vertex normal as hard as the
  // surface it sits on. That is what shows up as patchwork shading on an
  // otherwise smooth form — flat-looking polygonal blotches across a cheek that
  // no amount of extra geometry removes, because the geometry was never the
  // problem.
  const faceAreas = mesh.faces.map((face) => faceArea(mesh, face));

  // Slivers are excluded from normal computation altogether, not merely
  // down-weighted. A boolean leaves faces a millionth the area of their
  // neighbours whose vertices are nearly collinear, and the normal of such a
  // face is numerically meaningless — it is the cross product of two almost
  // parallel edges. Down-weighting fixes the *average*; it does not fix the
  // smoothing-angle test, which compares against that meaningless normal and
  // concludes that a smooth cheek contains a 70-degree crease. That is what
  // produced the flat wedges across the face, and no amount of extra geometry
  // removed them because the geometry was never wrong.
  const meanArea = faceAreas.length > 0 ? faceAreas.reduce((sum, area) => sum + area, 0) / faceAreas.length : 0;
  const sliverArea = meanArea * 1e-4;
  const isSliver = faceAreas.map((area) => area <= sliverArea);
  const vertexFaceMap: number[][] = mesh.vertices.map(() => []);
  mesh.faces.forEach((face, faceIndex) => {
    for (const index of face.vertices) (vertexFaceMap[index] as number[]).push(faceIndex);
  });

  const positions: number[] = [];
  const normals: number[] = [];
  const uvs: number[] = [];
  const joints: number[] = [];
  const weights: number[] = [];
  const indices: number[] = [];
  const groups: Array<{ material: number; start: number; count: number }> = [];

  // The surface normal at each vertex: every incident face, weighted by area,
  // with no threshold. This is the *bulk* direction of the surface there, and it
  // is what the smoothing test is measured against below.
  const vertexNormals: Vec3[] = mesh.vertices.map((_, index) => {
    let accumulated = v3();
    for (const faceIndex of vertexFaceMap[index] as number[]) {
      if (isSliver[faceIndex]) continue;
      accumulated = add(accumulated, scale(faceNormals[faceIndex] as Vec3, faceAreas[faceIndex] as number));
    }
    return length(accumulated) > 1e-12 ? normalize(accumulated) : v3(0, 1, 0);
  });

  // Emit per material so the exporter can produce one primitive per material.
  const materials = [...new Set(mesh.faces.map((f) => f.material))].sort((a, b) => a - b);
  const emitted = new Map<string, number>();

  for (const material of materials) {
    const start = indices.length;
    mesh.faces.forEach((face, faceIndex) => {
      if (face.material !== material) return;
      const corner: number[] = [];
      const normal = faceNormals[faceIndex] as Vec3;

      for (const vertexIndex of face.vertices) {
        // The face is compared against the *bulk* normal at this vertex rather
        // than against each neighbour in turn. That distinction is the whole
        // fix: comparing pairwise, one folded micro-face out of forty is enough
        // to fail the test for a face that lies flat on the surface, and every
        // face it touches then gets its own restricted average. On a boolean
        // result — which has thousands of such folds — that scattered a smooth
        // cheek into flat wedges. Measured against the bulk direction, a fold
        // cannot drag its neighbours with it: it is excluded, and the surface
        // around it stays one continuous shading group.
        const bulk = vertexNormals[vertexIndex] as Vec3;
        let smoothed: Vec3;
        if (dot(normal, bulk) >= threshold) {
          smoothed = bulk;
        } else {
          // A genuine hard edge: this face really does face a different way from
          // the bulk of the surface, so it averages only its own side.
          let accumulated = v3();
          for (const neighbourFace of vertexFaceMap[vertexIndex] as number[]) {
            if (isSliver[neighbourFace]) continue;
            const neighbourNormal = faceNormals[neighbourFace] as Vec3;
            if (dot(neighbourNormal, normal) >= threshold) {
              accumulated = add(accumulated, scale(neighbourNormal, faceAreas[neighbourFace] as number));
            }
          }
          smoothed = length(accumulated) > 1e-12 ? normalize(accumulated) : normal;
        }
        const key = `${vertexIndex}|${smoothed.x.toFixed(3)}|${smoothed.y.toFixed(3)}|${smoothed.z.toFixed(3)}`;
        let emittedIndex = emitted.get(key);
        if (emittedIndex === undefined) {
          const vertex = mesh.vertices[vertexIndex] as Vertex;
          emittedIndex = positions.length / 3;
          positions.push(vertex.position.x, vertex.position.y, vertex.position.z);
          normals.push(smoothed.x, smoothed.y, smoothed.z);
          uvs.push(vertex.uv?.u ?? 0, vertex.uv?.v ?? 0);
          const j = vertex.joints ?? [0, 0, 0, 0];
          const w = vertex.weights ?? [1, 0, 0, 0];
          joints.push(j[0], j[1], j[2], j[3]);
          weights.push(w[0], w[1], w[2], w[3]);
          emitted.set(key, emittedIndex);
        }
        corner.push(emittedIndex);
      }

      // Fan triangulation is correct for the convex faces subdivision produces.
      for (let i = 1; i + 1 < corner.length; i += 1) {
        indices.push(corner[0] as number, corner[i] as number, corner[i + 1] as number);
      }
    });
    const count = indices.length - start;
    if (count > 0) groups.push({ material, start, count });
  }

  const hasSkin = mesh.vertices.some((vertex) => vertex.joints !== undefined);
  return {
    positions: Float32Array.from(positions),
    normals: Float32Array.from(normals),
    uvs: Float32Array.from(uvs),
    indices: Uint32Array.from(indices),
    joints: hasSkin ? Uint16Array.from(joints) : undefined,
    weights: hasSkin ? Float32Array.from(weights) : undefined,
    materialGroups: groups,
  };
}

/** Polygon area by fan decomposition; used to weight normal averaging. */
function faceArea(mesh: PolyMesh, face: Face): number {
  if (face.vertices.length < 3) return 0;
  const origin = (mesh.vertices[face.vertices[0] as number] as Vertex).position;
  let total = 0;
  for (let i = 1; i + 1 < face.vertices.length; i += 1) {
    const a = (mesh.vertices[face.vertices[i] as number] as Vertex).position;
    const b = (mesh.vertices[face.vertices[i + 1] as number] as Vertex).position;
    total += length(cross(sub(a, origin), sub(b, origin))) / 2;
  }
  return total;
}

function faceNormal(mesh: PolyMesh, face: Face): Vec3 {
  // Newell's method: correct for non-planar polygons, which subdivision produces.
  let normal = v3();
  for (let i = 0; i < face.vertices.length; i += 1) {
    const current = (mesh.vertices[face.vertices[i] as number] as Vertex).position;
    const next = (mesh.vertices[face.vertices[(i + 1) % face.vertices.length] as number] as Vertex).position;
    normal.x += (current.y - next.y) * (current.z + next.z);
    normal.y += (current.z - next.z) * (current.x + next.x);
    normal.z += (current.x - next.x) * (current.y + next.y);
  }
  const l = length(normal);
  if (l < 1e-9) return v3(0, 1, 0);
  normal = scale(normal, 1 / l);
  return normal;
}

// ------------------------------------------------------------------- UVs ----

/**
 * Cylindrical UV projection about the Y axis. Applied after subdivision so the
 * texture follows the final surface rather than the control cage.
 */
export function projectCylindricalUvs(mesh: PolyMesh, repeatY = 1): void {
  const { min, max } = mesh.bounds();
  const height = Math.max(1e-6, max.y - min.y);
  for (const vertex of mesh.vertices) {
    const angle = Math.atan2(vertex.position.z, vertex.position.x);
    vertex.uv = { u: (angle + Math.PI) / (Math.PI * 2), v: ((vertex.position.y - min.y) / height) * repeatY };
  }
}

/** Triplanar-style box projection: no seams to author, good for hard surfaces. */
export interface AutoCreaseOptions {
  /** Edges meeting at more than this angle are treated as intended edges. */
  readonly angleDegrees?: number;
  /**
   * How much of the edge survives subdivision, 0 to 1. Below 1 the edge is
   * *semi-sharp*: subdivision rounds it over a radius that shrinks with the
   * weight instead of either melting it into the surface or leaving it razor
   * sharp.
   */
  readonly weight?: number;
}

/**
 * Marks the model's real edges as semi-sharp creases.
 *
 * This is the difference between hard-surface geometry that reads as a
 * manufactured object and hard-surface geometry that reads as CG, and it has
 * nothing to do with resolution. No edge in the physical world is perfectly
 * sharp: a pressed panel, a machined block, a moulded bumper all carry a radius
 * of a fraction of a millimetre, and that radius catches a thin bright line
 * along every edge. The eye reads form from those lines. Take them away and the
 * object looks like untextured CAD however good its materials are.
 *
 * Subdivision on its own offers only the two wrong answers. Left alone it treats
 * every edge as smooth and melts a bonnet shut-line into a soft swell; creased
 * at full weight it keeps the edge mathematically sharp, which catches no
 * highlight at all. A fractional weight is the third answer: the edge stays
 * where it was and rounds over a controlled radius, which is what a bevel is.
 *
 * Only manifold edges are considered. An edge used by one face is a border and
 * an edge used by three is a defect, and creasing either produces a pucker.
 */
export function autoCrease(mesh: PolyMesh, options: AutoCreaseOptions = {}): PolyMesh {
  const threshold = Math.cos(((options.angleDegrees ?? 35) * Math.PI) / 180);
  const weight = Math.max(0, Math.min(1, options.weight ?? 0.8));
  if (weight <= 0) return mesh;

  const out = mesh.clone();
  const normals = out.faces.map((face) => faceNormal(out, face));
  const edgeFaces = new Map<string, number[]>();

  out.faces.forEach((face, faceIndex) => {
    for (let i = 0; i < face.vertices.length; i += 1) {
      const a = face.vertices[i] as number;
      const b = face.vertices[(i + 1) % face.vertices.length] as number;
      const key = PolyMesh.edgeKey(a, b);
      const list = edgeFaces.get(key);
      if (list) list.push(faceIndex);
      else edgeFaces.set(key, [faceIndex]);
    }
  });

  for (const [key, faces] of edgeFaces) {
    if (faces.length !== 2) continue;
    const first = normals[faces[0] as number] as Vec3;
    const second = normals[faces[1] as number] as Vec3;
    if (dot(first, second) >= threshold) continue;
    const [a, b] = key.split(':').map(Number);
    out.crease(a as number, b as number, weight);
  }
  return out;
}

export interface SculptBrush {
  /** Centre of influence. */
  readonly at: Vec3;
  /** Ellipsoidal reach. A nose ridge is long in Y, narrow in X, shallow in Z. */
  readonly radii: Vec3;
  /** Metres of displacement at the centre. Negative digs in. */
  readonly strength: number;
  /**
   * smooth  a rounded swell — cheeks, brows, lips, the ball of a nose
   * sharp   a crease that falls off fast — a nostril wing, a lid line
   * flat    a plateau with rolled edges — a forehead plane, a jaw side
   */
  readonly falloff?: 'smooth' | 'sharp' | 'flat';
  /** Push direction. Along the surface normal when omitted. */
  readonly direction?: Vec3;
}

/**
 * Sculpts a surface by displacing it, the way a modeller actually works.
 *
 * This exists because the alternative has a hard ceiling. Building a face by
 * unioning a tube for the nose, two tubes for the lips and a sphere for each eye
 * onto an egg produces exactly what it sounds like: parts stuck on a blob. Every
 * junction is a boolean seam, every seam is a crease the light catches, and no
 * amount of occlusion, texture or normal work gets past it, because the eye is
 * reading the assembly and not the surface.
 *
 * A real face is one continuous surface in which the nose, the brow and the lips
 * are *modulations* of that surface. That is what this does: each brush pushes
 * the existing surface out or in over an ellipsoidal region, so the nose is a
 * swell of the same skin as the cheek and there is no join to hide, because
 * nothing was joined.
 *
 * Every brush is evaluated against the *original* positions and the sum applied
 * once. Applying them one at a time would make the result depend on their order
 * and let a later brush ride on the displacement of an earlier one.
 */
export function sculpt(mesh: PolyMesh, brushes: readonly SculptBrush[]): PolyMesh {
  const out = mesh.clone();
  if (brushes.length === 0 || out.vertices.length === 0) return out;

  // Area-weighted vertex normals: the direction a brush pushes along when it
  // does not name one, so a swell grows outward from the form rather than in
  // some fixed world direction.
  const normals: Vec3[] = out.vertices.map(() => v3());
  for (const face of out.faces) {
    const normal = faceNormal(out, face);
    const area = faceArea(out, face);
    for (const index of face.vertices) {
      normals[index] = add(normals[index] as Vec3, scale(normal, area));
    }
  }
  for (let i = 0; i < normals.length; i += 1) {
    const normal = normals[i] as Vec3;
    normals[i] = length(normal) > 1e-12 ? normalize(normal) : v3(0, 1, 0);
  }

  const original = out.vertices.map((vertex) => vertex.position);
  const displacement: Vec3[] = out.vertices.map(() => v3());

  for (const brush of brushes) {
    const rx = Math.max(1e-6, Math.abs(brush.radii.x));
    const ry = Math.max(1e-6, Math.abs(brush.radii.y));
    const rz = Math.max(1e-6, Math.abs(brush.radii.z));
    const falloff = brush.falloff ?? 'smooth';

    for (let i = 0; i < original.length; i += 1) {
      const p = original[i] as Vec3;
      const dx = (p.x - brush.at.x) / rx;
      const dy = (p.y - brush.at.y) / ry;
      const dz = (p.z - brush.at.z) / rz;
      const t = Math.hypot(dx, dy, dz);
      if (t >= 1) continue;

      let weight: number;
      if (falloff === 'sharp') {
        weight = (1 - t) * (1 - t);
      } else if (falloff === 'flat') {
        // Nearly constant across the middle, rolling off only at the rim.
        weight = 1 - t ** 6;
      } else {
        // Smoothstep squared: zero value *and* zero gradient at the rim, which
        // is what stops a brush leaving a visible ring at its own edge.
        const s = 1 - t * t;
        weight = s * s * s;
      }

      const direction = brush.direction ?? (normals[i] as Vec3);
      displacement[i] = add(displacement[i] as Vec3, scale(direction, brush.strength * weight));
    }
  }

  out.vertices.forEach((vertex, index) => {
    vertex.position = add(vertex.position, displacement[index] as Vec3);
  });
  return out;
}

export function projectBoxUvs(mesh: PolyMesh, scaleFactor = 1): void {
  for (const vertex of mesh.vertices) {
    const { x, y, z } = vertex.position;
    const ax = Math.abs(x);
    const ay = Math.abs(y);
    const az = Math.abs(z);
    if (ax >= ay && ax >= az) vertex.uv = { u: z * scaleFactor, v: y * scaleFactor };
    else if (ay >= az) vertex.uv = { u: x * scaleFactor, v: z * scaleFactor };
    else vertex.uv = { u: x * scaleFactor, v: y * scaleFactor };
  }
}

// ------------------------------------------------------------------ LOD -----

/**
 * Vertex-clustering decimation for LOD generation. Grid-snapping is used rather
 * than quadric collapse because it is order-independent and cannot produce
 * non-manifold output, and LODs are viewed at distance where the difference is
 * not visible.
 */
export function decimate(mesh: PolyMesh, cellSize: number): PolyMesh {
  const out = new PolyMesh();
  const cells = new Map<string, number>();
  const remap: number[] = [];

  mesh.vertices.forEach((vertex, index) => {
    const key = `${Math.round(vertex.position.x / cellSize)}:${Math.round(vertex.position.y / cellSize)}:${Math.round(vertex.position.z / cellSize)}`;
    const existing = cells.get(key);
    if (existing !== undefined) {
      remap[index] = existing;
      return;
    }
    const created = out.addVertex({ ...vertex.position }, vertex.uv);
    (out.vertices[created] as Vertex).joints = vertex.joints;
    (out.vertices[created] as Vertex).weights = vertex.weights;
    cells.set(key, created);
    remap[index] = created;
  });

  for (const face of mesh.faces) {
    const mapped: number[] = [];
    for (const index of face.vertices) {
      const target = remap[index] as number;
      if (mapped[mapped.length - 1] !== target) mapped.push(target);
    }
    if (mapped.length > 2 && mapped[0] === mapped[mapped.length - 1]) mapped.pop();
    if (mapped.length >= 3) out.addFace(mapped, face.material, face.sharp);
  }
  return out;
}
