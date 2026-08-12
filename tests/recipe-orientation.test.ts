import { describe, expect, it } from 'vitest';
import { AssetRecipeSchema, type AssetRecipe } from '@/lib/generation/recipe/schema';
import { interpretRecipe } from '@/lib/generation/recipe/interpreter';

/**
 * Two defects that made the interpreter build something other than the recipe
 * it was given, and that no amount of AI repair could have fixed — because the
 * recipe was already right.
 *
 * Both were invisible from the outside. A recipe is scaled to its targetSize
 * before it is exported, so a body laid flat on the road still fills its
 * bounding box and still looks like a plausible number of triangles; only the
 * render showed a blade with discs floating beside it, and the reviewer had no
 * vocabulary to say why. These tests measure the geometry directly, with the
 * fit disabled, which is where the lie was visible all along.
 */

const BRIEF = {
  subject: 'A test body used to measure how the interpreter orients geometry',
  style: 'Untextured engineering geometry with no stylistic intent whatsoever.',
  purpose: 'Exists to be measured, at any distance, by a test.',
  mustRead: ['a long low body', 'wider than it is tall', 'a flat underside'],
  silhouette: 'A long low wedge seen from the side.',
  proportions: ['about four times as long as it is wide'],
  surfaceNotes: 'Plain, unpainted, matte.',
  avoid: ['a body laid flat on its side', 'sections that do not square up to the rail'],
  acceptance: ['the body is longer than it is wide', 'the body is wider than it is tall'],
};

function parse(recipe: unknown): AssetRecipe {
  return AssetRecipeSchema.parse(recipe);
}

/** Bounds of the interpreted geometry, with the target-size fit turned off. */
function measure(recipe: AssetRecipe): { size: [number, number, number]; min: [number, number, number] } {
  const result = interpretRecipe(recipe, { seed: 1, fit: false });
  const positions = result.triangulated.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis += 1) {
      const value = positions[i + axis] as number;
      if (value < (min[axis] as number)) min[axis] = value;
      if (value > (max[axis] as number)) max[axis] = value;
    }
  }
  return { size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]], min };
}

/** A body lofted nose to tail along X: four metres long, one wide, half a metre tall. */
const LOFTED_BODY = parse({
  name: 'lofted_body',
  description: 'A body lofted along the X axis, to check the section frame.',
  brief: BRIEF,
  targetSize: [4, 0.5, 1],
  smoothness: 0,
  materials: [{ id: 'steel', family: 'metal_brushed', colorIndex: 0 }],
  steps: [
    {
      id: 'body',
      op: 'loft',
      note: 'Four rectangular sections along the X axis; each is 1m wide across the car and 0.5m tall.',
      sections: [
        { at: [0, 0.25, 0], profile: { type: 'rectangle', width: 1, height: 0.5, cornerRadius: 0.05, segments: 12 } },
        { at: [1.3, 0.25, 0], profile: { type: 'rectangle', width: 1, height: 0.5, cornerRadius: 0.05, segments: 12 } },
        { at: [2.7, 0.25, 0], profile: { type: 'rectangle', width: 1, height: 0.5, cornerRadius: 0.05, segments: 12 } },
        { at: [4, 0.25, 0], profile: { type: 'rectangle', width: 1, height: 0.5, cornerRadius: 0.05, segments: 12 } },
      ],
      closeRing: true,
      capStart: true,
      capEnd: true,
      material: 'steel',
    },
  ],
  outputs: ['body'],
});

/** The same sections, lofted along Z instead, which is the case that always worked. */
const LOFTED_ACROSS = parse({
  ...LOFTED_BODY,
  name: 'lofted_across',
  targetSize: [1, 0.5, 4],
  steps: [
    {
      ...(LOFTED_BODY.steps[0] as Record<string, unknown>),
      sections: [
        { at: [0, 0.25, 0], profile: { type: 'rectangle', width: 1, height: 0.5, cornerRadius: 0.05, segments: 12 } },
        { at: [0, 0.25, 1.3], profile: { type: 'rectangle', width: 1, height: 0.5, cornerRadius: 0.05, segments: 12 } },
        { at: [0, 0.25, 2.7], profile: { type: 'rectangle', width: 1, height: 0.5, cornerRadius: 0.05, segments: 12 } },
        { at: [0, 0.25, 4], profile: { type: 'rectangle', width: 1, height: 0.5, cornerRadius: 0.05, segments: 12 } },
      ],
    },
  ],
});

describe('loft section orientation', () => {
  it('squares each section to the rail when the rail runs along X', () => {
    // The bug: right was forced to X, which pointed straight down this rail.
    // The section's width then ran along the body's length and its height
    // collapsed to nothing, so a 4 x 0.5 x 1 body came out 5 x 0.14 x 0.5.
    const { size } = measure(LOFTED_BODY);
    expect(size[0]).toBeCloseTo(4, 2);
    expect(size[1]).toBeCloseTo(0.5, 2);
    expect(size[2]).toBeCloseTo(1, 2);
  });

  it('still squares each section to the rail when the rail runs along Z', () => {
    const { size } = measure(LOFTED_ACROSS);
    expect(size[0]).toBeCloseTo(1, 2);
    expect(size[1]).toBeCloseTo(0.5, 2);
    expect(size[2]).toBeCloseTo(4, 2);
  });

  it('keeps a body the right way up whichever way it is lofted', () => {
    // Height is the axis that vanished, so it is the one worth stating twice:
    // in both directions the section's height is vertical and its width is
    // across the rail, never along it.
    const along = measure(LOFTED_BODY);
    const across = measure(LOFTED_ACROSS);
    expect(along.size[1]).toBeCloseTo(across.size[1], 5);
    expect(along.min[1]).toBeCloseTo(0, 2);
  });
});

/** A disc revolved about the vertical axis, then stood up and moved, as a wheel is. */
const WHEEL = parse({
  name: 'standing_wheel',
  description: 'A revolved disc rotated upright, to check that transform.rotate rotates.',
  brief: BRIEF,
  targetSize: [0.7, 0.7, 0.3],
  smoothness: 0,
  materials: [{ id: 'rubber', family: 'rubber', colorIndex: 0 }],
  steps: [
    {
      id: 'disc',
      op: 'revolve',
      note: 'A flat disc 0.7m across and 0.2m thick, lying down as a revolve about the vertical axis produces it.',
      outline: [
        { x: 0.05, y: 0 },
        { x: 0.35, y: 0 },
        { x: 0.35, y: 0.2 },
        { x: 0.05, y: 0.2 },
      ],
      segments: 24,
      sweepDegrees: 360,
      material: 'rubber',
    },
    {
      id: 'upright',
      op: 'transform',
      note: 'Stand the disc up so its axle points across the vehicle instead of at the sky.',
      source: 'disc',
      apply: { rotate: { axis: [1, 0, 0], degrees: 90 } },
    },
    {
      id: 'placed',
      op: 'transform',
      note: 'Move the standing wheel out to the axle position, which must happen after the rotation.',
      source: 'upright',
      apply: { translate: [2, 0.35, 0.8] },
    },
  ],
  outputs: ['placed'],
});

describe('the transform step', () => {
  it('actually rotates, which a one-instance radial array never did', () => {
    const { size } = measure(WHEEL);
    // Lying down the disc is 0.7 x 0.2 x 0.7; standing up it is 0.7 x 0.7 x 0.2.
    expect(size[0]).toBeCloseTo(0.7, 2);
    expect(size[1]).toBeCloseTo(0.7, 2);
    expect(size[2]).toBeCloseTo(0.2, 2);
  });

  it('rotates about the origin and then translates, in that order', () => {
    const { min } = measure(WHEEL);
    // Rotating after the move would have swung the wheel two metres through
    // the air; rotating first leaves it centred on the axle it was sent to.
    expect(min[0]).toBeCloseTo(2 - 0.35, 2);
    expect(min[1]).toBeCloseTo(0, 2);
    // The disc's thickness ran from y=0 to y=0.2 before the rotation, so after
    // it the wheel occupies z=0.8 to z=1.0 — the near face exactly on the axle
    // plane it was sent to.
    expect(min[2]).toBeCloseTo(0.8, 2);
  });
});
