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
