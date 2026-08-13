import { describe, expect, it } from 'vitest';
import { box, csg, cylinder } from '@/lib/graphics/csg';
import { revolve, v3, type PolyMesh } from '@/lib/graphics/mesh-kernel';
import { arrayRadial } from '@/lib/graphics/shape-ops';

/**
 * A boolean between two closed solids must produce a closed solid.
 *
 * This is the property the bounding-box culling quietly broke, and the one no
 * amount of looking at renders reliably catches: a result with holes in it
 * still renders, still reports a plausible triangle count, and only shows
 * itself as shards of surface where a hole was meant to be. Counting edges used
 * by exactly one face is the whole diagnosis, and it takes microseconds.
 *
 * The culling itself is not under suspicion — skipping polygons that cannot
 * reach the other solid is what keeps a face from being subdivided into slivers
 * six operations deep — so the face counts are asserted too. A "fix" that
 * bought watertightness by doing the full split everywhere would pass the first
 * half of this file and fail the second.
 */

interface EdgeReport {
  readonly open: number;
  readonly nonManifold: number;
}

function edges(mesh: PolyMesh): EdgeReport {
  const counts = new Map<string, number>();
  for (const face of mesh.faces) {
    const n = face.vertices.length;
    for (let i = 0; i < n; i += 1) {
      const a = face.vertices[i] as number;
      const b = face.vertices[(i + 1) % n] as number;
      counts.set(a < b ? `${a}:${b}` : `${b}:${a}`, (counts.get(a < b ? `${a}:${b}` : `${b}:${a}`) ?? 0) + 1);
    }
  }
  let open = 0;
  let nonManifold = 0;
  for (const count of counts.values()) {
    if (count === 1) open += 1;
    else if (count > 2) nonManifold += 1;
  }
  return { open, nonManifold };
}

/** The dished wheel rim from this project's own supercar. */
const RIM_PROFILE = [
  { x: 0, y: 0.1 },
  { x: 0.05, y: 0.06 },
  { x: 0.2, y: 0.06 },
  { x: 0.28, y: 0.1 },
  { x: 0.28, y: 0.18 },
  { x: 0.2, y: 0.22 },
  { x: 0.05, y: 0.22 },
  { x: 0, y: 0.18 },
];

describe('a revolve that reaches the axis', () => {
  it('closes at the pole instead of leaving a ring of coincident vertices', () => {
    expect(edges(revolve(RIM_PROFILE, 24)).open).toBe(0);
  });

  it('closes a dome, which touches the axis at one end only', () => {
    const dome = [{ x: 0, y: 1 }, { x: 0.5, y: 0.8 }, { x: 0.9, y: 0.4 }, { x: 1, y: 0 }, { x: 0, y: 0 }];
    expect(edges(revolve(dome, 20)).open).toBe(0);
  });

  it('leaves a profile that never reaches the axis open, because it is a band', () => {
    // The supercar's tyre. Not a defect to fix here: a revolved strip is an
    // open surface by construction, and pretending otherwise would invent a
    // sidewall the recipe never asked for.
    const tyre = [{ x: 0.3, y: 0 }, { x: 0.36, y: 0.1 }, { x: 0.36, y: 0.18 }, { x: 0.3, y: 0.28 }];
    expect(edges(revolve(tyre, 24)).open).toBeGreaterThan(0);
  });
});

describe('booleans between closed solids', () => {
  it('subtracts a box from a box', () => {
    const result = csg(box(v3(0, 0, 0), v3(1, 1, 1)), box(v3(0.5, 0, 0), v3(0.4, 0.4, 0.4)), 'subtract');
    expect(edges(result).open).toBe(0);
  });

  it('subtracts five arrayed cutters from a revolved rim', () => {
    // The wheel. With the tool culled this came back with 71 open edges and
    // rendered as chrome shards where the spokes should have been.
    const rim = revolve(RIM_PROFILE, 24);
    const cutters = arrayRadial(box(v3(0.17, 0.14, 0), v3(0.14, 0.3, 0.09)), 5, v3(0, 1, 0), { sweep: Math.PI * 2 });
    const result = csg(rim, cutters, 'subtract');
    expect(edges(result).open).toBe(0);
  });

  it('unions and intersects without opening a seam', () => {
    const a = box(v3(0, 0, 0), v3(1, 1, 1));
    const b = cylinder(v3(0.3, -1, 0), v3(0.3, 1, 0), 0.3, 16);
    expect(edges(csg(a, b, 'union')).open).toBe(0);
    expect(edges(csg(a, b, 'intersect')).open).toBe(0);
  });

  it('stays closed when most of the base is nowhere near the tool', () => {
    // The case the culling exists for: a long bar with one small hole. Every
    // polygon of the bar outside the tool's reach must come through whole and
    // still meet its neighbours.
    const bar = box(v3(0, 0, 0), v3(20, 0.4, 0.4));
    const hole = cylinder(v3(0, -1, 0), v3(0, 1, 0), 0.1, 12);
    const result = csg(bar, hole, 'subtract');
    expect(edges(result).open).toBe(0);
  });
});

describe('the culling that keeps booleans affordable', () => {
  it('does not split the far end of a bar to cut a hole at its centre', () => {
    const bar = box(v3(0, 0, 0), v3(20, 0.4, 0.4));
    const hole = cylinder(v3(0, -1, 0), v3(0, 1, 0), 0.1, 12);
    const result = csg(bar, hole, 'subtract');
    // Six faces in, a dozen-sided bore out: without culling the bar's own
    // faces are split against every plane of the tool's tree instead.
    expect(result.faces.length).toBeLessThan(80);
  });

  it('returns the base untouched when the tool is nowhere near it', () => {
    const bar = box(v3(0, 0, 0), v3(2, 0.4, 0.4));
    const elsewhere = box(v3(50, 0, 0), v3(1, 1, 1));
    const result = csg(bar, elsewhere, 'subtract');
    // Six quads in, six quads' worth of triangles out: the polygon round trip
    // triangulates, but nothing is split against a tool it cannot reach.
    expect(result.faces.length).toBe(12);
    expect(edges(result).open).toBe(0);
  });
});
