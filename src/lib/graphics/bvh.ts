import type { Vec3 } from './mesh-kernel';

/**
 * A bounding volume hierarchy over triangles.
 *
 * Everything that makes generated geometry look like geometry rather than like
 * plastic needs to ask a question about the *rest* of the model: how enclosed is
 * this point, does this crevice see the sky, is this face hidden behind another
 * one. Answering that means tracing rays, and tracing rays against a hundred
 * thousand triangles one at a time is not a thing that can happen inside a build.
 *
 * The tree is built by binned surface-area heuristic. The SAH is worth the build
 * cost here because the trees are built once and then queried millions of times:
 * a median split on a model with one dense region and a lot of empty space — a
 * character's face against its legs, say — produces nodes that overlap badly and
 * doubles the traversal cost of every ray afterwards.
 *
 * Queries are any-hit rather than closest-hit. Occlusion only asks *whether*
 * something was in the way, so traversal stops at the first intersection instead
 * of sorting to find the nearest, which is roughly twice as fast on the rays
 * that hit.
 */

const BINS = 12;
const LEAF_SIZE = 4;
const EPSILON = 1e-9;

interface Node {
  /** Bounds as [minX, minY, minZ, maxX, maxY, maxZ]. */
  readonly bounds: Float64Array;
  /** Interior nodes: index of the right child; the left child is this + 1. */
  right: number;
  /** Leaves: first triangle and count. `count` is 0 for interior nodes. */
  start: number;
  count: number;
}

function emptyBounds(): Float64Array {
  return Float64Array.from([Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity]);
}

function growPoint(bounds: Float64Array, x: number, y: number, z: number): void {
  if (x < (bounds[0] as number)) bounds[0] = x;
  if (y < (bounds[1] as number)) bounds[1] = y;
  if (z < (bounds[2] as number)) bounds[2] = z;
  if (x > (bounds[3] as number)) bounds[3] = x;
  if (y > (bounds[4] as number)) bounds[4] = y;
  if (z > (bounds[5] as number)) bounds[5] = z;
}

function growBounds(into: Float64Array, other: Float64Array): void {
  for (let axis = 0; axis < 3; axis += 1) {
    if ((other[axis] as number) < (into[axis] as number)) into[axis] = other[axis] as number;
    if ((other[axis + 3] as number) > (into[axis + 3] as number)) into[axis + 3] = other[axis + 3] as number;
  }
}

function surfaceArea(bounds: Float64Array): number {
  const dx = (bounds[3] as number) - (bounds[0] as number);
  const dy = (bounds[4] as number) - (bounds[1] as number);
  const dz = (bounds[5] as number) - (bounds[2] as number);
  if (dx < 0 || dy < 0 || dz < 0) return 0;
  return 2 * (dx * dy + dy * dz + dz * dx);
}

export interface BvhStats {
  readonly triangles: number;
  readonly nodes: number;
  readonly maxDepth: number;
  readonly buildMs: number;
}

export class Bvh {
  private readonly nodes: Node[] = [];
  /** Triangle indices, permuted so every leaf owns a contiguous run. */
  private readonly order: Uint32Array;
  private readonly centroids: Float64Array;
  private readonly triBounds: Float64Array;
  readonly stats: BvhStats;

  /**
   * @param positions Flat xyz triples.
   * @param indices   Triangle corner indices into `positions`.
   */
  constructor(
    private readonly positions: Float32Array | Float64Array | number[],
    private readonly indices: Uint32Array | number[],
  ) {
    const started = Date.now();
    const count = Math.floor(indices.length / 3);
    this.order = new Uint32Array(count);
    this.centroids = new Float64Array(count * 3);
    this.triBounds = new Float64Array(count * 6);

    for (let i = 0; i < count; i += 1) {
      this.order[i] = i;
      const bounds = emptyBounds();
      for (let corner = 0; corner < 3; corner += 1) {
        const base = (indices[i * 3 + corner] as number) * 3;
        growPoint(bounds, positions[base] as number, positions[base + 1] as number, positions[base + 2] as number);
      }
      this.triBounds.set(bounds, i * 6);
      this.centroids[i * 3] = ((bounds[0] as number) + (bounds[3] as number)) / 2;
      this.centroids[i * 3 + 1] = ((bounds[1] as number) + (bounds[4] as number)) / 2;
      this.centroids[i * 3 + 2] = ((bounds[2] as number) + (bounds[5] as number)) / 2;
    }

    let maxDepth = 0;
    if (count > 0) {
      maxDepth = this.build(0, count, 0);
    }
    this.stats = {
      triangles: count,
      nodes: this.nodes.length,
      maxDepth,
      buildMs: Date.now() - started,
    };
  }

  /** Builds the node covering `order[start, start+count)`. Returns its depth. */
  private build(start: number, count: number, depth: number): number {
    const bounds = emptyBounds();
    for (let i = start; i < start + count; i += 1) {
      const triangle = this.order[i] as number;
      growBounds(bounds, this.triBounds.subarray(triangle * 6, triangle * 6 + 6) as Float64Array);
    }

    const self = this.nodes.length;
    this.nodes.push({ bounds, right: -1, start, count });
    if (count <= LEAF_SIZE) return depth;

    const split = this.chooseSplit(start, count, bounds);
    if (!split) return depth;

    const middle = this.partition(start, count, split.axis, split.position);
    // A split that puts everything on one side is no split at all; a median
    // fallback guarantees progress rather than recursing forever.
    const left = middle === start || middle === start + count ? start + (count >> 1) : middle;

    const node = this.nodes[self] as Node;
    node.count = 0;
    const leftDepth = this.build(start, left - start, depth + 1);
    node.right = this.nodes.length;
    const rightDepth = this.build(left, start + count - left, depth + 1);
    return Math.max(leftDepth, rightDepth);
  }

  /** Binned SAH over the widest axis of the centroid bounds. */
  private chooseSplit(start: number, count: number, bounds: Float64Array): { axis: number; position: number } | null {
    const centroidBounds = emptyBounds();
    for (let i = start; i < start + count; i += 1) {
      const triangle = this.order[i] as number;
      growPoint(
        centroidBounds,
        this.centroids[triangle * 3] as number,
        this.centroids[triangle * 3 + 1] as number,
        this.centroids[triangle * 3 + 2] as number,
      );
    }

    let axis = 0;
    let extent = 0;
    for (let candidate = 0; candidate < 3; candidate += 1) {
      const span = (centroidBounds[candidate + 3] as number) - (centroidBounds[candidate] as number);
      if (span > extent) {
        extent = span;
        axis = candidate;
      }
    }
    if (extent < EPSILON) return null;

    const low = centroidBounds[axis] as number;
    const scale = BINS / extent;
    const binBounds: Float64Array[] = [];
    const binCounts = new Uint32Array(BINS);
    for (let bin = 0; bin < BINS; bin += 1) binBounds.push(emptyBounds());

    for (let i = start; i < start + count; i += 1) {
      const triangle = this.order[i] as number;
      const bin = Math.min(BINS - 1, Math.floor(((this.centroids[triangle * 3 + axis] as number) - low) * scale));
      binCounts[bin] = (binCounts[bin] as number) + 1;
      growBounds(binBounds[bin] as Float64Array, this.triBounds.subarray(triangle * 6, triangle * 6 + 6) as Float64Array);
    }

    // Sweep once from each side so every candidate plane knows the cost of both
    // halves without re-accumulating bounds per plane.
    const leftArea = new Float64Array(BINS);
    const leftCount = new Uint32Array(BINS);
    const running = emptyBounds();
    let accumulated = 0;
    for (let bin = 0; bin < BINS; bin += 1) {
      growBounds(running, binBounds[bin] as Float64Array);
      accumulated += binCounts[bin] as number;
      leftArea[bin] = surfaceArea(running);
      leftCount[bin] = accumulated;
    }

    const rightRunning = emptyBounds();
    let rightAccumulated = 0;
    let bestCost = Infinity;
    let bestBin = -1;
    for (let bin = BINS - 1; bin > 0; bin -= 1) {
      growBounds(rightRunning, binBounds[bin] as Float64Array);
      rightAccumulated += binCounts[bin] as number;
      const cost =
        (leftArea[bin - 1] as number) * (leftCount[bin - 1] as number) +
        surfaceArea(rightRunning) * rightAccumulated;
      if (cost < bestCost && (leftCount[bin - 1] as number) > 0 && rightAccumulated > 0) {
        bestCost = cost;
        bestBin = bin;
      }
    }
    if (bestBin < 0) return null;

    // A split has to beat leaving the node whole, or the tree grows without
    // making traversal cheaper.
    const leafCost = surfaceArea(bounds) * count;
    if (bestCost >= leafCost) return null;

    return { axis, position: low + (bestBin / BINS) * extent };
  }

  /** Hoare partition of the index run; returns the first index of the right half. */
  private partition(start: number, count: number, axis: number, position: number): number {
    let left = start;
    let right = start + count - 1;
    while (left <= right) {
      const triangle = this.order[left] as number;
      if ((this.centroids[triangle * 3 + axis] as number) < position) {
        left += 1;
      } else {
        const swap = this.order[right] as number;
        this.order[right] = triangle;
        this.order[left] = swap;
        right -= 1;
      }
    }
    return left;
  }

  /**
   * Whether anything blocks the segment from `origin` along `direction` within
   * `maxDistance`. Any-hit: it stops at the first intersection.
   */
  occluded(origin: Vec3, direction: Vec3, maxDistance: number): boolean {
    if (this.nodes.length === 0) return false;

    const inverse = [
      1 / (direction.x === 0 ? EPSILON : direction.x),
      1 / (direction.y === 0 ? EPSILON : direction.y),
      1 / (direction.z === 0 ? EPSILON : direction.z),
    ];
    const from = [origin.x, origin.y, origin.z];

    // An explicit stack: recursion here costs more than the traversal it does.
    const stack: number[] = [0];
    while (stack.length > 0) {
      const index = stack.pop() as number;
      const node = this.nodes[index] as Node;
      if (!hitsBounds(node.bounds, from, inverse, maxDistance)) continue;

      if (node.count === 0) {
        stack.push(node.right, index + 1);
        continue;
      }
      for (let i = node.start; i < node.start + node.count; i += 1) {
        const triangle = this.order[i] as number;
        const distance = this.intersect(triangle, origin, direction);
        if (distance !== null && distance > 1e-6 && distance < maxDistance) return true;
      }
    }
    return false;
  }

  /** Möller–Trumbore. Returns the distance along the ray, or null. */
  private intersect(triangle: number, origin: Vec3, direction: Vec3): number | null {
    const ia = (this.indices[triangle * 3] as number) * 3;
    const ib = (this.indices[triangle * 3 + 1] as number) * 3;
    const ic = (this.indices[triangle * 3 + 2] as number) * 3;
    const p = this.positions;

    const ax = p[ia] as number;
    const ay = p[ia + 1] as number;
    const az = p[ia + 2] as number;
    const e1x = (p[ib] as number) - ax;
    const e1y = (p[ib + 1] as number) - ay;
    const e1z = (p[ib + 2] as number) - az;
    const e2x = (p[ic] as number) - ax;
    const e2y = (p[ic + 1] as number) - ay;
    const e2z = (p[ic + 2] as number) - az;

    const px = direction.y * e2z - direction.z * e2y;
    const py = direction.z * e2x - direction.x * e2z;
    const pz = direction.x * e2y - direction.y * e2x;
    const determinant = e1x * px + e1y * py + e1z * pz;
    if (Math.abs(determinant) < 1e-12) return null;

    const inverse = 1 / determinant;
    const tx = origin.x - ax;
    const ty = origin.y - ay;
    const tz = origin.z - az;
    const u = (tx * px + ty * py + tz * pz) * inverse;
    if (u < -1e-7 || u > 1 + 1e-7) return null;

    const qx = ty * e1z - tz * e1y;
    const qy = tz * e1x - tx * e1z;
    const qz = tx * e1y - ty * e1x;
    const v = (direction.x * qx + direction.y * qy + direction.z * qz) * inverse;
    if (v < -1e-7 || u + v > 1 + 1e-7) return null;

    return (e2x * qx + e2y * qy + e2z * qz) * inverse;
  }
}

/** Slab test. `inverse` is the reciprocal of the ray direction, per axis. */
function hitsBounds(bounds: Float64Array, origin: number[], inverse: number[], maxDistance: number): boolean {
  let near = 0;
  let far = maxDistance;
  for (let axis = 0; axis < 3; axis += 1) {
    const reciprocal = inverse[axis] as number;
    let t0 = ((bounds[axis] as number) - (origin[axis] as number)) * reciprocal;
    let t1 = ((bounds[axis + 3] as number) - (origin[axis] as number)) * reciprocal;
    if (t0 > t1) {
      const swap = t0;
      t0 = t1;
      t1 = swap;
    }
    if (t0 > near) near = t0;
    if (t1 < far) far = t1;
    if (near > far) return false;
  }
  return true;
}
