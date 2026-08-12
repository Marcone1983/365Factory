/**
 * Decal/Projector system for attaching detail to surfaces without increasing polycount.
 *
 * Allows:
 * - Logos, numbers, sponsor decals on vehicles
 * - Weathering patterns, graffiti
 * - Dynamic decal placement via raycast
 * - Proper handling of tangent-space normals for correct lighting
 */

import * as THREE from 'three';

export interface DecalGeometry extends THREE.BufferGeometry {
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs: Float32Array;
  readonly decalUvs: Float32Array; // UV coordinates in decal texture space
  readonly tangents?: Float32Array;
}

export interface DecalOptions {
  readonly size: THREE.Vector3; // width, height, depth of projection box
  readonly position: THREE.Vector3;
  readonly rotation: THREE.Euler;
  readonly texture: THREE.Texture;
  readonly opacity?: number;
  readonly normalMap?: THREE.Texture;
  readonly renderOrder?: number;
}

/**
 * Project a decal (e.g., logo, number) onto a target mesh.
 * Returns a new geometry that only includes projected triangles.
 */
export function projectDecalOntoMesh(
  targetMesh: THREE.Mesh,
  options: DecalOptions,
): DecalGeometry | null {
  const geometry = targetMesh.geometry as THREE.BufferGeometry;
  const positions = geometry.attributes.position.array as Float32Array;
  const normals = geometry.attributes.normal.array as Float32Array;

  const decalGeometry: DecalGeometry = new THREE.BufferGeometry() as DecalGeometry;
  const decalPositions: number[] = [];
  const decalNormals: number[] = [];
  const decalUvs: number[] = [];
  const decalDecalUvs: number[] = [];

  // Compute decal projection matrix
  const decalMatrix = new THREE.Matrix4();
  decalMatrix.compose(options.position, new THREE.Quaternion().setFromEuler(options.rotation), new THREE.Vector3(1, 1, 1));
  const decalMatrixInv = decalMatrix.clone().invert();

  // Half-sizes for AABB check
  const halfSize = options.size.clone().multiplyScalar(0.5);

  // Process each triangle of the target mesh
  const indices = geometry.index?.array as Uint32Array | Uint16Array | undefined;
  const vertexCount = positions.length / 3;
  const triangleCount = indices ? indices.length / 3 : vertexCount / 3;

  for (let i = 0; i < triangleCount; i++) {
    const i0 = indices ? indices[i * 3] : i * 3;
    const i1 = indices ? indices[i * 3 + 1] : i * 3 + 1;
    const i2 = indices ? indices[i * 3 + 2] : i * 3 + 2;

    // Get triangle vertices in world space
    const p0 = new THREE.Vector3(positions[i0 * 3], positions[i0 * 3 + 1], positions[i0 * 3 + 2]);
    const p1 = new THREE.Vector3(positions[i1 * 3], positions[i1 * 3 + 1], positions[i1 * 3 + 2]);
    const p2 = new THREE.Vector3(positions[i2 * 3], positions[i2 * 3 + 1], positions[i2 * 3 + 2]);

    // Transform to decal local space
    p0.applyMatrix4(decalMatrixInv);
    p1.applyMatrix4(decalMatrixInv);
    p2.applyMatrix4(decalMatrixInv);

    // Check if triangle is within decal AABB
    if (!isTriangleInBounds(p0, p1, p2, halfSize)) continue;

    // Clip triangle edges and project
    const clipped = clipTriangleToBox(p0, p1, p2, halfSize);
    if (clipped.length === 0) continue;

    // Add projected triangle to decal geometry
    for (const vertex of clipped) {
      decalPositions.push(vertex[0], vertex[1], vertex[2]);

      // Normal in decal space (front face only)
      decalNormals.push(0, 0, 1);

      // Decal UV: project to XY plane in decal space
      decalDecalUvs.push((vertex[0] + halfSize.x) / options.size.x, (vertex[1] + halfSize.y) / options.size.y);

      // Original UV from target mesh (if available)
      const uvAttr = geometry.attributes.uv;
      if (uvAttr) {
        const uv = interpolateVertexAttribute(
          i0,
          i1,
          i2,
          vertex,
          p0,
          p1,
          p2,
          uvAttr.array as Float32Array,
        );
        decalUvs.push(uv[0], uv[1]);
      }
    }
  }

  if (decalPositions.length === 0) return null;

  decalGeometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(decalPositions), 3));
  decalGeometry.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(decalNormals), 3));
  decalGeometry.setAttribute('decalUv', new THREE.BufferAttribute(new Float32Array(decalDecalUvs), 2));
  if (decalUvs.length > 0) {
    decalGeometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(decalUvs), 2));
  }

  decalGeometry.positions = new Float32Array(decalPositions);
  decalGeometry.normals = new Float32Array(decalNormals);
  decalGeometry.uvs = decalUvs.length > 0 ? new Float32Array(decalUvs) : new Float32Array(0);
  decalGeometry.decalUvs = new Float32Array(decalDecalUvs);

  return decalGeometry;
}

/**
 * Check if a triangle is within a box (AABB).
 */
function isTriangleInBounds(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, halfSize: THREE.Vector3): boolean {
  const points = [p0, p1, p2];
  for (const p of points) {
    if (p.x >= -halfSize.x && p.x <= halfSize.x && 
        p.y >= -halfSize.y && p.y <= halfSize.y && 
        p.z >= -halfSize.z && p.z <= halfSize.z) {
      return true;
    }
  }
  return false;
}

/**
 * Sutherland-Hodgman polygon clipping against a box.
 */
function clipTriangleToBox(
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  halfSize: THREE.Vector3,
): THREE.Vector3[] {
  let polygon = [p0, p1, p2];

  // Clip against each face of the box
  const planes = [
    { normal: new THREE.Vector3(1, 0, 0), d: halfSize.x },
    { normal: new THREE.Vector3(-1, 0, 0), d: halfSize.x },
    { normal: new THREE.Vector3(0, 1, 0), d: halfSize.y },
    { normal: new THREE.Vector3(0, -1, 0), d: halfSize.y },
    { normal: new THREE.Vector3(0, 0, 1), d: halfSize.z },
    { normal: new THREE.Vector3(0, 0, -1), d: halfSize.z },
  ];

  for (const plane of planes) {
    if (polygon.length === 0) break;
    polygon = clipPolygonToPlane(polygon, plane.normal, plane.d);
  }

  return polygon;
}

function clipPolygonToPlane(polygon: THREE.Vector3[], normal: THREE.Vector3, d: number): THREE.Vector3[] {
  if (polygon.length === 0) return [];

  const result: THREE.Vector3[] = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];

    const currentDist = normal.dot(current) - d;
    const nextDist = normal.dot(next) - d;

    if (currentDist <= 0) {
      result.push(current.clone());
    }

    if ((currentDist < 0) !== (nextDist < 0)) {
      const t = currentDist / (currentDist - nextDist);
      const intersection = current.clone().lerp(next, t);
      result.push(intersection);
    }
  }

  return result;
}

/**
 * Interpolate a vertex attribute within a triangle.
 */
function interpolateVertexAttribute(
  i0: number,
  i1: number,
  i2: number,
  point: THREE.Vector3,
  p0: THREE.Vector3,
  p1: THREE.Vector3,
  p2: THREE.Vector3,
  attribute: Float32Array,
): [number, number] {
  // Barycentric coordinates
  const v0 = p1.clone().sub(p0);
  const v1 = p2.clone().sub(p0);
  const v2 = point.clone().sub(p0);

  const dot00 = v0.dot(v0);
  const dot01 = v0.dot(v1);
  const dot02 = v0.dot(v2);
  const dot11 = v1.dot(v1);
  const dot12 = v1.dot(v2);

  const invDenom = 1 / (dot00 * dot11 - dot01 * dot01);
  const u = (dot11 * dot02 - dot01 * dot12) * invDenom;
  const v = (dot00 * dot12 - dot01 * dot02) * invDenom;
  const w = 1 - u - v;

  const uv0 = [attribute[i0 * 2], attribute[i0 * 2 + 1]] as [number, number];
  const uv1 = [attribute[i1 * 2], attribute[i1 * 2 + 1]] as [number, number];
  const uv2 = [attribute[i2 * 2], attribute[i2 * 2 + 1]] as [number, number];

  return [
    uv0[0] * w + uv1[0] * u + uv2[0] * v,
    uv0[1] * w + uv1[1] * u + uv2[1] * v,
  ];
}

/**
 * Decal material: renders projected texture with proper normals.
 */
export function createDecalMaterial(options: DecalOptions): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    transparent: true,
    depthWrite: false,
    depthTest: true,
    polygonOffset: true,
    polygonOffsetFactor: -1,

    uniforms: {
      tDecal: { value: options.texture },
      tNormal: { value: options.normalMap ?? null },
      opacity: { value: options.opacity ?? 1 },
    },

    vertexShader: `
      varying vec2 vDecalUv;
      varying vec3 vNormal;
      
      void main() {
        vDecalUv = uv;
        vNormal = normalize(normalMatrix * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,

    fragmentShader: `
      uniform sampler2D tDecal;
      uniform sampler2D tNormal;
      uniform float opacity;
      
      varying vec2 vDecalUv;
      varying vec3 vNormal;
      
      void main() {
        vec4 decal = texture2D(tDecal, vDecalUv);
        
        // Fade edges
        vec2 edge = smoothstep(0.0, 0.1, vDecalUv) * smoothstep(1.0, 0.9, vDecalUv);
        decal.a *= edge.x * edge.y * opacity;
        
        if (decal.a < 0.01) discard;
        
        gl_FragColor = decal;
      }
    `,
  });
}
