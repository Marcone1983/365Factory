import { z } from 'zod';

/**
 * The modelling language the AI writes.
 *
 * This is the core of the asset pipeline. Rather than calling a hand-written
 * generator per category — which caps the platform at the categories someone
 * remembered to write — the model emits a *recipe*: a validated description of
 * how to build the object out of the kernel's operators. The interpreter
 * executes it. Nothing the model produces is ever evaluated as code; it selects
 * operations from a fixed vocabulary and supplies numbers.
 *
 * The vocabulary is deliberately the one a modeller thinks in. An LLM has read
 * enormous amounts about how objects are actually shaped, and that knowledge
 * comes out far more reliably as "the tail tapers to 38% of the body width over
 * the last quarter of its length" than as pixels. Extracting it as measured
 * parameters is what makes an arbitrary object possible.
 *
 * Every numeric range is bounded. A recipe cannot ask for a million segments or
 * a negative radius, so a malformed or adversarial recipe fails validation
 * rather than exhausting memory.
 */

const finite = (min: number, max: number): z.ZodNumber => z.number().finite().min(min).max(max);

/** Coordinates are in metres. Bounded so a recipe cannot place geometry at infinity. */
const Vec3Schema = z.tuple([finite(-5000, 5000), finite(-5000, 5000), finite(-5000, 5000)]);

const Point2Schema = z.object({ x: finite(-1000, 1000), y: finite(-1000, 1000) });

// ------------------------------------------------------------------ curves --

const CurveSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('line'),
    from: Vec3Schema,
    to: Vec3Schema,
  }),
  z.object({
    type: z.literal('bezier'),
    p0: Vec3Schema,
    p1: Vec3Schema,
    p2: Vec3Schema,
    p3: Vec3Schema,
  }),
  z.object({
    type: z.literal('spline'),
    /** Passes through every point; the natural way to describe an organic path. */
    points: z.array(Vec3Schema).min(2).max(64),
    closed: z.boolean().default(false),
  }),
  z.object({
    type: z.literal('helix'),
    radius: finite(0.0001, 500),
    height: finite(-500, 500),
    turns: finite(-40, 40),
    axis: Vec3Schema.default([0, 1, 0]),
  }),
]);

// ---------------------------------------------------------------- profiles --

const ProfileSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('ellipse'),
    radiusX: finite(0.0001, 500),
    radiusY: finite(0.0001, 500),
    segments: z.number().int().min(3).max(96).default(16),
  }),
  z.object({
    type: z.literal('rectangle'),
    width: finite(0.0001, 500),
    height: finite(0.0001, 500),
    cornerRadius: finite(0, 250).default(0),
    segments: z.number().int().min(4).max(96).default(16),
  }),
  z.object({
    /**
     * Superellipse: one exponent moves the outline continuously from a diamond
     * through an ellipse to a rounded rectangle. It is the single most useful
     * profile for hard-surface work because real sections are almost never
     * exactly elliptical.
     */
    type: z.literal('superellipse'),
    radiusX: finite(0.0001, 500),
    radiusY: finite(0.0001, 500),
    exponent: finite(0.4, 12).default(2.5),
    segments: z.number().int().min(4).max(96).default(20),
  }),
  z.object({
    type: z.literal('polygon'),
    points: z.array(Point2Schema).min(3).max(128),
  }),
]);

/**
 * A scalar that varies along a parameter.
 *
 * Constant, a keyframed curve, or one of a few named shapes. This is how a
 * recipe says "the stem tapers" or "the fuselage bulges over the wing" without
 * needing an expression language — which would be code, and code is exactly
 * what the model must not be able to supply.
 */
const VaryingSchema = z.union([
  finite(-1000, 1000),
  z.object({
    keys: z
      .array(z.object({ t: finite(0, 1), value: finite(-1000, 1000) }))
      .min(2)
      .max(32),
  }),
  z.object({
    shape: z.enum(['linear', 'easeIn', 'easeOut', 'bell', 'sCurve']),
    from: finite(-1000, 1000),
    to: finite(-1000, 1000),
    /** Where a bell peaks, or how sharply the ease bends. */
    bias: finite(0.01, 8).default(1),
  }),
]);

// ------------------------------------------------------------------- steps --

const TransformSchema = z.object({
  translate: Vec3Schema.optional(),
  rotate: z.object({ axis: Vec3Schema, degrees: finite(-3600, 3600) }).optional(),
  scale: z.union([finite(-100, 100), Vec3Schema]).optional(),
});

/** A named part the recipe builds and can then reference, array or cut with. */
const StepSchema = z.discriminatedUnion('op', [
  z.object({
    op: z.literal('sweep'),
    id: z.string().min(1).max(64),
    curve: CurveSchema,
    profile: ProfileSchema,
    segments: z.number().int().min(2).max(400).default(24),
    scaleAlong: VaryingSchema.optional(),
    twistDegrees: VaryingSchema.optional(),
    capStart: z.boolean().default(true),
    capEnd: z.boolean().default(true),
    material: z.string().min(1).max(48),
  }),
  z.object({
    op: z.literal('revolve'),
    id: z.string().min(1).max(64),
    /** Half-outline in the XY plane; revolved about Y. */
    outline: z.array(Point2Schema).min(2).max(128),
    segments: z.number().int().min(3).max(128).default(24),
    sweepDegrees: finite(1, 360).default(360),
    material: z.string().min(1).max(48),
  }),
  z.object({
    op: z.literal('loft'),
    id: z.string().min(1).max(64),
    /** Cross-sections along a path; the workhorse for vehicles and hulls. */
    sections: z
      .array(z.object({ at: Vec3Schema, profile: ProfileSchema }))
      .min(2)
      .max(128),
    closeRing: z.boolean().default(true),
    capStart: z.boolean().default(true),
    capEnd: z.boolean().default(true),
    material: z.string().min(1).max(48),
  }),
  z.object({
    op: z.literal('primitive'),
    id: z.string().min(1).max(64),
    shape: z.enum(['box', 'sphere', 'cylinder']),
    centre: Vec3Schema.default([0, 0, 0]),
    size: Vec3Schema.default([1, 1, 1]),
    /** Sphere and cylinder radius; ignored for a box. */
    radius: finite(0.0001, 500).default(0.5),
    segments: z.number().int().min(3).max(96).default(20),
    material: z.string().min(1).max(48),
  }),
  z.object({
    op: z.literal('array'),
    id: z.string().min(1).max(64),
    source: z.string().min(1).max(64),
    kind: z.enum(['linear', 'radial', 'alongCurve']),
    count: z.number().int().min(1).max(512),
    /** linear: the step between copies. */
    step: Vec3Schema.optional(),
    /** radial: the axis, the ring radius, how far round, and the tilt out. */
    axis: Vec3Schema.default([0, 1, 0]),
    radius: finite(0, 500).default(0),
    sweepDegrees: finite(-3600, 3600).default(360),
    tiltDegrees: VaryingSchema.optional(),
    /** alongCurve: the path to distribute along. */
    curve: CurveSchema.optional(),
    align: z.boolean().default(true),
    scaleAlong: VaryingSchema.optional(),
  }),
  z.object({
    op: z.literal('boolean'),
    id: z.string().min(1).max(64),
    mode: z.enum(['union', 'subtract', 'intersect']),
    base: z.string().min(1).max(64),
    tools: z.array(z.string().min(1).max(64)).min(1).max(24),
  }),
  z.object({
    op: z.literal('deform'),
    id: z.string().min(1).max(64),
    source: z.string().min(1).max(64),
    kind: z.enum(['bend', 'twist', 'taper', 'displace']),
    axis: z.enum(['x', 'y', 'z']).default('y'),
    /** bend: about which axis; ignored otherwise. */
    about: z.enum(['x', 'y', 'z']).default('x'),
    amount: finite(-100, 100).default(1),
    /** taper: how the profile scales toward the far end. */
    exponent: finite(0.1, 8).default(1),
    /** displace: noise frequency. */
    frequency: finite(0.01, 200).default(4),
  }),
  z.object({
    op: z.literal('transform'),
    id: z.string().min(1).max(64),
    source: z.string().min(1).max(64),
    apply: TransformSchema,
  }),
  z.object({
    op: z.literal('mirror'),
    id: z.string().min(1).max(64),
    source: z.string().min(1).max(64),
    axis: z.enum(['x', 'y', 'z']).default('x'),
  }),
  z.object({
    op: z.literal('merge'),
    id: z.string().min(1).max(64),
    sources: z.array(z.string().min(1).max(64)).min(1).max(64),
  }),
]);

// ------------------------------------------------------------------ recipe --

/**
 * Material families map to the PBR synthesiser, so a recipe names the *kind* of
 * surface and the synthesiser produces albedo, normal and ORM maps for it. A
 * recipe cannot supply texture data directly, which keeps every asset's
 * materials consistent with the rest of the product.
 */
export const MATERIAL_FAMILIES = [
  'car_paint',
  'glass',
  'rubber',
  'metal_brushed',
  'metal_worn',
  'asphalt',
  'concrete',
  'sand',
  'skin',
  'hair',
  'fabric',
  'leather',
  'emissive_panel',
  'grass',
  'rock',
  'bark',
] as const;

const MaterialSchema = z.object({
  id: z.string().min(1).max(48),
  family: z.enum(MATERIAL_FAMILIES),
  /** Index into the caller's palette; the recipe never hardcodes a colour. */
  colorIndex: z.number().int().min(0).max(15).default(0),
  roughness: finite(0, 1).optional(),
  metallic: finite(0, 1).optional(),
  clearcoat: finite(0, 1).optional(),
  transmission: finite(0, 1).optional(),
  emissiveStrength: finite(0, 40).optional(),
  /** Texture resolution relative to the asset's base size. */
  textureScale: finite(0.125, 2).default(1),
});

export const AssetRecipeSchema = z.object({
  name: z.string().min(1).max(96),
  /** What the recipe is meant to depict; carried into validation and logs. */
  description: z.string().min(1).max(400),
  /** Overall size the finished asset should occupy, in metres. */
  targetSize: Vec3Schema,
  /** Higher values subdivide more; bounded because cost is 4^level. */
  smoothness: z.number().int().min(0).max(2).default(1),
  /** Angle above which an edge stays hard when normals are computed. */
  smoothAngleDegrees: finite(1, 180).default(50),
  uvProjection: z.enum(['box', 'cylindrical']).default('box'),
  uvScale: finite(0.01, 40).default(1),
  materials: z.array(MaterialSchema).min(1).max(12),
  steps: z.array(StepSchema).min(1).max(120),
  /** Which step ids form the finished asset. */
  outputs: z.array(z.string().min(1).max(64)).min(1).max(32),
});

export type AssetRecipe = z.infer<typeof AssetRecipeSchema>;
export type RecipeStep = z.infer<typeof StepSchema>;
export type RecipeCurve = z.infer<typeof CurveSchema>;
export type RecipeProfile = z.infer<typeof ProfileSchema>;
export type RecipeMaterial = z.infer<typeof MaterialSchema>;
export type Varying = z.infer<typeof VaryingSchema>;
export type MaterialFamilyName = (typeof MATERIAL_FAMILIES)[number];

/**
 * Checks the references a schema cannot: every step that names another step
 * must name one that exists and was built earlier, and every output and
 * material reference must resolve. A dangling reference is a recipe that would
 * silently build a partial asset, which is worse than one that fails.
 */
export function validateReferences(recipe: AssetRecipe): string[] {
  const problems: string[] = [];
  const built = new Set<string>();
  const materials = new Set(recipe.materials.map((m) => m.id));

  for (const [index, step] of recipe.steps.entries()) {
    if (built.has(step.id)) problems.push(`step ${index} reuses the id "${step.id}"`);

    const referenced: string[] =
      step.op === 'boolean'
        ? [step.base, ...step.tools]
        : step.op === 'merge'
          ? step.sources
          : 'source' in step
            ? [step.source]
            : [];

    for (const reference of referenced) {
      if (!built.has(reference)) {
        problems.push(`step "${step.id}" references "${reference}", which is not built before it`);
      }
    }

    if ('material' in step && !materials.has(step.material)) {
      problems.push(`step "${step.id}" uses material "${step.material}", which is not declared`);
    }
    if (step.op === 'array' && step.kind === 'linear' && !step.step) {
      problems.push(`step "${step.id}" is a linear array with no step vector`);
    }
    if (step.op === 'array' && step.kind === 'alongCurve' && !step.curve) {
      problems.push(`step "${step.id}" is an alongCurve array with no curve`);
    }
    built.add(step.id);
  }

  for (const output of recipe.outputs) {
    if (!built.has(output)) problems.push(`output "${output}" is not built by any step`);
  }
  return problems;
}
