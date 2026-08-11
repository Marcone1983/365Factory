import { Rng } from '@/lib/util/random';
import type { GltfMaterial, MeshPrimitiveData } from '@/lib/graphics/gltf';

/**
 * Parametric mesh synthesis.
 *
 * Produces original low-poly geometry for characters, creatures, structures,
 * props, vehicles and vegetation. Every dimension, proportion, segment count and
 * silhouette perturbation is sampled from the product's seed, so two products
 * never receive the same model even when they request the same archetype.
 *
 * Budgets are deliberately mobile-first: a few hundred to a few thousand
 * triangles per asset, which is what keeps draw calls and memory inside the
 * Android envelope the performance tests enforce.
 */

interface Transform {
  readonly translate?: readonly [number, number, number];
  readonly scale?: readonly [number, number, number];
  readonly rotateY?: number;
  readonly rotateZ?: number;
  readonly rotateX?: number;
}

/** Accumulates triangles into flat typed-array buffers ready for GLB export. */
export class MeshBuilder {
  private readonly positions: number[] = [];
  private readonly normals: number[] = [];
  private readonly uvs: number[] = [];
  private readonly indices: number[] = [];

  get vertexCount(): number {
    return this.positions.length / 3;
  }

  get triangleCount(): number {
    return this.indices.length / 3;
  }

  private static apply(point: [number, number, number], transform?: Transform): [number, number, number] {
    let [x, y, z] = point;
    if (transform?.scale) {
      x *= transform.scale[0];
      y *= transform.scale[1];
      z *= transform.scale[2];
    }
    if (transform?.rotateX) {
      const c = Math.cos(transform.rotateX);
      const s = Math.sin(transform.rotateX);
      [y, z] = [y * c - z * s, y * s + z * c];
    }
    if (transform?.rotateZ) {
      const c = Math.cos(transform.rotateZ);
      const s = Math.sin(transform.rotateZ);
      [x, y] = [x * c - y * s, x * s + y * c];
    }
    if (transform?.rotateY) {
      const c = Math.cos(transform.rotateY);
      const s = Math.sin(transform.rotateY);
      [x, z] = [x * c + z * s, -x * s + z * c];
    }
    if (transform?.translate) {
      x += transform.translate[0];
      y += transform.translate[1];
      z += transform.translate[2];
    }
    return [x, y, z];
  }

  addTriangle(a: [number, number, number], b: [number, number, number], c: [number, number, number], transform?: Transform): void {
    const pa = MeshBuilder.apply(a, transform);
    const pb = MeshBuilder.apply(b, transform);
    const pc = MeshBuilder.apply(c, transform);
    const ux = pb[0] - pa[0];
    const uy = pb[1] - pa[1];
    const uz = pb[2] - pa[2];
    const vx = pc[0] - pa[0];
    const vy = pc[1] - pa[1];
    const vz = pc[2] - pa[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz) || 1;
    nx /= length;
    ny /= length;
    nz /= length;

    const base = this.vertexCount;
    for (const [index, point] of [pa, pb, pc].entries()) {
      this.positions.push(point[0], point[1], point[2]);
      this.normals.push(nx, ny, nz);
      this.uvs.push(index === 1 ? 1 : 0, index === 2 ? 1 : 0);
    }
    this.indices.push(base, base + 1, base + 2);
  }

  addQuad(
    a: [number, number, number],
    b: [number, number, number],
    c: [number, number, number],
    d: [number, number, number],
    transform?: Transform,
  ): void {
    this.addTriangle(a, b, c, transform);
    this.addTriangle(a, c, d, transform);
  }

  addBox(width: number, height: number, depth: number, transform?: Transform): void {
    const x = width / 2;
    const z = depth / 2;
    const y0 = 0;
    const y1 = height;
    const p: Array<[number, number, number]> = [
      [-x, y0, -z], [x, y0, -z], [x, y0, z], [-x, y0, z],
      [-x, y1, -z], [x, y1, -z], [x, y1, z], [-x, y1, z],
    ];
    const q = (i: number, j: number, k: number, l: number): void =>
      this.addQuad(p[i] as [number, number, number], p[j] as [number, number, number], p[k] as [number, number, number], p[l] as [number, number, number], transform);
    q(4, 5, 6, 7); // top
    q(3, 2, 1, 0); // bottom
    q(0, 1, 5, 4); // back
    q(2, 3, 7, 6); // front
    q(1, 2, 6, 5); // right
    q(3, 0, 4, 7); // left
  }

  /** Tapered prism; `sides` controls the silhouette from triangular to round. */
  addTaperedCylinder(bottomRadius: number, topRadius: number, height: number, sides: number, transform?: Transform, capTop = true): void {
    const step = (Math.PI * 2) / sides;
    for (let i = 0; i < sides; i += 1) {
      const a0 = i * step;
      const a1 = (i + 1) * step;
      const b0: [number, number, number] = [Math.cos(a0) * bottomRadius, 0, Math.sin(a0) * bottomRadius];
      const b1: [number, number, number] = [Math.cos(a1) * bottomRadius, 0, Math.sin(a1) * bottomRadius];
      const t0: [number, number, number] = [Math.cos(a0) * topRadius, height, Math.sin(a0) * topRadius];
      const t1: [number, number, number] = [Math.cos(a1) * topRadius, height, Math.sin(a1) * topRadius];
      this.addQuad(b0, b1, t1, t0, transform);
      this.addTriangle([0, 0, 0], b1, b0, transform);
      if (capTop && topRadius > 0.0001) this.addTriangle([0, height, 0], t0, t1, transform);
    }
    if (!capTop || topRadius <= 0.0001) {
      for (let i = 0; i < sides; i += 1) {
        const a0 = i * step;
        const a1 = (i + 1) * step;
        this.addTriangle(
          [0, height, 0],
          [Math.cos(a0) * topRadius, height, Math.sin(a0) * topRadius],
          [Math.cos(a1) * topRadius, height, Math.sin(a1) * topRadius],
          transform,
        );
      }
    }
  }

  /** Faceted ellipsoid with seeded vertex jitter for organic silhouettes. */
  addFacetedSphere(radius: number, rings: number, segments: number, rng: Rng, jitter: number, transform?: Transform): void {
    const point = (ring: number, segment: number): [number, number, number] => {
      const phi = (ring / rings) * Math.PI;
      const theta = (segment / segments) * Math.PI * 2;
      const wobble = 1 + (rng.next() - 0.5) * jitter;
      return [
        Math.sin(phi) * Math.cos(theta) * radius * wobble,
        Math.cos(phi) * radius * wobble,
        Math.sin(phi) * Math.sin(theta) * radius * wobble,
      ];
    };
    // Pre-sample so adjacent faces share the same perturbed vertices.
    const grid: Array<Array<[number, number, number]>> = [];
    for (let ring = 0; ring <= rings; ring += 1) {
      const row: Array<[number, number, number]> = [];
      for (let segment = 0; segment <= segments; segment += 1) {
        row.push(point(ring, segment % segments));
      }
      grid.push(row);
    }
    for (let ring = 0; ring < rings; ring += 1) {
      for (let segment = 0; segment < segments; segment += 1) {
        const a = (grid[ring] as Array<[number, number, number]>)[segment] as [number, number, number];
        const b = (grid[ring] as Array<[number, number, number]>)[segment + 1] as [number, number, number];
        const c = (grid[ring + 1] as Array<[number, number, number]>)[segment + 1] as [number, number, number];
        const d = (grid[ring + 1] as Array<[number, number, number]>)[segment] as [number, number, number];
        this.addQuad(a, b, c, d, transform);
      }
    }
  }

  build(name: string, materialIndex: number): MeshPrimitiveData {
    return {
      name,
      positions: Float32Array.from(this.positions),
      normals: Float32Array.from(this.normals),
      uvs: Float32Array.from(this.uvs),
      indices: Uint32Array.from(this.indices),
      materialIndex,
    };
  }
}

export type MeshArchetype =
  | 'character'
  | 'creature'
  | 'building'
  | 'prop'
  | 'vehicle'
  | 'weapon'
  | 'flora'
  | 'rock'
  | 'collectible';

export interface MeshRequest {
  readonly archetype: MeshArchetype;
  readonly name: string;
  readonly seed: number;
  /** 0 = compact and blocky, 1 = tall and elaborate. */
  readonly complexity?: number;
  readonly palette: readonly string[];
}

export interface GeneratedMesh {
  readonly primitives: readonly MeshPrimitiveData[];
  readonly materials: readonly GltfMaterial[];
  readonly triangleCount: number;
  readonly archetype: MeshArchetype;
}

function linearFromHex(hex: string, alpha = 1): [number, number, number, number] {
  const clean = hex.replace('#', '');
  const srgb = [0, 2, 4].map((offset) => Number.parseInt(clean.slice(offset, offset + 2), 16) / 255);
  // glTF base colour factors are linear.
  const linear = srgb.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return [linear[0] ?? 0, linear[1] ?? 0, linear[2] ?? 0, alpha];
}

function materialsFrom(palette: readonly string[], rng: Rng): GltfMaterial[] {
  const picks = palette.length >= 3 ? palette : ['#8a93a6', '#3f4a63', '#d8dee9'];
  return picks.slice(0, 4).map((hex, index) => ({
    name: `mat_${index}`,
    baseColor: linearFromHex(hex),
    metallic: index === 1 ? rng.float(0.1, 0.55) : rng.float(0, 0.12),
    roughness: rng.float(0.42, 0.92),
    emissive: index === 3 ? (linearFromHex(hex).slice(0, 3) as unknown as [number, number, number]) : [0, 0, 0],
  }));
}

export function generateMesh(request: MeshRequest): GeneratedMesh {
  const rng = new Rng(request.seed);
  const materials = materialsFrom(request.palette, rng);
  const complexity = request.complexity ?? rng.float(0.3, 0.8);
  const primary = new MeshBuilder();
  const secondary = new MeshBuilder();

  switch (request.archetype) {
    case 'character':
    case 'creature': {
      const legged = request.archetype === 'creature' ? rng.pick([2, 4, 6]) : 2;
      const height = rng.float(1.5, 2.1) * (request.archetype === 'creature' ? rng.float(0.6, 1.4) : 1);
      const torsoHeight = height * rng.float(0.32, 0.42);
      const legHeight = height * rng.float(0.36, 0.48);
      const shoulderWidth = height * rng.float(0.2, 0.3);
      const sides = 5 + Math.round(complexity * 5);

      primary.addTaperedCylinder(shoulderWidth * 0.55, shoulderWidth * 0.75, torsoHeight, sides, { translate: [0, legHeight, 0] });
      secondary.addFacetedSphere(height * rng.float(0.1, 0.14), 5, sides, rng, 0.18, {
        translate: [0, legHeight + torsoHeight + height * 0.09, 0],
        scale: [1, rng.float(0.9, 1.25), rng.float(0.85, 1.1)],
      });

      const legSpread = shoulderWidth * 0.55;
      for (let i = 0; i < legged; i += 1) {
        const row = Math.floor(i / 2);
        const side = i % 2 === 0 ? -1 : 1;
        primary.addTaperedCylinder(height * 0.055, height * 0.04, legHeight, Math.max(4, sides - 1), {
          translate: [side * legSpread * 0.6, 0, (row - (legged / 2 - 1) / 2) * shoulderWidth * 0.7],
        });
      }

      const armCount = request.archetype === 'creature' ? (rng.bool(0.4) ? 2 : 0) : 2;
      for (let i = 0; i < armCount; i += 1) {
        const side = i % 2 === 0 ? -1 : 1;
        primary.addTaperedCylinder(height * 0.045, height * 0.035, torsoHeight * rng.float(0.8, 1.05), Math.max(4, sides - 2), {
          translate: [side * shoulderWidth * 0.62, legHeight + torsoHeight * 0.92, 0],
          rotateZ: side * rng.float(0.05, 0.32),
          scale: [1, -1, 1],
        });
      }

      if (request.archetype === 'creature' && rng.bool(0.6)) {
        const spineCount = 3 + Math.round(complexity * 5);
        for (let i = 0; i < spineCount; i += 1) {
          const t = i / spineCount;
          secondary.addTaperedCylinder(height * 0.03, 0, height * rng.float(0.08, 0.18), 4, {
            translate: [0, legHeight + torsoHeight * (0.35 + t * 0.6), -shoulderWidth * 0.4],
            rotateX: -0.5,
          });
        }
      }
      break;
    }

    case 'building': {
      const floors = 1 + Math.round(complexity * 5);
      const footprint = rng.float(3, 7);
      let y = 0;
      for (let i = 0; i < floors; i += 1) {
        const shrink = 1 - i * rng.float(0.03, 0.12);
        const floorHeight = rng.float(2.2, 3.4);
        primary.addBox(footprint * shrink, floorHeight, footprint * shrink * rng.float(0.7, 1.1), { translate: [0, y, 0] });
        y += floorHeight;
      }
      if (rng.bool(0.7)) {
        primary.addTaperedCylinder(footprint * 0.42, footprint * rng.float(0.02, 0.2), rng.float(1.4, 3.4), rng.bool() ? 4 : 6, { translate: [0, y, 0] });
      }
      const windows = Math.round(floors * rng.float(2, 5));
      for (let i = 0; i < windows; i += 1) {
        const floor = rng.int(0, floors);
        secondary.addBox(rng.float(0.5, 0.9), rng.float(0.7, 1.2), 0.12, {
          translate: [rng.float(-1, 1) * footprint * 0.3, floor * 2.8 + rng.float(0.6, 1.4), footprint * 0.45],
        });
      }
      break;
    }

    case 'vehicle': {
      const length = rng.float(3.4, 5.6);
      const width = rng.float(1.6, 2.3);
      primary.addBox(width, rng.float(0.5, 0.8), length, { translate: [0, 0.45, 0] });
      primary.addBox(width * 0.86, rng.float(0.5, 0.9), length * rng.float(0.4, 0.58), { translate: [0, 1.05, rng.float(-0.5, 0.4)] });
      const wheels = rng.pick([4, 6]);
      for (let i = 0; i < wheels; i += 1) {
        const side = i % 2 === 0 ? -1 : 1;
        const row = Math.floor(i / 2);
        secondary.addTaperedCylinder(rng.float(0.36, 0.48), rng.float(0.36, 0.48), 0.28, 10, {
          translate: [side * width * 0.55, 0.42, (row - (wheels / 2 - 1) / 2) * length * 0.42],
          rotateZ: Math.PI / 2,
        });
      }
      break;
    }

    case 'weapon': {
      const length = rng.float(0.9, 1.7);
      primary.addTaperedCylinder(rng.float(0.03, 0.05), rng.float(0.02, 0.035), length * 0.72, 6, { translate: [0, length * 0.18, 0] });
      primary.addBox(rng.float(0.16, 0.3), rng.float(0.05, 0.09), rng.float(0.06, 0.1), { translate: [0, length * 0.16, 0] });
      secondary.addTaperedCylinder(rng.float(0.05, 0.09), 0, length * rng.float(0.18, 0.32), rng.bool() ? 4 : 6, { translate: [0, length * 0.9, 0] });
      secondary.addTaperedCylinder(rng.float(0.035, 0.055), rng.float(0.04, 0.06), length * 0.16, 6, { translate: [0, 0, 0] });
      break;
    }

    case 'flora': {
      const height = rng.float(2.4, 6.2);
      primary.addTaperedCylinder(height * 0.045, height * 0.028, height * rng.float(0.45, 0.7), 5 + Math.round(complexity * 3));
      const canopies = 1 + Math.round(complexity * 3);
      for (let i = 0; i < canopies; i += 1) {
        secondary.addFacetedSphere(height * rng.float(0.16, 0.3), 4, 6, rng, 0.42, {
          translate: [rng.float(-0.3, 0.3) * height * 0.2, height * (0.6 + i * 0.14), rng.float(-0.3, 0.3) * height * 0.2],
          scale: [1, rng.float(0.7, 1.1), 1],
        });
      }
      break;
    }

    case 'rock': {
      const radius = rng.float(0.7, 2.6);
      primary.addFacetedSphere(radius, 3 + Math.round(complexity * 2), 6 + Math.round(complexity * 3), rng, rng.float(0.35, 0.7), {
        scale: [1, rng.float(0.45, 0.9), rng.float(0.8, 1.25)],
      });
      const shards = Math.round(complexity * 4);
      for (let i = 0; i < shards; i += 1) {
        secondary.addTaperedCylinder(radius * rng.float(0.1, 0.2), 0, radius * rng.float(0.5, 1.3), 4, {
          translate: [rng.float(-1, 1) * radius * 0.6, radius * 0.2, rng.float(-1, 1) * radius * 0.6],
          rotateZ: rng.float(-0.5, 0.5),
          rotateX: rng.float(-0.5, 0.5),
        });
      }
      break;
    }

    case 'collectible': {
      const radius = rng.float(0.22, 0.45);
      primary.addFacetedSphere(radius, 3, rng.pick([5, 6, 8]), rng, 0.12, { scale: [1, rng.float(1.1, 1.7), 1] });
      secondary.addTaperedCylinder(radius * 1.25, radius * 1.25, radius * 0.12, 8, { translate: [0, radius * 0.4, 0] });
      break;
    }

    case 'prop':
    default: {
      const size = rng.float(0.6, 1.8);
      const parts = 2 + Math.round(complexity * 4);
      let y = 0;
      for (let i = 0; i < parts; i += 1) {
        const partHeight = size * rng.float(0.18, 0.5);
        if (rng.bool(0.55)) {
          primary.addBox(size * rng.float(0.4, 1), partHeight, size * rng.float(0.4, 1), { translate: [0, y, 0], rotateY: rng.float(0, Math.PI) });
        } else {
          primary.addTaperedCylinder(size * rng.float(0.2, 0.45), size * rng.float(0.15, 0.4), partHeight, rng.pick([5, 6, 8]), { translate: [0, y, 0] });
        }
        y += partHeight;
      }
      break;
    }
  }

  const primitives: MeshPrimitiveData[] = [primary.build(`${request.name}_base`, 0)];
  if (secondary.triangleCount > 0) primitives.push(secondary.build(`${request.name}_detail`, Math.min(1, materials.length - 1)));

  return {
    primitives,
    materials,
    triangleCount: primitives.reduce((sum, p) => sum + p.indices.length / 3, 0),
    archetype: request.archetype,
  };
}
