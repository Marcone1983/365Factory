import {
  PolyMesh,
  add,
  cross,
  dot,
  length,
  loft,
  normalize,
  scale,
  sub,
  v3,
  type Station,
  type Vec3,
} from './mesh-kernel';

/**
 * Shape operators.
 *
 * These are the verbs a modeller actually uses, and between them they cover the
 * asset categories a game needs without a bespoke generator per category: a
 * flower stem and a handrail are both a swept profile along a curve, a colonnade
 * and a row of windows are both a linear array, petals and wheel spokes are both
 * a radial array, and a tree is an L-system whose branches are swept curves.
 *
 * Everything here composes: the output of each operator is a PolyMesh, which is
 * the input of every other operator and of the boolean kernel.
 */

// ------------------------------------------------------------------ curves --

export interface Curve {
  /** Position at parameter t ∈ [0, 1]. */
  at(t: number): Vec3;
  /** Unit tangent at t. */
  tangent(t: number): Vec3;
}

function numericTangent(curve: { at(t: number): Vec3 }, t: number): Vec3 {
  const h = 1e-4;
  const a = curve.at(Math.max(0, t - h));
  const b = curve.at(Math.min(1, t + h));
  const d = sub(b, a);
  return length(d) < 1e-9 ? v3(0, 0, 1) : normalize(d);
}

/** Cubic Bézier. */
export function bezier(p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3): Curve {
  const at = (t: number): Vec3 => {
    const u = 1 - t;
    const a = u * u * u;
    const b = 3 * u * u * t;
    const c = 3 * u * t * t;
    const d = t * t * t;
    return v3(
      a * p0.x + b * p1.x + c * p2.x + d * p3.x,
      a * p0.y + b * p1.y + c * p2.y + d * p3.y,
      a * p0.z + b * p1.z + c * p2.z + d * p3.z,
    );
  };
  return {
    at,
    tangent(t: number): Vec3 {
      const u = 1 - t;
      const d = v3(
        3 * u * u * (p1.x - p0.x) + 6 * u * t * (p2.x - p1.x) + 3 * t * t * (p3.x - p2.x),
        3 * u * u * (p1.y - p0.y) + 6 * u * t * (p2.y - p1.y) + 3 * t * t * (p3.y - p2.y),
        3 * u * u * (p1.z - p0.z) + 6 * u * t * (p2.z - p1.z) + 3 * t * t * (p3.z - p2.z),
      );
      return length(d) < 1e-9 ? numericTangent({ at }, t) : normalize(d);
    },
  };
}

/** Catmull-Rom spline through every control point. */
export function catmullRom(points: readonly Vec3[], closed = false): Curve {
  const list = points.length >= 2 ? points : [v3(), v3(0, 0, 1)];
  const count = list.length;

  const sample = (index: number): Vec3 => {
    if (closed) return list[((index % count) + count) % count] as Vec3;
    return list[Math.max(0, Math.min(count - 1, index))] as Vec3;
  };

  const at = (t: number): Vec3 => {
    const span = closed ? count : count - 1;
    const scaled = Math.min(0.999999, Math.max(0, t)) * span;
    const i = Math.floor(scaled);
    const f = scaled - i;

    const p0 = sample(i - 1);
    const p1 = sample(i);
    const p2 = sample(i + 1);
    const p3 = sample(i + 2);

    const f2 = f * f;
    const f3 = f2 * f;
    const axis = (a: number, b: number, c: number, d: number): number =>
      0.5 * ((2 * b) + (-a + c) * f + (2 * a - 5 * b + 4 * c - d) * f2 + (-a + 3 * b - 3 * c + d) * f3);

    return v3(axis(p0.x, p1.x, p2.x, p3.x), axis(p0.y, p1.y, p2.y, p3.y), axis(p0.z, p1.z, p2.z, p3.z));
  };

  return { at, tangent: (t) => numericTangent({ at }, t) };
}

/** Helix: springs, spiral staircases, coiled cable, climbing plants. */
export function helix(radius: number, height: number, turns: number, axis: Vec3 = v3(0, 1, 0)): Curve {
  const up = normalize(axis);
  const reference = Math.abs(up.y) > 0.9 ? v3(1, 0, 0) : v3(0, 1, 0);
  const u = normalize(cross(reference, up));
  const w = cross(up, u);

  const at = (t: number): Vec3 => {
    const angle = t * turns * Math.PI * 2;
    return add(
      add(scale(u, Math.cos(angle) * radius), scale(w, Math.sin(angle) * radius)),
      scale(up, t * height),
    );
  };
  return { at, tangent: (t) => numericTangent({ at }, t) };
}

/** Straight line; the degenerate curve that makes sweeps uniform to write. */
export function lineCurve(from: Vec3, to: Vec3): Curve {
  const direction = sub(to, from);
  const unit = length(direction) < 1e-9 ? v3(0, 0, 1) : normalize(direction);
  return { at: (t) => add(from, scale(direction, t)), tangent: () => unit };
}

// ------------------------------------------------------------------- sweep --

export interface SweepOptions {
  readonly segments?: number;
  /** Profile scale as a function of t; tapering stems, bulging vases. */
  readonly scaleAt?: (t: number) => number;
  /** Extra roll about the tangent, in radians. */
  readonly twistAt?: (t: number) => number;
  readonly capStart?: boolean;
  readonly capEnd?: boolean;
  readonly closeRing?: boolean;
  readonly material?: number;
}

/**
 * Sweeps a 2D profile along a 3D curve.
 *
 * Frames are propagated by parallel transport rather than taken from the
 * Frenet-Serret formulas. Frenet frames flip whenever the curve passes through
 * an inflection point — a stem that bends one way and then the other — and the
 * swept surface tears itself inside out at that point. Parallel transport
 * carries the previous frame forward with the minimum rotation that keeps it
 * perpendicular to the new tangent, so it is stable through inflections and
 * straight sections alike.
 */
export function sweep(
  curve: Curve,
  profile: ReadonlyArray<{ x: number; y: number }>,
  options: SweepOptions = {},
): PolyMesh {
  const segments = Math.max(2, Math.min(400, options.segments ?? 24));
  const stations: Station[] = [];

  let normal: Vec3 | null = null;
  let previousTangent: Vec3 | null = null;

  for (let i = 0; i < segments; i += 1) {
    const t = i / (segments - 1);
    const centre = curve.at(t);
    const tangent = curve.tangent(t);

    if (!normal || !previousTangent) {
      const reference = Math.abs(tangent.y) > 0.9 ? v3(1, 0, 0) : v3(0, 1, 0);
      normal = normalize(cross(reference, tangent));
    } else {
      // Rotate the previous normal by the same rotation that takes the previous
      // tangent to this one — the minimum-twist transport.
      const axis = cross(previousTangent, tangent);
      const sinAngle = length(axis);
      if (sinAngle > 1e-8) {
        const unitAxis = scale(axis, 1 / sinAngle);
        const cosAngle = Math.max(-1, Math.min(1, dot(previousTangent, tangent)));
        const angle = Math.atan2(sinAngle, cosAngle);
        normal = rotateAbout(normal, unitAxis, angle);
      }
      // Re-orthogonalise against drift accumulated over many segments.
      normal = normalize(sub(normal, scale(tangent, dot(normal, tangent))));
    }
    previousTangent = tangent;

    const roll = options.twistAt?.(t) ?? 0;
    const right = roll === 0 ? normal : rotateAbout(normal, tangent, roll);
    const up = cross(tangent, right);
    const factor = options.scaleAt?.(t) ?? 1;

    stations.push({
      center: centre,
      profile: profile.map((point) => ({ x: point.x * factor, y: point.y * factor })),
      right,
      up,
      material: options.material ?? 0,
    });
  }

  return loft(stations, {
    closeRing: options.closeRing ?? true,
    capStart: options.capStart ?? true,
    capEnd: options.capEnd ?? true,
    material: options.material ?? 0,
  });
}

function rotateAbout(vector: Vec3, axis: Vec3, angle: number): Vec3 {
  // Rodrigues' rotation formula.
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return add(
    add(scale(vector, c), scale(cross(axis, vector), s)),
    scale(axis, dot(axis, vector) * (1 - c)),
  );
}

// ------------------------------------------------------------------ arrays --

export interface Transform {
  readonly translate?: Vec3;
  readonly rotate?: { axis: Vec3; angle: number };
  readonly scale?: Vec3 | number;
}

function applyTransform(mesh: PolyMesh, transform: Transform): PolyMesh {
  const copy = mesh.clone();
  if (transform.scale !== undefined) {
    const s = typeof transform.scale === 'number'
      ? v3(transform.scale, transform.scale, transform.scale)
      : transform.scale;
    for (const vertex of copy.vertices) {
      vertex.position = v3(vertex.position.x * s.x, vertex.position.y * s.y, vertex.position.z * s.z);
    }
  }
  if (transform.rotate) {
    const axis = normalize(transform.rotate.axis);
    for (const vertex of copy.vertices) {
      vertex.position = rotateAbout(vertex.position, axis, transform.rotate.angle);
    }
  }
  if (transform.translate) {
    copy.translate(transform.translate);
  }
  return copy;
}

/** Repeats a mesh along a direction: colonnades, fences, window bays, railings. */
export function arrayLinear(mesh: PolyMesh, count: number, step: Vec3, jitter?: (i: number) => Transform): PolyMesh {
  const out = new PolyMesh();
  const total = Math.max(1, Math.min(512, Math.floor(count)));
  for (let i = 0; i < total; i += 1) {
    const base: Transform = { translate: scale(step, i) };
    const extra = jitter?.(i);
    let instance = applyTransform(mesh, extra ?? {});
    instance = applyTransform(instance, base);
    out.merge(instance);
  }
  return out;
}

/** Repeats a mesh around an axis: petals, spokes, turbine blades, arcades. */
export function arrayRadial(
  mesh: PolyMesh,
  count: number,
  axis: Vec3 = v3(0, 1, 0),
  options: { radius?: number; sweep?: number; tiltAt?: (i: number, t: number) => number } = {},
): PolyMesh {
  const out = new PolyMesh();
  const total = Math.max(1, Math.min(512, Math.floor(count)));
  const unit = normalize(axis);
  const arc = options.sweep ?? Math.PI * 2;
  const full = Math.abs(arc - Math.PI * 2) < 1e-6;

  const reference = Math.abs(unit.y) > 0.9 ? v3(1, 0, 0) : v3(0, 1, 0);
  const outward = normalize(cross(reference, unit));
  // Tilting must happen about the axis perpendicular to both the array axis and
  // the outward direction. Rotating about `outward` itself leans the instance in
  // a plane the subsequent radial offset does not lie in, so a flower opens on
  // one plane while its petals are placed on another and the head shears apart.
  const tiltAxis = normalize(cross(unit, outward));

  for (let i = 0; i < total; i += 1) {
    const t = total === 1 ? 0 : i / (full ? total : total - 1);
    const angle = t * arc;

    let instance = mesh.clone();
    const tilt = options.tiltAt?.(i, t);
    if (tilt) {
      instance = applyTransform(instance, { rotate: { axis: tiltAxis, angle: tilt } });
    }
    if (options.radius) instance.translate(scale(outward, options.radius));
    instance = applyTransform(instance, { rotate: { axis: unit, angle } });
    out.merge(instance);
  }
  return out;
}

/** Places copies along a curve, oriented to it: hedges, streetlights, beads. */
export function arrayAlongCurve(
  mesh: PolyMesh,
  curve: Curve,
  count: number,
  options: { align?: boolean; scaleAt?: (t: number) => number } = {},
): PolyMesh {
  const out = new PolyMesh();
  const total = Math.max(1, Math.min(512, Math.floor(count)));

  for (let i = 0; i < total; i += 1) {
    const t = total === 1 ? 0 : i / (total - 1);
    let instance = mesh.clone();

    const factor = options.scaleAt?.(t);
    if (factor !== undefined) instance = applyTransform(instance, { scale: factor });

    if (options.align !== false) {
      const tangent = curve.tangent(t);
      const from = v3(0, 0, 1);
      const axis = cross(from, tangent);
      const sinAngle = length(axis);
      if (sinAngle > 1e-8) {
        const angle = Math.atan2(sinAngle, Math.max(-1, Math.min(1, dot(from, tangent))));
        instance = applyTransform(instance, { rotate: { axis: scale(axis, 1 / sinAngle), angle } });
      }
    }
    instance.translate(curve.at(t));
    out.merge(instance);
  }
  return out;
}

/** Mirrors across a plane through the origin and unions the halves. */
export function mirror(mesh: PolyMesh, axis: 'x' | 'y' | 'z'): PolyMesh {
  const out = mesh.clone();
  const flipped = mesh.clone();
  for (const vertex of flipped.vertices) {
    const p = vertex.position;
    vertex.position = axis === 'x' ? v3(-p.x, p.y, p.z) : axis === 'y' ? v3(p.x, -p.y, p.z) : v3(p.x, p.y, -p.z);
  }
  // Mirroring reverses winding; reversing each face restores outward normals.
  for (const face of flipped.faces) face.vertices.reverse();
  out.merge(flipped);
  return out;
}

// -------------------------------------------------------------- deformers --

export type Axis = 'x' | 'y' | 'z';

function axisValue(p: Vec3, axis: Axis): number {
  return axis === 'x' ? p.x : axis === 'y' ? p.y : p.z;
}

function extent(mesh: PolyMesh, axis: Axis): { min: number; max: number } {
  let min = Infinity;
  let max = -Infinity;
  for (const vertex of mesh.vertices) {
    const value = axisValue(vertex.position, axis);
    if (value < min) min = value;
    if (value > max) max = value;
  }
  return { min: min === Infinity ? 0 : min, max: max === -Infinity ? 0 : max };
}

/** Bends a mesh about an axis: arches, curved roofs, drooping petals. */
export function bend(mesh: PolyMesh, options: { along: Axis; about: Axis; angle: number }): PolyMesh {
  const out = mesh.clone();
  const span = extent(out, options.along);
  const range = span.max - span.min;
  if (range < 1e-9 || Math.abs(options.angle) < 1e-9) return out;

  const radius = range / options.angle;
  for (const vertex of out.vertices) {
    const p = vertex.position;
    const s = axisValue(p, options.along) - span.min;
    const theta = s / radius;

    // Distance from the bend axis, measured on the third axis.
    const third: Axis = options.along !== 'x' && options.about !== 'x' ? 'x' : options.along !== 'y' && options.about !== 'y' ? 'y' : 'z';
    const offset = axisValue(p, third);
    const r = radius - offset;

    const bentAlong = r * Math.sin(theta);
    const bentThird = radius - r * Math.cos(theta);

    const next = { x: p.x, y: p.y, z: p.z };
    next[options.along] = span.min + bentAlong;
    next[third] = bentThird;
    vertex.position = v3(next.x, next.y, next.z);
  }
  return out;
}

/** Twists a mesh about an axis: barley-sugar columns, drill bits, horns. */
export function twist(mesh: PolyMesh, axis: Axis, turns: number): PolyMesh {
  const out = mesh.clone();
  const span = extent(out, axis);
  const range = span.max - span.min;
  if (range < 1e-9) return out;

  const unit = axis === 'x' ? v3(1, 0, 0) : axis === 'y' ? v3(0, 1, 0) : v3(0, 0, 1);
  for (const vertex of out.vertices) {
    const t = (axisValue(vertex.position, axis) - span.min) / range;
    vertex.position = rotateAbout(vertex.position, unit, t * turns * Math.PI * 2);
  }
  return out;
}

/** Tapers a mesh along an axis: table legs, spires, tree trunks. */
export function taper(mesh: PolyMesh, axis: Axis, endScale: number, curveExponent = 1): PolyMesh {
  const out = mesh.clone();
  const span = extent(out, axis);
  const range = span.max - span.min;
  if (range < 1e-9) return out;

  for (const vertex of out.vertices) {
    const p = vertex.position;
    const t = (axisValue(p, axis) - span.min) / range;
    const factor = 1 + (endScale - 1) * t ** curveExponent;
    const next = { x: p.x * factor, y: p.y * factor, z: p.z * factor };
    next[axis] = axisValue(p, axis);
    vertex.position = v3(next.x, next.y, next.z);
  }
  return out;
}

/**
 * Displaces vertices along a smooth pseudo-random field.
 *
 * This is what turns a clean cylinder into a tree trunk and a smooth plane into
 * terrain. The field is deterministic in the seed, so the same asset request
 * always produces the same asset.
 */
export function displace(mesh: PolyMesh, options: { amplitude: number; frequency: number; seed: number }): PolyMesh {
  const out = mesh.clone();
  const noise = valueNoise(options.seed);

  for (const vertex of out.vertices) {
    const p = vertex.position;
    const f = options.frequency;
    const offset = noise(p.x * f, p.y * f, p.z * f) * options.amplitude;
    const direction = length(p) < 1e-9 ? v3(0, 1, 0) : normalize(p);
    vertex.position = add(p, scale(direction, offset));
  }
  return out;
}

/** Trilinearly interpolated value noise; smooth, seedable and dependency-free. */
export function valueNoise(seed: number): (x: number, y: number, z: number) => number {
  const hash = (x: number, y: number, z: number): number => {
    let h = seed ^ (x * 374761393) ^ (y * 668265263) ^ (z * 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967295 - 0.5;
  };
  const fade = (t: number): number => t * t * (3 - 2 * t);

  return (x, y, z) => {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    const zi = Math.floor(z);
    const xf = fade(x - xi);
    const yf = fade(y - yi);
    const zf = fade(z - zi);

    let result = 0;
    for (let dx = 0; dx <= 1; dx += 1) {
      for (let dy = 0; dy <= 1; dy += 1) {
        for (let dz = 0; dz <= 1; dz += 1) {
          const weight =
            (dx ? xf : 1 - xf) * (dy ? yf : 1 - yf) * (dz ? zf : 1 - zf);
          result += hash(xi + dx, yi + dy, zi + dz) * weight;
        }
      }
    }
    return result * 2;
  };
}

/** Fractal sum of value noise: terrain, bark, rock, cloth wrinkles. */
export function fbm(seed: number, octaves = 4, lacunarity = 2, gain = 0.5): (x: number, y: number, z: number) => number {
  const noise = valueNoise(seed);
  return (x, y, z) => {
    let sum = 0;
    let amplitude = 1;
    let frequency = 1;
    let normalisation = 0;
    for (let i = 0; i < octaves; i += 1) {
      sum += noise(x * frequency, y * frequency, z * frequency) * amplitude;
      normalisation += amplitude;
      amplitude *= gain;
      frequency *= lacunarity;
    }
    return normalisation > 0 ? sum / normalisation : 0;
  };
}
