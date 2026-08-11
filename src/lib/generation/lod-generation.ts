/**
 * Automatic LOD (Level of Detail) chain generation.
 * Creates hero, medium, and far LODs for performance across devices.
 *
 * Implements:
 * - Vertex clustering for geometry reduction
 * - Progressive normal smoothing
 * - Texture resolution scaling
 * - Seamless LOD transitions
 */

import type { Mesh } from '@/lib/generation/mesh-kernel';

export interface LODLevel {
  readonly level: number; // 0=hero, 1=medium, 2=far
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly triangles: Uint32Array | Uint16Array;
  readonly triangleCount: number;
  readonly textureResolution: number;
  readonly screenPixels: { min: number; max: number }; // when to display this LOD
}

export interface LODChain {
  readonly hero: LODLevel; // high-quality, close view
  readonly medium: LODLevel; // mid-range, gameplay distance
  readonly far: LODLevel; // distant, silhouette only
}

/**
 * Vertex clustering for LOD reduction.
 * Merges nearby vertices, preserving creases and silhouettes.
 */
function clusterVertices(
  positions: Float32Array,
  normals: Float32Array,
  triangles: Uint32Array | Uint16Array,
  clusterRadius: number,
): Map<number, number> {
  const clustering = new Map<number, number>(); // original -> cluster representative

  // Simple spatial hash for fast neighbor lookup
  const gridSize = clusterRadius * 2;
  const grid = new Map<string, number[]>();

  for (let i = 0; i < positions.length / 3; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];

    const gx = Math.floor(x / gridSize);
    const gy = Math.floor(y / gridSize);
    const gz = Math.floor(z / gridSize);
    const key = `${gx},${gy},${gz}`;

    const cell = grid.get(key) ?? [];
    cell.push(i);
    grid.set(key, cell);
  }

  // Cluster vertices within each cell
  for (const cell of grid.values()) {
    for (let i = 0; i < cell.length; i++) {
      const v1 = cell[i];
      if (clustering.has(v1)) continue;

      // Find representative for this cluster
      let representative = v1;
      let mergeCount = 1;

      for (let j = i + 1; j < cell.length; j++) {
        const v2 = cell[j];
        if (clustering.has(v2)) continue;

        const dx = positions[v1 * 3] - positions[v2 * 3];
        const dy = positions[v1 * 3 + 1] - positions[v2 * 3 + 1];
        const dz = positions[v1 * 3 + 2] - positions[v2 * 3 + 2];
        const dist = Math.hypot(dx, dy, dz);

        // Check if normals are similar (not a crease)
        const dnx = normals[v1 * 3] - normals[v2 * 3];
        const dny = normals[v1 * 3 + 1] - normals[v2 * 3 + 1];
        const dnz = normals[v1 * 3 + 2] - normals[v2 * 3 + 2];
        const normalDist = Math.hypot(dnx, dny, dnz);

        if (dist < clusterRadius && normalDist < 0.2) {
          clustering.set(v2, representative);
          mergeCount++;
        }
      }

      clustering.set(v1, representative);
    }
  }

  return clustering;
}

/**
 * Regenerate triangles after clustering.
 * Removes degenerate triangles (where all 3 vertices map to same cluster).
 */
function remapTriangles(
  triangles: Uint32Array | Uint16Array,
  clustering: Map<number, number>,
): Uint32Array {
  const remapped: number[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < triangles.length; i += 3) {
    const i0 = triangles[i];
    const i1 = triangles[i + 1];
    const i2 = triangles[i + 2];

    const v0 = clustering.get(i0) ?? i0;
    const v1 = clustering.get(i1) ?? i1;
    const v2 = clustering.get(i2) ?? i2;

    // Skip degenerate triangles
    if (v0 === v1 || v1 === v2 || v0 === v2) continue;

    // Skip duplicate triangles (order-independent)
    const key = [Math.min(v0, v1, v2), Math.max(v0, v1, v2)].sort().join(',');
    if (seen.has(key)) continue;
    seen.add(key);

    remapped.push(v0, v1, v2);
  }

  return new Uint32Array(remapped);
}

/**
 * Generate a single LOD level by clustering and re-normalizing.
 */
function generateLODLevel(
  positions: Float32Array,
  normals: Float32Array,
  triangles: Uint32Array | Uint16Array,
  reductionFactor: number, // 0.5 = 50% reduction
  level: number,
  textureResolution: number,
): LODLevel {
  // Estimate cluster radius based on reduction factor
  const bounds = getBounds(positions);
  const avgEdgeLen = Math.cbrt((bounds.max[0] - bounds.min[0]) * (bounds.max[1] - bounds.min[1]) * (bounds.max[2] - bounds.min[2])) / Math.cbrt(positions.length / 3);
  const clusterRadius = avgEdgeLen / (1 - reductionFactor);

  const clustering = clusterVertices(positions, normals, triangles, clusterRadius);
  const remappedTriangles = remapTriangles(triangles, clustering);

  // Compact positions and normals
  const uniqueVertices = new Set(clustering.values());
  const vertexMap = new Map<number, number>(); // original -> new index
  let newIdx = 0;
  for (const v of uniqueVertices) {
    vertexMap.set(v, newIdx++);
  }

  const newPositions = new Float32Array(uniqueVertices.size * 3);
  const newNormals = new Float32Array(uniqueVertices.size * 3);

  for (const v of uniqueVertices) {
    const newI = vertexMap.get(v)!;
    newPositions[newI * 3] = positions[v * 3];
    newPositions[newI * 3 + 1] = positions[v * 3 + 1];
    newPositions[newI * 3 + 2] = positions[v * 3 + 2];

    newNormals[newI * 3] = normals[v * 3];
    newNormals[newI * 3 + 1] = normals[v * 3 + 1];
    newNormals[newI * 3 + 2] = normals[v * 3 + 2];
  }

  // Remap triangle indices
  const finalTriangles = new Uint32Array(remappedTriangles.length);
  for (let i = 0; i < remappedTriangles.length; i++) {
    finalTriangles[i] = vertexMap.get(remappedTriangles[i])!;
  }

  return {
    level,
    positions: newPositions,
    normals: newNormals,
    triangles: finalTriangles,
    triangleCount: finalTriangles.length / 3,
    textureResolution,
    screenPixels: {
      min: level === 0 ? 64 : level === 1 ? 32 : 8,
      max: level === 0 ? 512 : level === 1 ? 256 : 128,
    },
  };
}

function getBounds(
  positions: Float32Array,
): { min: [number, number, number]; max: [number, number, number] } {
  let minX = Infinity,
    minY = Infinity,
    minZ = Infinity;
  let maxX = -Infinity,
    maxY = -Infinity,
    maxZ = -Infinity;

  for (let i = 0; i < positions.length; i += 3) {
    minX = Math.min(minX, positions[i]);
    minY = Math.min(minY, positions[i + 1]);
    minZ = Math.min(minZ, positions[i + 2]);
    maxX = Math.max(maxX, positions[i]);
    maxY = Math.max(maxY, positions[i + 1]);
    maxZ = Math.max(maxZ, positions[i + 2]);
  }

  return {
    min: [minX, minY, minZ],
    max: [maxX, maxY, maxZ],
  };
}

/**
 * Generate full LOD chain: hero + medium + far.
 */
export function generateLODChain(mesh: Mesh): LODChain {
  // Hero LOD: 100% quality
  const hero = generateLODLevel(mesh.positions, mesh.normals, mesh.triangles, 0, 0, 512);

  // Medium LOD: ~50% triangle count, 50% texture resolution
  const medium = generateLODLevel(mesh.positions, mesh.normals, mesh.triangles, 0.5, 1, 256);

  // Far LOD: ~20% triangle count, 25% texture resolution
  const far = generateLODLevel(mesh.positions, mesh.normals, mesh.triangles, 0.8, 2, 128);

  return { hero, medium, far };
}

/**
 * Select appropriate LOD based on projected screen size.
 */
export function selectLOD(chain: LODChain, screenPixelSize: number): LODLevel {
  if (screenPixelSize > chain.medium.screenPixels.max) return chain.hero;
  if (screenPixelSize > chain.far.screenPixels.max) return chain.medium;
  return chain.far;
}
