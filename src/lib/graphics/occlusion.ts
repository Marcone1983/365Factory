import { Bvh } from './bvh';
import { v3, type Vec3 } from './mesh-kernel';

/**
 * Baked ambient occlusion.
 *
 * This is the single largest difference between generated geometry that reads
 * as an object and generated geometry that reads as plastic. Without it every
 * surface receives the same ambient light regardless of how enclosed it is, so
 * nothing darkens where two forms meet: no shadow under a chin, none in an eye
 * socket, none between fingers, none up inside a wheel arch. The shape is
 * correct and the eye still refuses it, because contact shadow is most of how
 * we read that two surfaces are touching.
 *
 * It is computed by tracing rays, not approximated from curvature. Curvature
 * says how a surface bends locally and knows nothing about what is next to it,
 * which means it darkens a concave sweep that is wide open to the sky and misses
 * the gap between two parallel flat panels a millimetre apart. Occlusion is a
 * question about the whole model and only rays answer it.
 *
 * The result is written to vertex colours, which glTF multiplies into the base
 * colour. That costs three floats per vertex and needs no second UV set, no
 * lightmap atlas and no unwrap — and an unwrap is exactly the step that would
 * have to be right for a baked AO *texture* to be worth having.
 */

export interface OcclusionOptions {
  /**
   * Rays per vertex. Cosine-weighted and stratified, so the error falls roughly
   * as 1/sqrt(n): 64 is visibly clean after the smoothing pass, 16 is blotchy.
   */
  readonly samples?: number;
  /**
   * How far a ray looks, in metres. Occlusion is a local effect — beyond about a
   * tenth of the model it stops describing contact and starts describing the
   * silhouette, which the lighting already handles. Defaults to a twelfth of the
   * bounding diagonal.
   */
  readonly radius?: number;
  /** 0 leaves the model unshaded; 1 is the full computed range. */
  readonly intensity?: number;
  /** Never darker than this, so a crevice reads as dark rather than as a hole. */
  readonly floor?: number;
  /**
   * Contrast on the result. Above 1 deepens partial contact without touching
   * fully open surfaces, which is what the eye reads as a crease. The raw
   * estimate is physically right and perceptually flat: a fold that blocks half
   * the hemisphere returns 0.5 and, after tone mapping, is nearly invisible.
   */
  readonly contrast?: number;
  /** Smoothing passes over the vertex graph. Each one costs almost nothing. */
  readonly smoothPasses?: number;
}

export interface OcclusionResult {
  /** Per input vertex, 1 = fully open, 0 = fully enclosed. */
  readonly occlusion: Float32Array;
  readonly stats: {
    readonly vertices: number;
    readonly uniquePositions: number;
    readonly rays: number;
    readonly radius: number;
    readonly durationMs: number;
  };
}

/**
 * A deterministic low-discrepancy pair. Hammersley over a fixed sample count
 * gives an even hemisphere without the clumping that independent random numbers
 * produce at these sample counts — clumping is what shows up as blotches.
 */
function hammersley(index: number, count: number): [number, number] {
  let bits = index;
  bits = (bits << 16) | (bits >>> 16);
  bits = ((bits & 0x55555555) << 1) | ((bits & 0xaaaaaaaa) >>> 1);
  bits = ((bits & 0x33333333) << 2) | ((bits & 0xcccccccc) >>> 2);
  bits = ((bits & 0x0f0f0f0f) << 4) | ((bits & 0xf0f0f0f0) >>> 4);
  bits = ((bits & 0x00ff00ff) << 8) | ((bits & 0xff00ff00) >>> 8);
  return [index / count, (bits >>> 0) * 2.3283064365386963e-10];
}

/** An orthonormal basis around `normal`, without a branch-induced seam. */
function basis(normal: Vec3): { tangent: Vec3; bitangent: Vec3 } {
  // Duff et al: numerically stable for every direction including the poles,
  // where the naive "cross with up unless it is up" construction degenerates.
  const sign = normal.z >= 0 ? 1 : -1;
  const a = -1 / (sign + normal.z);
  const b = normal.x * normal.y * a;
  return {
    tangent: v3(1 + sign * normal.x * normal.x * a, sign * b, -sign * normal.x),
    bitangent: v3(b, sign + normal.y * normal.y * a, -normal.y),
  };
}

export function bakeVertexOcclusion(
  positions: Float32Array | number[],
  normals: Float32Array | number[],
  indices: Uint32Array | number[],
  options: OcclusionOptions = {},
): OcclusionResult {
  const started = Date.now();
  const vertexCount = Math.floor(positions.length / 3);
  const samples = Math.max(4, Math.min(512, options.samples ?? 64));
  const intensity = Math.max(0, Math.min(1, options.intensity ?? 1));
  const floor = Math.max(0, Math.min(1, options.floor ?? 0.1));
  const contrast = Math.max(0.25, Math.min(4, options.contrast ?? 1.45));
  const smoothPasses = Math.max(0, Math.min(6, options.smoothPasses ?? 2));

  const result = new Float32Array(vertexCount).fill(1);
  if (vertexCount === 0 || indices.length < 3) {
    return {
      occlusion: result,
      stats: { vertices: vertexCount, uniquePositions: 0, rays: 0, radius: 0, durationMs: 0 },
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3] as number;
    const y = positions[i * 3 + 1] as number;
    const z = positions[i * 3 + 2] as number;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (z < minZ) minZ = z;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    if (z > maxZ) maxZ = z;
  }
  const diagonal = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ);
  const radius = options.radius ?? Math.max(1e-4, diagonal / 12);
  const bias = Math.max(1e-6, diagonal * 2e-4);

  // Vertices are welded by position before tracing. A mesh triangulated with
  // hard edges carries the same point several times with different normals, and
  // shading each copy separately both triples the work and puts a visible seam
  // in the occlusion along every crease — where there is no shadow edge in
  // reality, only a shading one.
  const cell = Math.max(1e-7, diagonal * 1e-5);
  const keyed = new Map<string, number>();
  const owner = new Int32Array(vertexCount);
  const uniquePositions: number[] = [];
  const accumulatedNormals: number[] = [];

  for (let i = 0; i < vertexCount; i += 1) {
    const x = positions[i * 3] as number;
    const y = positions[i * 3 + 1] as number;
    const z = positions[i * 3 + 2] as number;
    const key = `${Math.round(x / cell)}:${Math.round(y / cell)}:${Math.round(z / cell)}`;
    let index = keyed.get(key);
    if (index === undefined) {
      index = uniquePositions.length / 3;
      keyed.set(key, index);
      uniquePositions.push(x, y, z);
      accumulatedNormals.push(0, 0, 0);
    }
    owner[i] = index;
    accumulatedNormals[index * 3] = (accumulatedNormals[index * 3] as number) + (normals[i * 3] as number);
    accumulatedNormals[index * 3 + 1] = (accumulatedNormals[index * 3 + 1] as number) + (normals[i * 3 + 1] as number);
    accumulatedNormals[index * 3 + 2] = (accumulatedNormals[index * 3 + 2] as number) + (normals[i * 3 + 2] as number);
  }

  const uniqueCount = uniquePositions.length / 3;
  const bvh = new Bvh(positions, indices);
  const open = new Float32Array(uniqueCount);

  for (let index = 0; index < uniqueCount; index += 1) {
    let nx = accumulatedNormals[index * 3] as number;
    let ny = accumulatedNormals[index * 3 + 1] as number;
    let nz = accumulatedNormals[index * 3 + 2] as number;
    const length = Math.hypot(nx, ny, nz);
    if (length < 1e-9) {
      open[index] = 1;
      continue;
    }
    nx /= length;
    ny /= length;
    nz /= length;
    const normal = v3(nx, ny, nz);
    const { tangent, bitangent } = basis(normal);

    const origin = v3(
      (uniquePositions[index * 3] as number) + nx * bias,
      (uniquePositions[index * 3 + 1] as number) + ny * bias,
      (uniquePositions[index * 3 + 2] as number) + nz * bias,
    );

    // The sample set is rotated per vertex. Without it every vertex traces the
    // same directions and the error correlates into visible banding instead of
    // averaging out between neighbours.
    const rotation = ((index * 2654435761) >>> 0) / 4294967296;
    let blocked = 0;

    for (let sample = 0; sample < samples; sample += 1) {
      const [u, vRaw] = hammersley(sample, samples);
      const v = (vRaw + rotation) % 1;
      // Cosine-weighted: the distribution already carries the N·L term, so the
      // estimate is the plain hit fraction rather than a weighted sum.
      const r = Math.sqrt(u);
      const phi = 2 * Math.PI * v;
      const x = r * Math.cos(phi);
      const y = r * Math.sin(phi);
      const z = Math.sqrt(Math.max(0, 1 - u));

      const direction = v3(
        tangent.x * x + bitangent.x * y + nx * z,
        tangent.y * x + bitangent.y * y + ny * z,
        tangent.z * x + bitangent.z * y + nz * z,
      );
      if (bvh.occluded(origin, direction, radius)) blocked += 1;
    }

    open[index] = 1 - blocked / samples;
  }

  // Smoothing over the triangle graph. The estimate is unbiased but noisy at 64
  // samples, and noise on a vertex colour reads as dirt; neighbours on a surface
  // genuinely do have near-identical occlusion, so averaging costs no real
  // detail.
  if (smoothPasses > 0) {
    const neighbours: number[][] = Array.from({ length: uniqueCount }, () => []);
    for (let i = 0; i + 2 < indices.length; i += 3) {
      const a = owner[indices[i] as number] as number;
      const b = owner[indices[i + 1] as number] as number;
      const c = owner[indices[i + 2] as number] as number;
      (neighbours[a] as number[]).push(b, c);
      (neighbours[b] as number[]).push(a, c);
      (neighbours[c] as number[]).push(a, b);
    }
    let current = open;
    for (let pass = 0; pass < smoothPasses; pass += 1) {
      const next = new Float32Array(uniqueCount);
      for (let index = 0; index < uniqueCount; index += 1) {
        const adjacent = neighbours[index] as number[];
        if (adjacent.length === 0) {
          next[index] = current[index] as number;
          continue;
        }
        let total = (current[index] as number) * 2;
        let weight = 2;
        for (const other of adjacent) {
          total += current[other] as number;
          weight += 1;
        }
        next[index] = total / weight;
      }
      current = next;
    }
    open.set(current);
  }

  for (let i = 0; i < vertexCount; i += 1) {
    const value = Math.pow(Math.max(0, open[owner[i] as number] as number), contrast);
    result[i] = floor + (1 - floor) * (1 - intensity * (1 - value));
  }

  return {
    occlusion: result,
    stats: {
      vertices: vertexCount,
      uniquePositions: uniqueCount,
      rays: uniqueCount * samples,
      radius,
      durationMs: Date.now() - started,
    },
  };
}

/** Expands per-vertex occlusion into the RGBA vertex colours glTF multiplies in. */
export function occlusionToVertexColors(occlusion: Float32Array): Float32Array {
  const colors = new Float32Array(occlusion.length * 4);
  for (let i = 0; i < occlusion.length; i += 1) {
    const value = occlusion[i] as number;
    colors[i * 4] = value;
    colors[i * 4 + 1] = value;
    colors[i * 4 + 2] = value;
    colors[i * 4 + 3] = 1;
  }
  return colors;
}
