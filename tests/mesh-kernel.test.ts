import { describe, expect, it } from 'vitest';
import {
  PolyMesh,
  autoCrease,
  decimate,
  ellipseProfile,
  extrude,
  loft,
  revolve,
  roundedRectProfile,
  subdivide,
  subdivideCatmullClark,
  superellipseProfile,
  triangulate,
  v3,
} from '@/lib/graphics/mesh-kernel';
import { box, sphere } from '@/lib/graphics/csg';

/**
 * The mesh kernel is what separates a generated car from a box with wheels. Its
 * guarantees are geometric, so they are asserted geometrically: subdivision must
 * converge on a smooth limit surface, creases must survive it, and every surface
 * that reaches a renderer must be closed, wound consistently and finite.
 */

function cube(size = 1): PolyMesh {
  const mesh = new PolyMesh();
  const h = size / 2;
  const corners: Array<[number, number, number]> = [
    [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
    [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
  ];
  for (const [x, y, z] of corners) mesh.addVertex(v3(x, y, z));
  mesh.addFace([0, 3, 2, 1]);
  mesh.addFace([4, 5, 6, 7]);
  mesh.addFace([0, 1, 5, 4]);
  mesh.addFace([1, 2, 6, 5]);
  mesh.addFace([2, 3, 7, 6]);
  mesh.addFace([3, 0, 4, 7]);
  return mesh;
}

function maxRadius(mesh: PolyMesh): number {
  return Math.max(...mesh.vertices.map((v) => Math.hypot(v.position.x, v.position.y, v.position.z)));
}

/** Every edge of a closed manifold is shared by exactly two faces. */
function edgeUseCounts(mesh: PolyMesh): Map<string, number> {
  const counts = new Map<string, number>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.vertices.length; i += 1) {
      const a = face.vertices[i] as number;
      const b = face.vertices[(i + 1) % face.vertices.length] as number;
      const key = PolyMesh.edgeKey(a, b);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return counts;
}

describe('Catmull-Clark subdivision', () => {
  it('turns every face into quads', () => {
    const once = subdivideCatmullClark(cube());
    expect(once.faces.every((f) => f.vertices.length === 4)).toBe(true);
    // 6 quads -> 24 quads: one per corner of each original face.
    expect(once.faces).toHaveLength(24);
  });

  it('stays a closed manifold', () => {
    const twice = subdivide(cube(), 2);
    for (const [, count] of edgeUseCounts(twice)) {
      expect(count).toBe(2);
    }
  });

  it('converges towards the smooth limit surface rather than shrinking away', () => {
    // A subdivided cube converges on a sphere-like limit shape: the radius
    // contracts once and then stabilises. A kernel that kept shrinking would
    // collapse a model to a point after enough levels.
    const r0 = maxRadius(cube(2));
    const r1 = maxRadius(subdivide(cube(2), 1));
    const r2 = maxRadius(subdivide(cube(2), 2));
    const r3 = maxRadius(subdivide(cube(2), 3));

    expect(r1).toBeLessThan(r0);
    expect(Math.abs(r3 - r2)).toBeLessThan(Math.abs(r2 - r1));
    expect(r3).toBeGreaterThan(0.5 * r0);
  });

  it('keeps a creased edge sharp while the rest of the surface smooths', () => {
    const sharp = cube(2);
    // Crease the whole top face: it must stay flat and full-size while the
    // uncreased silhouette rounds off.
    sharp.creaseFace(1, 5);
    const smoothed = subdivide(sharp, 2);

    const topVertices = smoothed.vertices.filter((v) => v.position.z > 0.97);
    expect(topVertices.length).toBeGreaterThan(4);

    const plain = subdivide(cube(2), 2);
    const plainTop = plain.vertices.filter((v) => v.position.z > 0.97);
    expect(topVertices.length).toBeGreaterThan(plainTop.length);
  });

  it('produces only finite coordinates', () => {
    for (const vertex of subdivide(cube(), 3).vertices) {
      expect(Number.isFinite(vertex.position.x)).toBe(true);
      expect(Number.isFinite(vertex.position.y)).toBe(true);
      expect(Number.isFinite(vertex.position.z)).toBe(true);
    }
  });
});

describe('profiles', () => {
  it('builds a superellipse between a diamond and a rectangle', () => {
    const points = superellipseProfile(2, 1, 2.5, 24);
    expect(points).toHaveLength(24);
    for (const p of points) {
      // Every point lies on |x/a|^n + |y/b|^n = 1.
      const value = Math.abs(p.x / 2) ** 2.5 + Math.abs(p.y / 1) ** 2.5;
      expect(value).toBeCloseTo(1, 5);
    }
  });

  it('reduces to an ellipse at exponent 2', () => {
    const superellipse = superellipseProfile(3, 2, 2, 32);
    for (const p of superellipse) {
      expect((p.x / 3) ** 2 + (p.y / 2) ** 2).toBeCloseTo(1, 5);
    }
  });

  it('keeps a rounded rectangle within its bounding box', () => {
    for (const p of roundedRectProfile(4, 2, 0.5, 32)) {
      expect(Math.abs(p.x)).toBeLessThanOrEqual(2 + 1e-6);
      expect(Math.abs(p.y)).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('produces an ellipse of the requested segment count', () => {
    expect(ellipseProfile(1, 2, 20)).toHaveLength(20);
  });
});

describe('surface construction', () => {
  it('lofts a closed hull through cross-sections', () => {
    const stations = [0, 1, 2, 3].map((i) => ({
      center: v3(0, 0, i),
      profile: ellipseProfile(1 + i * 0.2, 0.6, 12),
    }));
    const hull = loft(stations, { closeRing: true, capStart: true, capEnd: true });

    // Four rings of twelve, plus one centre vertex for each fan cap.
    expect(hull.vertices.length).toBe(4 * 12 + 2);
    // A capped, closed loft is watertight.
    for (const [, count] of edgeUseCounts(hull)) {
      expect(count).toBe(2);
    }
  });

  it('revolves a profile into a solid of revolution', () => {
    const solid = revolve([{ x: 0.5, y: -1 }, { x: 1, y: 0 }, { x: 0.5, y: 1 }], 16);
    expect(solid.faces.length).toBeGreaterThan(0);
    const radii = solid.vertices.map((v) => Math.hypot(v.position.x, v.position.z));
    expect(Math.max(...radii)).toBeCloseTo(1, 5);
  });

  it('extrudes an outline along +Y to the requested height', () => {
    const prism = extrude([{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }], 3);
    const ys = prism.vertices.map((v) => v.position.y);
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(3, 5);
    // The outline's own extent is preserved in the section plane.
    const xs = prism.vertices.map((v) => v.position.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2, 5);
  });
});

describe('triangulation', () => {
  it('emits three indices per triangle with matching attribute counts', () => {
    const result = triangulate(subdivide(cube(), 2));
    expect(result.indices.length % 3).toBe(0);
    expect(result.positions.length / 3).toBe(result.normals.length / 3);
    expect(result.positions.length / 3).toBe(result.uvs.length / 2);
  });

  it('produces unit-length normals', () => {
    const result = triangulate(subdivide(cube(), 2));
    for (let i = 0; i < result.normals.length; i += 3) {
      const n = Math.hypot(result.normals[i] as number, result.normals[i + 1] as number, result.normals[i + 2] as number);
      expect(n).toBeCloseTo(1, 4);
    }
  });

  it('splits vertices across a hard edge and shares them across a smooth one', () => {
    // A raw cube has 90-degree edges, so every corner must be split: 6 faces x 4
    // corners = 24 vertices, not the 8 the polygon mesh stores.
    const faceted = triangulate(cube(), { smoothAngleDegrees: 30 });
    expect(faceted.positions.length / 3).toBe(24);

    // Raising the threshold past 90 degrees makes the whole cube smooth-shaded,
    // so the corners are shared again.
    const smoothed = triangulate(cube(), { smoothAngleDegrees: 179 });
    expect(smoothed.positions.length / 3).toBe(8);
  });

  it('groups triangles by material so a multi-material body becomes multiple primitives', () => {
    const mesh = cube();
    mesh.faces[0]!.material = 1;
    mesh.faces[1]!.material = 2;
    const result = triangulate(mesh);

    const materials = result.materialGroups.map((g) => g.material).sort();
    expect(materials).toEqual([0, 1, 2]);
    const total = result.materialGroups.reduce((n, g) => n + g.count, 0);
    expect(total).toBe(result.indices.length);
  });

  it('references only indices that exist', () => {
    const result = triangulate(subdivide(cube(), 2));
    const vertexCount = result.positions.length / 3;
    for (const index of result.indices) {
      expect(index).toBeLessThan(vertexCount);
    }
  });
});

describe('decimation', () => {
  it('reduces vertex count for a lower level of detail while keeping the silhouette', () => {
    const dense = subdivide(cube(2), 3);
    const lod = decimate(dense, 0.3);

    expect(lod.vertices.length).toBeLessThan(dense.vertices.length);
    expect(lod.faces.length).toBeGreaterThan(0);
    // The bounding radius must survive: an LOD that shrinks the model would pop
    // visibly as the camera crosses the switch distance.
    expect(maxRadius(lod)).toBeGreaterThan(maxRadius(dense) * 0.75);
  });
});

/**
 * Semi-sharp creasing is what makes hard-surface geometry read as a
 * manufactured object rather than as CG. Subdivision offers only two wrong
 * answers on its own — melt the edge, or keep it mathematically sharp and
 * catching no highlight — and the fractional weight is the third.
 */
describe('automatic creasing', () => {
  function cubeCorner(mesh: PolyMesh): number {
    // How far the corner of a unit cube survives subdivision: 0.5 is untouched,
    // and the more the edge melts the smaller it gets.
    let furthest = 0;
    for (const vertex of subdivide(mesh, 2).vertices) {
      furthest = Math.max(furthest, Math.min(Math.abs(vertex.position.x), Math.abs(vertex.position.y), Math.abs(vertex.position.z)));
    }
    return furthest;
  }

  it('keeps an edge that subdivision would otherwise melt', () => {
    const plain = box(v3(0, 0, 0), v3(1, 1, 1));
    const creased = autoCrease(plain, { angleDegrees: 35, weight: 0.85 });
    expect(cubeCorner(creased)).toBeGreaterThan(cubeCorner(plain) + 0.02);
  });

  it('rounds it rather than leaving it razor sharp', () => {
    const semi = autoCrease(box(v3(0, 0, 0), v3(1, 1, 1)), { angleDegrees: 35, weight: 0.7 });
    const full = autoCrease(box(v3(0, 0, 0), v3(1, 1, 1)), { angleDegrees: 35, weight: 1 });
    expect(cubeCorner(semi)).toBeLessThan(cubeCorner(full));
  });

  it('leaves a smooth surface alone, because it has no edges to keep', () => {
    const ball = sphere(v3(0, 0, 0), 1, 24, 12);
    const creased = autoCrease(ball, { angleDegrees: 35, weight: 0.85 });
    expect(creased.creases.size).toBe(0);
  });

  it('does nothing at all at zero weight', () => {
    const plain = box(v3(0, 0, 0), v3(1, 1, 1));
    expect(autoCrease(plain, { weight: 0 }).creases.size).toBe(0);
  });
});
