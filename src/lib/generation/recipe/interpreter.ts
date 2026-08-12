import {
  PolyMesh,
  ellipseProfile,
  projectBoxUvs,
  projectCylindricalUvs,
  revolve,
  roundedRectProfile,
  subdivide,
  superellipseProfile,
  triangulate,
  v3,
  loft as loftMesh,
  type Station,
  type Vec3,
} from '@/lib/graphics/mesh-kernel';
import { box, cylinder, sphere, subtractAll, union, intersect } from '@/lib/graphics/csg';
import {
  arrayAlongCurve,
  arrayLinear,
  arrayRadial,
  bend,
  bezier,
  catmullRom,
  displace,
  helix,
  lineCurve,
  mirror,
  sweep,
  taper,
  twist,
  type Curve,
} from '@/lib/graphics/shape-ops';
import type { AssetRecipe, RecipeCurve, RecipeProfile, RecipeStep, Varying } from './schema';
import { validateReferences } from './schema';

/**
 * Executes an asset recipe.
 *
 * Every operation is looked up in a fixed table; nothing in the recipe is
 * evaluated as code. A recipe is data that selects behaviour, which is the same
 * boundary the chat tools and the scheduler enforce.
 *
 * The interpreter is deliberately strict. A step that references a missing part,
 * produces empty geometry, or blows past the triangle budget stops the build
 * with a diagnostic naming the step. A partially built asset that looks almost
 * right is far more expensive to deal with than one that refuses to build.
 */

export class RecipeError extends Error {
  readonly code = 'RECIPE_ERROR';
  constructor(
    message: string,
    readonly step?: string,
  ) {
    super(message);
    this.name = 'RecipeError';
  }
}

/**
 * What one step cost, before subdivision.
 *
 * A recipe that breaches the triangle budget has to be told *which* step to
 * economise on, or the only available repair is to lower smoothness globally
 * and lose the quality everywhere. Booleans in particular are unpredictable:
 * a cut through a dense surface can multiply the face count, and this is what
 * makes that visible instead of a mystery.
 */
export interface StepCost {
  readonly id: string;
  readonly op: string;
  readonly faces: number;
}

export interface InterpretResult {
  readonly mesh: PolyMesh;
  readonly triangulated: ReturnType<typeof triangulate>;
  /** Material id per slot index, in the order the GLB will carry them. */
  readonly materialOrder: readonly string[];
  readonly triangleCount: number;
  readonly warnings: readonly string[];
  readonly stepCosts: readonly StepCost[];
  readonly stats: {
    readonly steps: number;
    readonly vertices: number;
    readonly durationMs: number;
  };
}

/** Hard ceiling. A recipe that exceeds this is refused rather than shipped. */
const MAX_TRIANGLES = 400_000;
const MAX_VERTICES_PER_STEP = 400_000;

function toVec(value: readonly [number, number, number]): Vec3 {
  return v3(value[0], value[1], value[2]);
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Resolves a varying scalar into a function of t. */
function varying(value: Varying | undefined, fallback: number): (t: number) => number {
  if (value === undefined) return () => fallback;
  if (typeof value === 'number') return () => value;

  if ('keys' in value) {
    const keys = [...value.keys].sort((a, b) => a.t - b.t);
    return (t) => {
      if (t <= (keys[0] as { t: number }).t) return (keys[0] as { value: number }).value;
      const last = keys[keys.length - 1] as { t: number; value: number };
      if (t >= last.t) return last.value;
      for (let i = 0; i + 1 < keys.length; i += 1) {
        const a = keys[i] as { t: number; value: number };
        const b = keys[i + 1] as { t: number; value: number };
        if (t >= a.t && t <= b.t) {
          const span = b.t - a.t;
          const local = span < 1e-9 ? 0 : (t - a.t) / span;
          return a.value + (b.value - a.value) * local;
        }
      }
      return last.value;
    };
  }

  const { shape, from, to, bias } = value;
  return (t) => {
    const clamped = Math.min(1, Math.max(0, t));
    let factor: number;
    switch (shape) {
      case 'easeIn':
        factor = clamped ** bias;
        break;
      case 'easeOut':
        factor = 1 - (1 - clamped) ** bias;
        break;
      case 'bell':
        // Peaks at `bias` rather than always at the midpoint, so a recipe can
        // say where a fuselage is widest.
        factor = Math.sin(Math.PI * Math.min(1, Math.max(0, clamped))) ** (1 / bias);
        break;
      case 'sCurve':
        factor = clamped * clamped * (3 - 2 * clamped);
        break;
      case 'linear':
      default:
        factor = clamped;
        break;
    }
    return from + (to - from) * factor;
  };
}

function buildCurve(spec: RecipeCurve): Curve {
  switch (spec.type) {
    case 'line':
      return lineCurve(toVec(spec.from), toVec(spec.to));
    case 'bezier':
      return bezier(toVec(spec.p0), toVec(spec.p1), toVec(spec.p2), toVec(spec.p3));
    case 'spline':
      return catmullRom(spec.points.map(toVec), spec.closed);
    case 'helix':
      return helix(spec.radius, spec.height, spec.turns, toVec(spec.axis));
  }
}

function buildProfile(spec: RecipeProfile): Array<{ x: number; y: number }> {
  switch (spec.type) {
    case 'ellipse':
      return ellipseProfile(spec.radiusX, spec.radiusY, spec.segments);
    case 'rectangle':
      return roundedRectProfile(spec.width, spec.height, spec.cornerRadius, spec.segments);
    case 'superellipse':
      return superellipseProfile(spec.radiusX, spec.radiusY, spec.exponent, spec.segments);
    case 'polygon':
      return spec.points.map((point) => ({ x: point.x, y: point.y }));
  }
}

function requireMesh(parts: Map<string, PolyMesh>, id: string, step: string): PolyMesh {
  const mesh = parts.get(id);
  if (!mesh) throw new RecipeError(`step "${step}" needs part "${id}", which was not built`, step);
  return mesh;
}

function runStep(step: RecipeStep, parts: Map<string, PolyMesh>, slotOf: (id: string) => number, seed: number): PolyMesh {
  switch (step.op) {
    case 'sweep': {
      const scaleAt = varying(step.scaleAlong, 1);
      const twistAt = varying(step.twistDegrees, 0);
      return sweep(buildCurve(step.curve), buildProfile(step.profile), {
        segments: step.segments,
        scaleAt,
        twistAt: (t) => radians(twistAt(t)),
        capStart: step.capStart,
        capEnd: step.capEnd,
        material: slotOf(step.material),
      });
    }

    case 'revolve':
      return revolve(
        step.outline.map((point) => ({ x: point.x, y: point.y })),
        step.segments,
        radians(step.sweepDegrees),
        slotOf(step.material),
      );

    case 'loft': {
      const stations: Station[] = step.sections.map((section) => ({
        center: toVec(section.at),
        profile: buildProfile(section.profile),
        right: v3(1, 0, 0),
        up: v3(0, 1, 0),
        material: slotOf(step.material),
      }));
      const ring = stations[0]?.profile.length ?? 0;
      if (stations.some((station) => station.profile.length !== ring)) {
        throw new RecipeError(
          `step "${step.id}" lofts sections with different point counts; every section must use the same profile segments`,
          step.id,
        );
      }
      return loftMesh(stations, {
        closeRing: step.closeRing,
        capStart: step.capStart,
        capEnd: step.capEnd,
        material: slotOf(step.material),
      });
    }

    case 'primitive': {
      const material = slotOf(step.material);
      const centre = toVec(step.centre);
      if (step.shape === 'box') return box(centre, toVec(step.size), material);
      if (step.shape === 'sphere') return sphere(centre, step.radius, step.segments, Math.max(3, Math.floor(step.segments / 2)), material);
      const half = step.size[1] / 2;
      return cylinder(
        v3(centre.x, centre.y - half, centre.z),
        v3(centre.x, centre.y + half, centre.z),
        step.radius,
        step.segments,
        material,
      );
    }

    case 'array': {
      const source = requireMesh(parts, step.source, step.id);
      if (step.kind === 'linear') {
        if (!step.step) throw new RecipeError(`step "${step.id}" is a linear array with no step vector`, step.id);
        return arrayLinear(source, step.count, toVec(step.step));
      }
      if (step.kind === 'radial') {
        const tiltAt = step.tiltDegrees ? varying(step.tiltDegrees, 0) : undefined;
        return arrayRadial(source, step.count, toVec(step.axis), {
          radius: step.radius,
          sweep: radians(step.sweepDegrees),
          ...(tiltAt ? { tiltAt: (_i: number, t: number) => radians(tiltAt(t)) } : {}),
        });
      }
      if (!step.curve) throw new RecipeError(`step "${step.id}" is an alongCurve array with no curve`, step.id);
      const scaleAt = step.scaleAlong ? varying(step.scaleAlong, 1) : undefined;
      return arrayAlongCurve(source, buildCurve(step.curve), step.count, {
        align: step.align,
        ...(scaleAt ? { scaleAt } : {}),
      });
    }

    case 'boolean': {
      const base = requireMesh(parts, step.base, step.id);
      const tools = step.tools.map((id) => requireMesh(parts, id, step.id));
      if (step.mode === 'subtract') return subtractAll(base, tools);
      let result = base;
      for (const tool of tools) result = step.mode === 'union' ? union(result, tool) : intersect(result, tool);
      return result;
    }

    case 'deform': {
      const source = requireMesh(parts, step.source, step.id);
      switch (step.kind) {
        case 'bend':
          return bend(source, { along: step.axis, about: step.about, angle: radians(step.amount) });
        case 'twist':
          return twist(source, step.axis, step.amount);
        case 'taper':
          return taper(source, step.axis, step.amount, step.exponent);
        case 'displace':
          return displace(source, { amplitude: step.amount, frequency: step.frequency, seed });
      }
      break;
    }

    case 'transform': {
      const source = requireMesh(parts, step.source, step.id).clone();
      const { apply } = step;
      if (apply.scale !== undefined) {
        const s = typeof apply.scale === 'number' ? v3(apply.scale, apply.scale, apply.scale) : toVec(apply.scale);
        for (const vertex of source.vertices) {
          vertex.position = v3(vertex.position.x * s.x, vertex.position.y * s.y, vertex.position.z * s.z);
        }
      }
      if (apply.rotate) {
        // A rotation is expressed as a one-instance radial array, which is the
        // same code path the arrays use and therefore the same behaviour.
        const rotated = arrayRadial(source, 1, toVec(apply.rotate.axis), { sweep: radians(apply.rotate.degrees) * 2 });
        source.vertices.length = 0;
        source.faces.length = 0;
        source.merge(rotated);
      }
      if (apply.translate) source.translate(toVec(apply.translate));
      return source;
    }

    case 'mirror':
      return mirror(requireMesh(parts, step.source, step.id), step.axis);

    case 'merge': {
      const merged = new PolyMesh();
      for (const id of step.sources) merged.merge(requireMesh(parts, id, step.id));
      return merged;
    }
  }
  throw new RecipeError('unreachable step kind');
}

/** Scales the finished asset so it occupies the size the recipe asked for. */
function fitToTarget(mesh: PolyMesh, target: Vec3): void {
  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;
  for (const vertex of mesh.vertices) {
    const p = vertex.position;
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.z < minZ) minZ = p.z;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
    if (p.z > maxZ) maxZ = p.z;
  }
  if (minX === Infinity) return;

  const size = [maxX - minX, maxY - minY, maxZ - minZ];
  const wanted = [target.x, target.y, target.z];
  // One uniform factor, taken from the axis that would overflow most. Scaling
  // each axis independently would distort a model the recipe got right.
  let factor = Infinity;
  for (let axis = 0; axis < 3; axis += 1) {
    const current = size[axis] as number;
    const want = wanted[axis] as number;
    if (current > 1e-9 && want > 1e-9) factor = Math.min(factor, want / current);
  }
  if (!Number.isFinite(factor) || factor <= 0) return;

  for (const vertex of mesh.vertices) {
    vertex.position = v3(vertex.position.x * factor, vertex.position.y * factor, vertex.position.z * factor);
  }
}

export function interpretRecipe(recipe: AssetRecipe, options: { seed?: number } = {}): InterpretResult {
  const started = Date.now();
  const referenceProblems = validateReferences(recipe);
  if (referenceProblems.length > 0) {
    throw new RecipeError(`the recipe does not resolve: ${referenceProblems.join('; ')}`);
  }

  const materialOrder = recipe.materials.map((material) => material.id);
  const slotOf = (id: string): number => {
    const index = materialOrder.indexOf(id);
    if (index < 0) throw new RecipeError(`material "${id}" is not declared`);
    return index;
  };

  const parts = new Map<string, PolyMesh>();
  const warnings: string[] = [];
  const stepCosts: StepCost[] = [];
  const seed = options.seed ?? 0;

  for (const step of recipe.steps) {
    const mesh = runStep(step, parts, slotOf, seed);
    stepCosts.push({ id: step.id, op: step.op, faces: mesh.faces.length });
    if (mesh.vertices.length === 0) {
      warnings.push(`step "${step.id}" produced no geometry`);
    }
    if (mesh.vertices.length > MAX_VERTICES_PER_STEP) {
      throw new RecipeError(
        `step "${step.id}" produced ${mesh.vertices.length} vertices, over the ${MAX_VERTICES_PER_STEP} limit`,
        step.id,
      );
    }
    parts.set(step.id, mesh);
  }

  const assembled = new PolyMesh();
  for (const output of recipe.outputs) {
    assembled.merge(requireMesh(parts, output, 'outputs'));
  }
  if (assembled.faces.length === 0) {
    throw new RecipeError('the recipe produced no geometry at all');
  }

  fitToTarget(assembled, toVec(recipe.targetSize));

  if (recipe.uvProjection === 'cylindrical') projectCylindricalUvs(assembled, recipe.uvScale);
  else projectBoxUvs(assembled, recipe.uvScale);

  const smoothed = subdivide(assembled, recipe.smoothness);
  const triangulated = triangulate(smoothed, { smoothAngleDegrees: recipe.smoothAngleDegrees });
  const triangleCount = triangulated.indices.length / 3;

  if (triangleCount > MAX_TRIANGLES) {
    // Name the steps that actually cost the budget. "Reduce segment counts" with
    // no target is advice the author cannot act on when eighty steps are in play.
    const worst = [...stepCosts]
      .sort((a, b) => b.faces - a.faces)
      .slice(0, 5)
      .map((cost) => `"${cost.id}" (${cost.op}, ${cost.faces} faces)`)
      .join(', ');
    throw new RecipeError(
      `the recipe produced ${Math.round(triangleCount)} triangles, over the ${MAX_TRIANGLES} budget; ` +
        `the most expensive steps are ${worst}. Lower smoothness, reduce their segment counts, ` +
        `or replace a boolean on a dense surface with a merge.`,
    );
  }

  return {
    mesh: smoothed,
    triangulated,
    materialOrder,
    triangleCount,
    warnings,
    stepCosts,
    stats: {
      steps: recipe.steps.length,
      vertices: smoothed.vertices.length,
      durationMs: Date.now() - started,
    },
  };
}
