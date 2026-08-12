import { describe, expect, it } from 'vitest';
import { Bvh } from '@/lib/graphics/bvh';
import { bakeVertexOcclusion, occlusionToVertexColors } from '@/lib/graphics/occlusion';
import { box, subtract, union } from '@/lib/graphics/csg';
import { triangulate, v3 } from '@/lib/graphics/mesh-kernel';

/**
 * Ambient occlusion is the largest single contributor to whether a generated
 * asset reads as an object or as plastic, and it is entirely invisible in a
 * triangle count. It is tested by the property it exists to produce: a point
 * down inside a crevice must come back darker than a point out on an open face,
 * by a margin, on geometry where a human can say which is which.
 */

function bakeFor(mesh: ReturnType<typeof box>, samples = 96): { at: (x: number, y: number, z: number) => number } {
  const tri = triangulate(mesh, { smoothAngleDegrees: 150 });
  const baked = bakeVertexOcclusion(tri.positions, tri.normals, tri.indices, { samples, smoothPasses: 0 });

  return {
    at(x, y, z) {
      // The nearest vertex to the probe point, which is what a renderer would
      // interpolate from.
      let best = Infinity;
      let value = 1;
      for (let i = 0; i < baked.occlusion.length; i += 1) {
        const distance = Math.hypot(
          (tri.positions[i * 3] as number) - x,
          (tri.positions[i * 3 + 1] as number) - y,
          (tri.positions[i * 3 + 2] as number) - z,
        );
        if (distance < best) {
          best = distance;
          value = baked.occlusion[i] as number;
        }
      }
      return value;
    },
  };
}

describe('bvh', () => {
  it('finds a triangle in the way and misses one that is not', () => {
    const mesh = box(v3(0, 0, 0), v3(2, 2, 2));
    const positions: number[] = [];
    const indices: number[] = [];
    const tri = triangulate(mesh, { smoothAngleDegrees: 150 });
    positions.push(...tri.positions);
    indices.push(...tri.indices);
    const bvh = new Bvh(Float32Array.from(positions), Uint32Array.from(indices));

    // A ray starting outside and aimed at the box hits it.
    expect(bvh.occluded(v3(0, 0, -5), v3(0, 0, 1), 10)).toBe(true);
    // The same ray aimed away does not.
    expect(bvh.occluded(v3(0, 0, -5), v3(0, 0, -1), 10)).toBe(false);
    // Nor does one that stops short.
    expect(bvh.occluded(v3(0, 0, -5), v3(0, 0, 1), 3)).toBe(false);
    // Nor one that passes beside it.
    expect(bvh.occluded(v3(4, 0, -5), v3(0, 0, 1), 10)).toBe(false);
  });

  it('reports a tree over the triangles it was given', () => {
    const tri = triangulate(box(v3(0, 0, 0), v3(1, 1, 1)), { smoothAngleDegrees: 150 });
    const bvh = new Bvh(tri.positions, tri.indices);
    expect(bvh.stats.triangles).toBe(tri.indices.length / 3);
    expect(bvh.stats.nodes).toBeGreaterThan(0);
  });
});

describe('baked occlusion', () => {
  it('darkens the floor of a pocket far below the open face beside it', () => {
    // A block with a deep square pocket sunk into the top. The floor of the
    // pocket is walled on four sides and can only see straight up; the top face
    // beside it sees the whole sky. Probed at a corner of each, because a
    // boolean leaves vertices at the corners and nowhere else.
    const block = box(v3(0, 0, 0), v3(2, 1, 2));
    const pocket = box(v3(0, 0.25, 0), v3(0.4, 0.9, 0.4));
    const probe = bakeFor(subtract(block, pocket));

    const pocketFloor = probe.at(0.2, -0.2, 0.2);
    const openTop = probe.at(1, 0.5, 1);
    expect(pocketFloor).toBeLessThan(openTop - 0.2);
  });

  it('darkens the crease where two blocks meet', () => {
    const wall = box(v3(0, 0, 0), v3(2, 2, 0.4));
    const floor = box(v3(0, -1, 1), v3(2, 0.4, 2));
    const probe = bakeFor(union(wall, floor));

    const inCorner = probe.at(0, -0.8, 0.25);
    const outInTheOpen = probe.at(0, 0.9, -0.2);
    expect(inCorner).toBeLessThan(outInTheOpen);
  });

  it('leaves an unobstructed surface open', () => {
    const probe = bakeFor(box(v3(0, 0, 0), v3(1, 1, 1)), 64);
    // A convex solid occludes nothing of its own faces beyond the horizon, so
    // every point should be close to fully open.
    expect(probe.at(0, 0.5, 0)).toBeGreaterThan(0.85);
  });

  it('never returns a value outside the floor and one', () => {
    const tri = triangulate(subtract(box(v3(0, 0, 0), v3(2, 2, 2)), box(v3(0, 1, 0), v3(1, 1, 1))), {
      smoothAngleDegrees: 150,
    });
    const baked = bakeVertexOcclusion(tri.positions, tri.normals, tri.indices, { samples: 32, floor: 0.2 });
    for (const value of baked.occlusion) {
      expect(value).toBeGreaterThanOrEqual(0.2 - 1e-6);
      expect(value).toBeLessThanOrEqual(1 + 1e-6);
    }
  });

  it('is deterministic, so an asset rebuilt from a recipe is byte-identical', () => {
    const tri = triangulate(box(v3(0, 0, 0), v3(1, 2, 1)), { smoothAngleDegrees: 150 });
    const first = bakeVertexOcclusion(tri.positions, tri.normals, tri.indices, { samples: 32 });
    const second = bakeVertexOcclusion(tri.positions, tri.normals, tri.indices, { samples: 32 });
    expect(Array.from(first.occlusion)).toEqual(Array.from(second.occlusion));
  });

  it('expands to the RGBA vertex colours glTF multiplies in', () => {
    const colors = occlusionToVertexColors(Float32Array.from([0.5, 1]));
    expect(Array.from(colors)).toEqual([0.5, 0.5, 0.5, 1, 1, 1, 1, 1]);
  });

  it('handles an empty mesh without tracing anything', () => {
    const baked = bakeVertexOcclusion(new Float32Array(0), new Float32Array(0), new Uint32Array(0));
    expect(baked.occlusion.length).toBe(0);
    expect(baked.stats.rays).toBe(0);
  });
});
