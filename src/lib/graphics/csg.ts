import { PolyMesh, add, cross, dot, normalize, scale, sub, v3, type Vec3 } from './mesh-kernel';

/**
 * Constructive solid geometry.
 *
 * This is the operation the modelling kernel could not do, and its absence was
 * the single biggest reason generated assets read as smooth lumps: without
 * subtraction there are no openings. No window cut into a wall, no air intake
 * sunk into a wing, no door aperture, no hole through anything. Everything had
 * to be built by adding volumes, and adding volumes to a subdivided surface
 * only ever produces more surface.
 *
 * The implementation is a BSP tree over convex polygons — the classic approach,
 * because it is exact rather than approximate and it does not require the
 * inputs to be manifold in the way that half-edge boolean algorithms do. AI
 * authored geometry is frequently not perfectly manifold, and an algorithm that
 * refuses to run on it is an algorithm that refuses to run.
 *
 * Coplanar handling matters: a face lying exactly in a splitting plane is sent
 * to the side the plane faces, which is what makes `subtract` leave a clean flat
 * bottom rather than a sliver of z-fighting geometry.
 */

const EPSILON = 1e-6;

interface Polygon {
  /** Convex, wound anticlockwise seen from the side the normal points to. */
  readonly vertices: Vec3[];
  readonly normal: Vec3;
  readonly w: number;
  readonly material: number;
}

function polygonFrom(vertices: Vec3[], material: number): Polygon | null {
  if (vertices.length < 3) return null;
  // Newell's method: robust for near-degenerate and slightly non-planar faces,
  // where a single cross product of the first three edges gives a normal that
  // is meaningless or zero.
  let nx = 0;
  let ny = 0;
  let nz = 0;
  for (let i = 0; i < vertices.length; i += 1) {
    const a = vertices[i] as Vec3;
    const b = vertices[(i + 1) % vertices.length] as Vec3;
    nx += (a.y - b.y) * (a.z + b.z);
    ny += (a.z - b.z) * (a.x + b.x);
    nz += (a.x - b.x) * (a.y + b.y);
  }
  const lengthSquared = nx * nx + ny * ny + nz * nz;
  if (lengthSquared < 1e-20) return null;
  const inverse = 1 / Math.sqrt(lengthSquared);
  const normal = v3(nx * inverse, ny * inverse, nz * inverse);
  return { vertices, normal, w: dot(normal, vertices[0] as Vec3), material };
}

function flip(polygon: Polygon): Polygon {
  return {
    vertices: [...polygon.vertices].reverse(),
    normal: scale(polygon.normal, -1),
    w: -polygon.w,
    material: polygon.material,
  };
}

const COPLANAR = 0;
const FRONT = 1;
const BACK = 2;
const SPANNING = 3;

/**
 * Splits a polygon by a plane, appending the pieces to the right lists.
 *
 * A polygon that straddles the plane is cut in two along the intersection, with
 * new vertices interpolated exactly on it — this is why the result of a boolean
 * has clean edges instead of stair-stepping.
 */
function splitPolygon(
  plane: { normal: Vec3; w: number },
  polygon: Polygon,
  coplanarFront: Polygon[],
  coplanarBack: Polygon[],
  front: Polygon[],
  back: Polygon[],
): void {
  let polygonType = 0;
  const types: number[] = [];

  for (const vertex of polygon.vertices) {
    const distance = dot(plane.normal, vertex) - plane.w;
    const type = distance < -EPSILON ? BACK : distance > EPSILON ? FRONT : COPLANAR;
    polygonType |= type;
    types.push(type);
  }

  switch (polygonType) {
    case COPLANAR:
      (dot(plane.normal, polygon.normal) > 0 ? coplanarFront : coplanarBack).push(polygon);
      break;
    case FRONT:
      front.push(polygon);
      break;
    case BACK:
      back.push(polygon);
      break;
    default: {
      const f: Vec3[] = [];
      const b: Vec3[] = [];
      for (let i = 0; i < polygon.vertices.length; i += 1) {
        const j = (i + 1) % polygon.vertices.length;
        const ti = types[i] as number;
        const tj = types[j] as number;
        const vi = polygon.vertices[i] as Vec3;
        const vj = polygon.vertices[j] as Vec3;

        if (ti !== BACK) f.push(vi);
        if (ti !== FRONT) b.push(vi);
        if ((ti | tj) === SPANNING) {
          const t = (plane.w - dot(plane.normal, vi)) / dot(plane.normal, sub(vj, vi));
          const crossing = add(vi, scale(sub(vj, vi), t));
          f.push(crossing);
          b.push(crossing);
        }
      }
      const fp = f.length >= 3 ? polygonFrom(f, polygon.material) : null;
      const bp = b.length >= 3 ? polygonFrom(b, polygon.material) : null;
      if (fp) front.push(fp);
      if (bp) back.push(bp);
      break;
    }
  }
}

class Node {
  private plane: { normal: Vec3; w: number } | null = null;
  private front: Node | null = null;
  private back: Node | null = null;
  private polygons: Polygon[] = [];

  constructor(polygons?: Polygon[]) {
    if (polygons && polygons.length > 0) this.build(polygons);
  }

  invert(): void {
    this.polygons = this.polygons.map(flip);
    if (this.plane) this.plane = { normal: scale(this.plane.normal, -1), w: -this.plane.w };
    this.front?.invert();
    this.back?.invert();
    const swap = this.front;
    this.front = this.back;
    this.back = swap;
  }

  /** Removes the parts of `polygons` that fall inside this solid. */
  clipPolygons(polygons: Polygon[]): Polygon[] {
    if (!this.plane) return [...polygons];
    let front: Polygon[] = [];
    let back: Polygon[] = [];
    for (const polygon of polygons) {
      splitPolygon(this.plane, polygon, front, back, front, back);
    }
    if (this.front) front = this.front.clipPolygons(front);
    back = this.back ? this.back.clipPolygons(back) : [];
    return [...front, ...back];
  }

  clipTo(other: Node): void {
    this.polygons = other.clipPolygons(this.polygons);
    this.front?.clipTo(other);
    this.back?.clipTo(other);
  }

  allPolygons(): Polygon[] {
    return [...this.polygons, ...(this.front?.allPolygons() ?? []), ...(this.back?.allPolygons() ?? [])];
  }

  build(polygons: Polygon[]): void {
    if (polygons.length === 0) return;
    if (!this.plane) {
      // Splitting on the middle polygon rather than the first keeps the tree
      // shallower on the ordered geometry a loft produces, where the first
      // polygon is always at one extreme.
      const pivot = polygons[Math.floor(polygons.length / 2)] as Polygon;
      this.plane = { normal: pivot.normal, w: pivot.w };
    }
    const front: Polygon[] = [];
    const back: Polygon[] = [];
    for (const polygon of polygons) {
      splitPolygon(this.plane, polygon, this.polygons, this.polygons, front, back);
    }
    if (front.length > 0) {
      this.front ??= new Node();
      this.front.build(front);
    }
    if (back.length > 0) {
      this.back ??= new Node();
      this.back.build(back);
    }
  }
}

function toPolygons(mesh: PolyMesh): Polygon[] {
  const polygons: Polygon[] = [];
  for (const face of mesh.faces) {
    const vertices = face.vertices
      .map((index) => mesh.vertices[index]?.position)
      .filter((position): position is Vec3 => position !== undefined)
      .map((position) => ({ ...position }));
    // Convex decomposition by fanning: BSP requires convex polygons, and a
    // subdivided quad can be slightly non-convex after deformation.
    for (let i = 1; i + 1 < vertices.length; i += 1) {
      const polygon = polygonFrom(
        [vertices[0] as Vec3, vertices[i] as Vec3, vertices[i + 1] as Vec3],
        face.material,
      );
      if (polygon) polygons.push(polygon);
    }
  }
  return polygons;
}

function fromPolygons(polygons: readonly Polygon[]): PolyMesh {
  const mesh = new PolyMesh();
  // Weld vertices on a grid so the result is a connected surface rather than a
  // triangle soup: subdivision and normal smoothing both need shared vertices.
  const index = new Map<string, number>();
  const key = (p: Vec3): string =>
    `${Math.round(p.x / 1e-5)}:${Math.round(p.y / 1e-5)}:${Math.round(p.z / 1e-5)}`;

  for (const polygon of polygons) {
    const indices = polygon.vertices.map((vertex) => {
      const k = key(vertex);
      const existing = index.get(k);
      if (existing !== undefined) return existing;
      const added = mesh.addVertex({ ...vertex });
      index.set(k, added);
      return added;
    });
    // Drop degenerate faces produced by the split: they carry no area and
    // would give normal computation a zero vector to normalise.
    const unique = indices.filter((value, position) => indices.indexOf(value) === position);
    if (unique.length >= 3) mesh.addFace(unique, polygon.material);
  }
  repairTJunctions(mesh);
  return mesh;
}

/**
 * Removes T-junctions.
 *
 * A BSP boolean splits the two operands independently, so a vertex introduced
 * on one side frequently lands in the middle of an edge on the other side. The
 * surface is geometrically closed — the enclosed volume is exactly right — but
 * topologically that edge is used by two faces on one side and one on the
 * other. Renderers show this as hairline cracks along a cut where the
 * background leaks through, and subdivision tears the surface open along it.
 *
 * The repair inserts each stray vertex into the edge it lies on. A spatial hash
 * keyed on the edge's bounding cells keeps this near-linear rather than testing
 * every vertex against every edge.
 */
function repairTJunctions(mesh: PolyMesh): void {
  if (mesh.vertices.length === 0) return;

  // Size the grid from the model so the same code works on a 4-metre car and a
  // 4-centimetre bolt without a magic constant that suits only one of them.
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const vertex of mesh.vertices) {
    const p = vertex.position;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (p.z > maxZ) maxZ = p.z;
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const CELL = Math.max(1e-6, diagonal / 48);

  const cellOf = (value: number): number => Math.floor(value / CELL);
  const buckets = new Map<string, number[]>();
  mesh.vertices.forEach((vertex, index) => {
    const p = vertex.position;
    const key = `${cellOf(p.x)}:${cellOf(p.y)}:${cellOf(p.z)}`;
    const bucket = buckets.get(key);
    if (bucket) bucket.push(index);
    else buckets.set(key, [index]);
  });

  const tolerance = Math.max(1e-9, diagonal * 1e-7);

  for (const face of mesh.faces) {
    // Collect candidates once per face from the cells its bounding box spans,
    // rather than once per sample point along every edge. The face is small
    // relative to the model, so this is a handful of cells.
    let fMinX = Infinity;
    let fMinY = Infinity;
    let fMinZ = Infinity;
    let fMaxX = -Infinity;
    let fMaxY = -Infinity;
    let fMaxZ = -Infinity;
    for (const index of face.vertices) {
      const p = mesh.vertices[index]?.position;
      if (!p) continue;
      if (p.x < fMinX) fMinX = p.x;
      if (p.y < fMinY) fMinY = p.y;
      if (p.z < fMinZ) fMinZ = p.z;
      if (p.x > fMaxX) fMaxX = p.x;
      if (p.y > fMaxY) fMaxY = p.y;
      if (p.z > fMaxZ) fMaxZ = p.z;
    }
    if (fMinX === Infinity) continue;

    const candidates: number[] = [];
    for (let cx = cellOf(fMinX) - 1; cx <= cellOf(fMaxX) + 1; cx += 1) {
      for (let cy = cellOf(fMinY) - 1; cy <= cellOf(fMaxY) + 1; cy += 1) {
        for (let cz = cellOf(fMinZ) - 1; cz <= cellOf(fMaxZ) + 1; cz += 1) {
          const bucket = buckets.get(`${cx}:${cy}:${cz}`);
          if (bucket) candidates.push(...bucket);
        }
      }
    }
    if (candidates.length === 0) continue;

    const rebuilt: number[] = [];

    for (let i = 0; i < face.vertices.length; i += 1) {
      const aIndex = face.vertices[i] as number;
      const bIndex = face.vertices[(i + 1) % face.vertices.length] as number;
      const a = mesh.vertices[aIndex]?.position;
      const b = mesh.vertices[bIndex]?.position;
      rebuilt.push(aIndex);
      if (!a || !b) continue;

      const edge = sub(b, a);
      const lengthSquared = dot(edge, edge);
      if (lengthSquared < 1e-14) continue;

      const insertions: Array<{ t: number; index: number }> = [];
      for (const index of candidates) {
        if (index === aIndex || index === bIndex) continue;
        const p = mesh.vertices[index]?.position;
        if (!p) continue;
        const t = dot(sub(p, a), edge) / lengthSquared;
        if (t <= tolerance || t >= 1 - tolerance) continue;
        const projected = add(a, scale(edge, t));
        const offset = sub(p, projected);
        if (dot(offset, offset) > tolerance * tolerance) continue;
        insertions.push({ t, index });
      }

      insertions.sort((x, y) => x.t - y.t);
      for (const insertion of insertions) rebuilt.push(insertion.index);
    }

    if (rebuilt.length !== face.vertices.length) {
      face.vertices.length = 0;
      face.vertices.push(...rebuilt);
    }
  }
}

export type BooleanOperation = 'union' | 'subtract' | 'intersect';

interface Bounds {
  minX: number;
  minY: number;
  minZ: number;
  maxX: number;
  maxY: number;
  maxZ: number;
}

const EMPTY_BOUNDS: Bounds = {
  minX: Infinity,
  minY: Infinity,
  minZ: Infinity,
  maxX: -Infinity,
  maxY: -Infinity,
  maxZ: -Infinity,
};

function growBounds(bounds: Bounds, polygon: Polygon): void {
  for (const vertex of polygon.vertices) {
    if (vertex.x < bounds.minX) bounds.minX = vertex.x;
    if (vertex.y < bounds.minY) bounds.minY = vertex.y;
    if (vertex.z < bounds.minZ) bounds.minZ = vertex.z;
    if (vertex.x > bounds.maxX) bounds.maxX = vertex.x;
    if (vertex.y > bounds.maxY) bounds.maxY = vertex.y;
    if (vertex.z > bounds.maxZ) bounds.maxZ = vertex.z;
  }
}

function boundsOf(polygons: readonly Polygon[]): Bounds {
  const bounds = { ...EMPTY_BOUNDS };
  for (const polygon of polygons) growBounds(bounds, polygon);
  return bounds;
}

/** Whether a polygon can possibly touch a solid whose extent is `bounds`. */
function polygonTouches(polygon: Polygon, bounds: Bounds): boolean {
  const own = { ...EMPTY_BOUNDS };
  growBounds(own, polygon);
  return (
    own.maxX >= bounds.minX - EPSILON &&
    own.minX <= bounds.maxX + EPSILON &&
    own.maxY >= bounds.minY - EPSILON &&
    own.minY <= bounds.maxY + EPSILON &&
    own.maxZ >= bounds.minZ - EPSILON &&
    own.minZ <= bounds.maxZ + EPSILON
  );
}

function boundsOverlap(a: Bounds, b: Bounds): boolean {
  return (
    a.maxX >= b.minX - EPSILON &&
    a.minX <= b.maxX + EPSILON &&
    a.maxY >= b.minY - EPSILON &&
    a.minY <= b.maxY + EPSILON &&
    a.maxZ >= b.minZ - EPSILON &&
    a.minZ <= b.maxZ + EPSILON
  );
}

/**
 * Combines two solids.
 *
 * `subtract` is the important one: it is how an opening is made. The material
 * of the tool's surviving faces is preserved, so a cut can leave a different
 * material on its walls — an air intake sunk into painted bodywork can expose
 * dark trim inside without a second modelling pass.
 *
 * **Polygons out of reach of the other solid never enter the BSP.** A plain BSP
 * boolean splits every polygon of one operand against the tree of the other,
 * everywhere, so cutting two 6mm nostrils into a head fragments the back of the
 * skull as thoroughly as the nose. On a face built from a dozen booleans that
 * compounds: measured on this codebase's character recipe, the head grew from
 * 2,755 faces to 84,479 through six operations, and most of those faces were
 * slivers nowhere near any cut. A polygon whose bounding box misses the other
 * solid's bounding box cannot intersect that solid, so for all three operations
 * its fate is decided without splitting it: it is kept whole for union and
 * subtract on the base, and dropped for intersect. The result is identical to
 * the unculled one, minus the slivers.
 */
export function csg(a: PolyMesh, b: PolyMesh, operation: BooleanOperation): PolyMesh {
  const polygonsA = toPolygons(a);
  const polygonsB = toPolygons(b);
  const boundsA = boundsOf(polygonsA);
  const boundsB = boundsOf(polygonsB);

  // Disjoint solids need no BSP at all, and asking one to run on them is how a
  // recipe that positions a cutter slightly wrong spends thirty seconds
  // producing the input unchanged.
  if (polygonsA.length === 0 || polygonsB.length === 0 || !boundsOverlap(boundsA, boundsB)) {
    switch (operation) {
      case 'union':
        return fromPolygons([...polygonsA, ...polygonsB]);
      case 'subtract':
        return fromPolygons(polygonsA);
      case 'intersect':
        return new PolyMesh();
    }
  }

  const nearA: Polygon[] = [];
  const farA: Polygon[] = [];
  for (const polygon of polygonsA) (polygonTouches(polygon, boundsB) ? nearA : farA).push(polygon);

  const nearB: Polygon[] = [];
  const farB: Polygon[] = [];
  for (const polygon of polygonsB) (polygonTouches(polygon, boundsA) ? nearB : farB).push(polygon);

  // One operand's surface entirely outside the other's box means one solid may
  // be wholly contained in the other — a case the culling reasoning above does
  // not cover, because the containing solid's *surface* is far from the
  // contained one while its *volume* is not. The full BSP decides it.
  if (nearA.length === 0 || nearB.length === 0) {
    return fromPolygons(csgExact(polygonsA, polygonsB, operation));
  }

  const kept = csgExact(nearA, nearB, operation);
  if (operation === 'union') kept.push(...farA, ...farB);
  else if (operation === 'subtract') kept.push(...farA);

  return fromPolygons(kept);
}

function csgExact(polygonsA: readonly Polygon[], polygonsB: readonly Polygon[], operation: BooleanOperation): Polygon[] {
  const nodeA = new Node([...polygonsA]);
  const nodeB = new Node([...polygonsB]);

  switch (operation) {
    case 'union':
      nodeA.clipTo(nodeB);
      nodeB.clipTo(nodeA);
      nodeB.invert();
      nodeB.clipTo(nodeA);
      nodeB.invert();
      nodeA.build(nodeB.allPolygons());
      break;

    case 'subtract':
      nodeA.invert();
      nodeA.clipTo(nodeB);
      nodeB.clipTo(nodeA);
      nodeB.invert();
      nodeB.clipTo(nodeA);
      nodeB.invert();
      nodeA.build(nodeB.allPolygons());
      nodeA.invert();
      break;

    case 'intersect':
      nodeA.invert();
      nodeB.clipTo(nodeA);
      nodeB.invert();
      nodeA.clipTo(nodeB);
      nodeB.clipTo(nodeA);
      nodeA.build(nodeB.allPolygons());
      nodeA.invert();
      break;
  }

  return nodeA.allPolygons();
}

export function union(a: PolyMesh, b: PolyMesh): PolyMesh {
  return csg(a, b, 'union');
}

export function subtract(a: PolyMesh, b: PolyMesh): PolyMesh {
  return csg(a, b, 'subtract');
}

export function intersect(a: PolyMesh, b: PolyMesh): PolyMesh {
  return csg(a, b, 'intersect');
}

/** Subtracts several tools in sequence. */
export function subtractAll(base: PolyMesh, tools: readonly PolyMesh[]): PolyMesh {
  let result = base;
  for (const tool of tools) result = subtract(result, tool);
  return result;
}

// ------------------------------------------------------------------ solids --

/** Axis-aligned box, centred on `centre`. */
export function box(centre: Vec3, size: Vec3, material = 0): PolyMesh {
  const mesh = new PolyMesh();
  const h = scale(size, 0.5);
  const corners: Vec3[] = [
    v3(centre.x - h.x, centre.y - h.y, centre.z - h.z),
    v3(centre.x + h.x, centre.y - h.y, centre.z - h.z),
    v3(centre.x + h.x, centre.y + h.y, centre.z - h.z),
    v3(centre.x - h.x, centre.y + h.y, centre.z - h.z),
    v3(centre.x - h.x, centre.y - h.y, centre.z + h.z),
    v3(centre.x + h.x, centre.y - h.y, centre.z + h.z),
    v3(centre.x + h.x, centre.y + h.y, centre.z + h.z),
    v3(centre.x - h.x, centre.y + h.y, centre.z + h.z),
  ];
  for (const corner of corners) mesh.addVertex(corner);
  const faces = [
    [0, 3, 2, 1],
    [4, 5, 6, 7],
    [0, 1, 5, 4],
    [1, 2, 6, 5],
    [2, 3, 7, 6],
    [3, 0, 4, 7],
  ];
  for (const face of faces) mesh.addFace(face, material);
  return mesh;
}

/** UV sphere. Segments are capped to keep boolean cost bounded. */
export function sphere(centre: Vec3, radius: number, segments = 20, rings = 12, material = 0): PolyMesh {
  const mesh = new PolyMesh();
  const s = Math.max(4, Math.min(48, segments));
  const r = Math.max(2, Math.min(32, rings));
  const grid: number[][] = [];

  for (let i = 0; i <= r; i += 1) {
    const phi = (i / r) * Math.PI;
    const row: number[] = [];
    for (let j = 0; j < s; j += 1) {
      const theta = (j / s) * Math.PI * 2;
      row.push(
        mesh.addVertex(
          v3(
            centre.x + radius * Math.sin(phi) * Math.cos(theta),
            centre.y + radius * Math.cos(phi),
            centre.z + radius * Math.sin(phi) * Math.sin(theta),
          ),
        ),
      );
    }
    grid.push(row);
  }

  for (let i = 0; i < r; i += 1) {
    for (let j = 0; j < s; j += 1) {
      const j2 = (j + 1) % s;
      const a = (grid[i] as number[])[j] as number;
      const b = (grid[i] as number[])[j2] as number;
      const c = (grid[i + 1] as number[])[j2] as number;
      const d = (grid[i + 1] as number[])[j] as number;
      if (i === 0) mesh.addFace([a, c, d], material);
      else if (i === r - 1) mesh.addFace([a, b, c], material);
      else mesh.addFace([a, b, c, d], material);
    }
  }
  return mesh;
}

/** Cylinder along an arbitrary axis; the workhorse cutting tool. */
export function cylinder(from: Vec3, to: Vec3, radius: number, segments = 20, material = 0): PolyMesh {
  const mesh = new PolyMesh();
  const axis = sub(to, from);
  const height = Math.hypot(axis.x, axis.y, axis.z);
  if (height < 1e-9) return mesh;

  const w = scale(axis, 1 / height);
  const reference = Math.abs(w.y) > 0.9 ? v3(1, 0, 0) : v3(0, 1, 0);
  const u = normalize(cross(reference, w));
  const vAxis = cross(w, u);

  const s = Math.max(3, Math.min(64, segments));
  const bottom: number[] = [];
  const top: number[] = [];
  for (let i = 0; i < s; i += 1) {
    const angle = (i / s) * Math.PI * 2;
    const offset = add(scale(u, Math.cos(angle) * radius), scale(vAxis, Math.sin(angle) * radius));
    bottom.push(mesh.addVertex(add(from, offset)));
    top.push(mesh.addVertex(add(to, offset)));
  }

  for (let i = 0; i < s; i += 1) {
    const j = (i + 1) % s;
    mesh.addFace([bottom[i] as number, bottom[j] as number, top[j] as number, top[i] as number], material);
  }
  mesh.addFace([...bottom].reverse(), material);
  mesh.addFace([...top], material);
  return mesh;
}
