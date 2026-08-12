import { describe, expect, it } from 'vitest';
import { box, cylinder, intersect, sphere, subtract, subtractAll, union } from '@/lib/graphics/csg';
import { triangulate, v3, type PolyMesh } from '@/lib/graphics/mesh-kernel';

/**
 * Boolean operations are the foundation every other modelling operation now
 * rests on, so they are tested by measurement rather than by "it produced some
 * triangles": enclosed volume, bounding box and watertightness.
 *
 * Volume is computed by the divergence theorem over the triangulated surface.
 * It is the only test that actually distinguishes a correct subtraction from a
 * plausible-looking one — a boolean that leaves the tool's geometry behind, or
 * that inverts a winding, gives a wrong volume while still looking fine in a
 * wireframe.
 */
function signedVolume(mesh: PolyMesh): number {
  const tri = triangulate(mesh, { smoothAngleDegrees: 1 });
  let total = 0;
  for (let i = 0; i < tri.indices.length; i += 3) {
    const ia = (tri.indices[i] as number) * 3;
    const ib = (tri.indices[i + 1] as number) * 3;
    const ic = (tri.indices[i + 2] as number) * 3;
    const ax = tri.positions[ia] as number;
    const ay = tri.positions[ia + 1] as number;
    const az = tri.positions[ia + 2] as number;
    const bx = tri.positions[ib] as number;
    const by = tri.positions[ib + 1] as number;
    const bz = tri.positions[ib + 2] as number;
    const cx = tri.positions[ic] as number;
    const cy = tri.positions[ic + 1] as number;
    const cz = tri.positions[ic + 2] as number;
    total +=
      (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  return total;
}

function bounds(mesh: PolyMesh): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (const vertex of mesh.vertices) {
    const p = [vertex.position.x, vertex.position.y, vertex.position.z];
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis] as number, p[axis] as number);
      max[axis] = Math.max(max[axis] as number, p[axis] as number);
    }
  }
  return { min, max };
}

/** Every edge of a closed surface is used by exactly two faces. */
function openEdges(mesh: PolyMesh): number {
  const counts = new Map<string, number>();
  for (const face of mesh.faces) {
    for (let i = 0; i < face.vertices.length; i += 1) {
      const a = face.vertices[i] as number;
      const b = face.vertices[(i + 1) % face.vertices.length] as number;
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  let open = 0;
  for (const [, count] of counts) if (count !== 2) open += 1;
  return open;
}

describe('primitive solids', () => {
  it('builds a box of the requested volume', () => {
    expect(signedVolume(box(v3(0, 0, 0), v3(2, 3, 4)))).toBeCloseTo(24, 5);
  });

  it('builds a box that is closed', () => {
    expect(openEdges(box(v3(0, 0, 0), v3(1, 1, 1)))).toBe(0);
  });

  it('builds a sphere approaching 4/3·π·r³', () => {
    const volume = signedVolume(sphere(v3(0, 0, 0), 1, 48, 32));
    // A 48x32 tessellation under-reports the true volume by roughly 0.5%.
    expect(volume).toBeGreaterThan(4.14);
    expect(volume).toBeLessThan(4.19);
  });

  it('builds a cylinder approaching π·r²·h along an arbitrary axis', () => {
    const volume = signedVolume(cylinder(v3(0, 0, 0), v3(0, 4, 0), 1, 64));
    expect(volume).toBeGreaterThan(12.4);
    expect(volume).toBeLessThan(12.6);

    // The same cylinder on a diagonal axis must enclose the same volume.
    const diagonal = signedVolume(cylinder(v3(-1, -1, -1), v3(1, 1, 1), 0.5, 64));
    const height = Math.sqrt(12);
    expect(diagonal).toBeGreaterThan(Math.PI * 0.25 * height * 0.985);
    expect(diagonal).toBeLessThan(Math.PI * 0.25 * height * 1.01);
  });
});

describe('subtract', () => {
  it('removes exactly the overlapping volume', () => {
    // A 2×2×2 box with a 1×1×1 corner-overlapping box removed.
    const base = box(v3(0, 0, 0), v3(2, 2, 2));
    const tool = box(v3(1, 1, 1), v3(1, 1, 1));
    const result = subtract(base, tool);

    // The tool's centre is at a corner of the base, so exactly one eighth of the
    // tool (0.125³ of a unit cube = 0.125) lies inside.
    expect(signedVolume(result)).toBeCloseTo(8 - 0.125, 4);
  });

  it('cuts a through-hole, leaving a closed surface', () => {
    const plate = box(v3(0, 0, 0), v3(4, 0.5, 4));
    const drill = cylinder(v3(0, -1, 0), v3(0, 1, 0), 0.5, 48);
    const result = subtract(plate, drill);

    const expected = 4 * 0.5 * 4 - Math.PI * 0.25 * 0.5;
    expect(signedVolume(result)).toBeGreaterThan(expected * 0.99);
    expect(signedVolume(result)).toBeLessThan(expected * 1.01);
    expect(openEdges(result)).toBe(0);
  });

  it('leaves the base unchanged when the tool does not touch it', () => {
    const base = box(v3(0, 0, 0), v3(2, 2, 2));
    const away = box(v3(10, 10, 10), v3(1, 1, 1));
    expect(signedVolume(subtract(base, away))).toBeCloseTo(8, 4);
  });

  it('removes everything when the tool encloses the base', () => {
    const base = box(v3(0, 0, 0), v3(1, 1, 1));
    const engulfing = box(v3(0, 0, 0), v3(5, 5, 5));
    expect(Math.abs(signedVolume(subtract(base, engulfing)))).toBeLessThan(1e-6);
  });

  it('applies several cuts in sequence', () => {
    const plate = box(v3(0, 0, 0), v3(6, 1, 2));
    const holes = [-2, 0, 2].map((x) => cylinder(v3(x, -1, 0), v3(x, 1, 0), 0.4, 32));
    const result = subtractAll(plate, holes);

    const expected = 12 - 3 * Math.PI * 0.16 * 1;
    expect(signedVolume(result)).toBeGreaterThan(expected * 0.99);
    expect(signedVolume(result)).toBeLessThan(expected * 1.01);
  });

  it('keeps the cut walls addressable by material', () => {
    const base = box(v3(0, 0, 0), v3(2, 2, 2), 0);
    const tool = cylinder(v3(0, -2, 0), v3(0, 2, 0), 0.5, 24, 7);
    const result = subtract(base, tool);
    // The bore wall comes from the tool, so it carries the tool's material and
    // can be shaded differently from the surface it was cut into.
    expect(result.faces.some((face) => face.material === 7)).toBe(true);
    expect(result.faces.some((face) => face.material === 0)).toBe(true);
  });
});

describe('union', () => {
  it('merges two overlapping boxes without double-counting the overlap', () => {
    const a = box(v3(0, 0, 0), v3(2, 2, 2));
    const b = box(v3(1, 0, 0), v3(2, 2, 2));
    // Overlap is a 1×2×2 slab.
    expect(signedVolume(union(a, b))).toBeCloseTo(8 + 8 - 4, 4);
  });

  it('produces a closed surface from two disjoint solids', () => {
    const a = box(v3(0, 0, 0), v3(1, 1, 1));
    const b = box(v3(5, 0, 0), v3(1, 1, 1));
    const result = union(a, b);
    expect(signedVolume(result)).toBeCloseTo(2, 4);
    expect(openEdges(result)).toBe(0);
  });
});

describe('intersect', () => {
  it('keeps only the shared volume', () => {
    const a = box(v3(0, 0, 0), v3(2, 2, 2));
    const b = box(v3(1, 0, 0), v3(2, 2, 2));
    expect(signedVolume(intersect(a, b))).toBeCloseTo(4, 4);
  });

  it('produces nothing when the solids do not overlap', () => {
    const a = box(v3(0, 0, 0), v3(1, 1, 1));
    const b = box(v3(9, 0, 0), v3(1, 1, 1));
    expect(Math.abs(signedVolume(intersect(a, b)))).toBeLessThan(1e-6);
  });
});

describe('robustness', () => {
  it('handles a cut exactly coplanar with a face without leaving slivers', () => {
    // The tool's top face lies exactly on the base's bottom face. A naive
    // implementation leaves a zero-thickness sliver here that z-fights.
    const base = box(v3(0, 0, 0), v3(2, 2, 2));
    const flush = box(v3(0, -2, 0), v3(2, 2, 2));
    const result = subtract(base, flush);
    expect(signedVolume(result)).toBeCloseTo(8, 4);
    expect(bounds(result).min[1]).toBeCloseTo(-1, 5);
  });

  it('stays within the base\'s bounding box after a subtraction', () => {
    const base = box(v3(0, 0, 0), v3(2, 2, 2));
    const tool = sphere(v3(1, 1, 1), 1.2, 24, 16);
    const result = subtract(base, tool);
    const b = bounds(result);
    for (let axis = 0; axis < 3; axis += 1) {
      expect(b.min[axis]).toBeGreaterThanOrEqual(-1.0001);
      expect(b.max[axis]).toBeLessThanOrEqual(1.0001);
    }
  });

  it('produces only finite coordinates', () => {
    const result = subtract(sphere(v3(0, 0, 0), 1, 24, 16), box(v3(0.5, 0, 0), v3(1, 1, 1)));
    for (const vertex of result.vertices) {
      expect(Number.isFinite(vertex.position.x)).toBe(true);
      expect(Number.isFinite(vertex.position.y)).toBe(true);
      expect(Number.isFinite(vertex.position.z)).toBe(true);
    }
  });
});

/**
 * Polygons out of reach of the other solid are kept out of the BSP entirely.
 * That is a large win — it is the difference between a face costing 84,000
 * polygons and 13,000 — and it is only safe if the answer is unchanged. These
 * check the properties the culling must not break: the volume, the closure of
 * the surface, and the geometry far from the cut.
 */
describe('bounding-box culling', () => {
  it('gives the same volume as the cut it replaces, for a tool far smaller than the base', () => {
    const base = box(v3(0, 0, 0), v3(2, 2, 2));
    // A tool in one corner: most of the base is nowhere near it, which is
    // exactly the case the culling exists for.
    const tool = box(v3(0.9, 0.9, 0.9), v3(0.4, 0.4, 0.4));
    const result = subtract(base, tool);
    // 8 minus the corner of the tool that lies inside the base: the tool spans
    // 0.7 to 1.1 on each axis and the base ends at 1.0, so 0.3³ is removed.
    expect(signedVolume(result)).toBeCloseTo(8 - 0.3 * 0.3 * 0.3, 4);
    expect(openEdges(result)).toBe(0);
  });

  it('leaves the far side of the base geometrically untouched', () => {
    const base = box(v3(0, 0, 0), v3(4, 1, 1));
    const tool = sphere(v3(1.9, 0, 0), 0.3, 16, 8);
    const result = subtract(base, tool);

    // No vertex introduced behind x = 0: the cut is at the far end, and a
    // polygon there has no business being split.
    const introduced = result.vertices.filter((vertex) => vertex.position.x < -0.001);
    for (const vertex of introduced) {
      expect(Math.abs(Math.abs(vertex.position.x) - 2)).toBeLessThan(1e-6);
    }
    expect(openEdges(result)).toBe(0);
  });

  it('unions disjoint solids without running the BSP at all', () => {
    const a = box(v3(0, 0, 0), v3(1, 1, 1));
    const b = box(v3(10, 0, 0), v3(1, 1, 1));
    const result = union(a, b);
    expect(signedVolume(result)).toBeCloseTo(2, 6);
    // No polygon was split, so no vertex was introduced. Counting vertices
    // rather than faces states that directly: the boolean path always fans
    // faces into triangles, so a face count says nothing about splitting.
    expect(result.vertices.length).toBe(a.vertices.length + b.vertices.length);
  });

  it('subtracts a distant tool by returning the base unchanged', () => {
    const base = sphere(v3(0, 0, 0), 1, 20, 10);
    const result = subtract(base, box(v3(9, 9, 9), v3(1, 1, 1)));
    // Splitting only ever adds vertices, and the weld in the rebuild only ever
    // removes them (a sphere's pole is one point held by many triangles), so
    // "no more than the input" is the assertion that catches a stray split.
    expect(result.vertices.length).toBeLessThanOrEqual(base.vertices.length);
    expect(signedVolume(result)).toBeCloseTo(signedVolume(base), 6);
  });

  it('still handles a tool wholly enclosed by the base, where culling cannot decide', () => {
    // The base's *surface* is nowhere near the tool while its *volume* contains
    // it, so the cheap test cannot answer and the full BSP has to run.
    const base = box(v3(0, 0, 0), v3(4, 4, 4));
    const cavity = box(v3(0, 0, 0), v3(1, 1, 1));
    const result = subtract(base, cavity);
    expect(signedVolume(result)).toBeCloseTo(64 - 1, 4);
  });

  it('intersects correctly when most of each solid is out of reach of the other', () => {
    const a = box(v3(0, 0, 0), v3(6, 1, 1));
    const b = box(v3(0, 0, 0), v3(1, 6, 1));
    expect(signedVolume(intersect(a, b))).toBeCloseTo(1, 5);
  });
});
