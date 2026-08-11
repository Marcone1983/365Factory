import { add, length, normalize, scale, sub, v3, type Vec3, type PolyMesh, type Vertex } from '@/lib/graphics/mesh-kernel';
import type { GlbAnimation, GlbAnimationChannel, GlbNode, GlbSkin } from '@/lib/graphics/gltf';

/**
 * Skeleton construction, automatic skin binding and keyframe animation.
 *
 * Characters are rigged the way a character artist would: a joint chain with
 * anatomically placed pivots, per-vertex weights derived from distance to the
 * *bone segment* (not to the joint point, which produces the classic collapsing
 * elbow), and animation authored as rotations about those pivots.
 */

export interface JointSpec {
  readonly name: string;
  readonly parent: string | null;
  /** Rest position in model space. */
  readonly position: Vec3;
  /** Influence radius used when binding skin weights. */
  readonly radius: number;
  /** Excludes the joint from skinning while keeping it as an animation pivot. */
  readonly pivotOnly?: boolean;
}

export interface Skeleton {
  readonly joints: readonly JointSpec[];
  readonly indexOf: ReadonlyMap<string, number>;
  readonly worldPositions: readonly Vec3[];
}

export function buildSkeleton(specs: readonly JointSpec[]): Skeleton {
  const indexOf = new Map<string, number>();
  specs.forEach((spec, index) => indexOf.set(spec.name, index));
  for (const spec of specs) {
    if (spec.parent && !indexOf.has(spec.parent)) {
      throw new Error(`Skeleton: joint "${spec.name}" references unknown parent "${spec.parent}"`);
    }
  }
  return { joints: specs, indexOf, worldPositions: specs.map((s) => s.position) };
}

/** Bone segments used for weight binding: parent position → child position. */
function boneSegments(skeleton: Skeleton): Array<{ jointIndex: number; from: Vec3; to: Vec3; radius: number }> {
  return skeleton.joints.flatMap((joint, index) => {
    if (joint.pivotOnly) return [];
    const parentIndex = joint.parent ? (skeleton.indexOf.get(joint.parent) as number) : -1;
    const from = parentIndex >= 0 ? (skeleton.worldPositions[parentIndex] as Vec3) : joint.position;
    return [{ jointIndex: index, from, to: joint.position, radius: joint.radius }];
  });
}

function distanceToSegment(point: Vec3, a: Vec3, b: Vec3): number {
  const ab = sub(b, a);
  const denominator = Math.max(1e-9, length(ab) ** 2);
  const t = Math.max(0, Math.min(1, ((point.x - a.x) * ab.x + (point.y - a.y) * ab.y + (point.z - a.z) * ab.z) / denominator));
  return length(sub(point, add(a, scale(ab, t))));
}

/**
 * Binds every vertex to its four most influential bones with smooth falloff.
 * Weights are normalised, which glTF requires and which keeps the surface from
 * shrinking during deformation.
 */
export function bindSkin(mesh: PolyMesh, skeleton: Skeleton, options: { maxInfluences?: number; falloff?: number } = {}): void {
  const segments = boneSegments(skeleton);
  if (segments.length === 0) return;
  const maxInfluences = Math.min(4, options.maxInfluences ?? 4);
  const falloff = options.falloff ?? 2.2;

  for (const vertex of mesh.vertices as Vertex[]) {
    const scored = segments
      .map((segment) => {
        const distance = distanceToSegment(vertex.position, segment.from, segment.to);
        const normalised = distance / Math.max(1e-4, segment.radius);
        return { jointIndex: segment.jointIndex, weight: 1 / (1 + normalised ** falloff) };
      })
      .sort((a, b) => b.weight - a.weight)
      .slice(0, maxInfluences);

    const total = scored.reduce((sum, entry) => sum + entry.weight, 0) || 1;
    const joints: [number, number, number, number] = [0, 0, 0, 0];
    const weights: [number, number, number, number] = [0, 0, 0, 0];
    scored.forEach((entry, index) => {
      joints[index] = entry.jointIndex;
      weights[index] = entry.weight / total;
    });
    vertex.joints = joints;
    vertex.weights = weights;
  }
}

/** glTF nodes for the skeleton, offset by `nodeOffset` in the final node array. */
export function skeletonNodes(skeleton: Skeleton, nodeOffset: number): GlbNode[] {
  const childrenOf = new Map<number, number[]>();
  skeleton.joints.forEach((joint, index) => {
    if (!joint.parent) return;
    const parentIndex = skeleton.indexOf.get(joint.parent) as number;
    const list = childrenOf.get(parentIndex) ?? [];
    list.push(index + nodeOffset);
    childrenOf.set(parentIndex, list);
  });

  return skeleton.joints.map((joint, index) => {
    const parentIndex = joint.parent ? (skeleton.indexOf.get(joint.parent) as number) : -1;
    const parentPosition = parentIndex >= 0 ? (skeleton.worldPositions[parentIndex] as Vec3) : v3();
    const local = sub(joint.position, parentPosition);
    const node: GlbNode = {
      name: joint.name,
      translation: [local.x, local.y, local.z],
      children: childrenOf.get(index),
    };
    return node;
  });
}

/**
 * Inverse bind matrices. The rest pose has identity rotations, so the world
 * matrix of a joint is a pure translation and its inverse is the negated
 * translation — column-major as glTF requires.
 */
export function inverseBindMatrices(skeleton: Skeleton): Float32Array {
  const out = new Float32Array(skeleton.joints.length * 16);
  skeleton.joints.forEach((joint, index) => {
    const base = index * 16;
    out[base] = 1;
    out[base + 5] = 1;
    out[base + 10] = 1;
    out[base + 15] = 1;
    out[base + 12] = -joint.position.x;
    out[base + 13] = -joint.position.y;
    out[base + 14] = -joint.position.z;
  });
  return out;
}

export function skinFor(skeleton: Skeleton, nodeOffset: number, name = 'skin'): GlbSkin {
  return {
    name,
    joints: skeleton.joints.map((_joint, index) => index + nodeOffset),
    inverseBindMatrices: inverseBindMatrices(skeleton),
    skeleton: nodeOffset,
  };
}

// ------------------------------------------------------------- animation ----

export type Quaternion = [number, number, number, number];

export function quaternionFromEuler(pitch: number, yaw: number, roll: number): Quaternion {
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);
  return [
    sr * cp * cy - cr * sp * sy,
    cr * sp * cy + sr * cp * sy,
    cr * cp * sy - sr * sp * cy,
    cr * cp * cy + sr * sp * sy,
  ];
}

export function quaternionFromAxisAngle(axis: Vec3, angle: number): Quaternion {
  const n = normalize(axis);
  const half = angle / 2;
  const s = Math.sin(half);
  return [n.x * s, n.y * s, n.z * s, Math.cos(half)];
}

export interface JointCurve {
  readonly joint: string;
  /** Euler rotation in radians evaluated at a normalised time 0..1. */
  readonly rotation: (phase: number) => { pitch: number; yaw: number; roll: number };
  readonly translation?: (phase: number) => Vec3;
}

export interface AnimationSpec {
  readonly name: string;
  readonly durationSeconds: number;
  readonly keyframes: number;
  readonly loop?: boolean;
  readonly curves: readonly JointCurve[];
}

/** Samples the declarative curves into glTF animation channels. */
export function bakeAnimation(spec: AnimationSpec, skeleton: Skeleton, nodeOffset: number): GlbAnimation {
  const channels: GlbAnimationChannel[] = [];
  const frames = Math.max(2, spec.keyframes);
  const times = new Float32Array(frames);
  for (let i = 0; i < frames; i += 1) times[i] = (i / (frames - 1)) * spec.durationSeconds;

  for (const curve of spec.curves) {
    const jointIndex = skeleton.indexOf.get(curve.joint);
    if (jointIndex === undefined) continue;

    const rotations = new Float32Array(frames * 4);
    for (let i = 0; i < frames; i += 1) {
      const phase = i / (frames - 1);
      const euler = curve.rotation(phase);
      const q = quaternionFromEuler(euler.pitch, euler.yaw, euler.roll);
      rotations.set(q, i * 4);
    }
    channels.push({ node: jointIndex + nodeOffset, path: 'rotation', times, values: rotations });

    if (curve.translation) {
      const joint = skeleton.joints[jointIndex] as JointSpec;
      const parentIndex = joint.parent ? (skeleton.indexOf.get(joint.parent) as number) : -1;
      const parentPosition = parentIndex >= 0 ? (skeleton.worldPositions[parentIndex] as Vec3) : v3();
      const rest = sub(joint.position, parentPosition);
      const translations = new Float32Array(frames * 3);
      for (let i = 0; i < frames; i += 1) {
        const offset = curve.translation(i / (frames - 1));
        translations[i * 3] = rest.x + offset.x;
        translations[i * 3 + 1] = rest.y + offset.y;
        translations[i * 3 + 2] = rest.z + offset.z;
      }
      channels.push({ node: jointIndex + nodeOffset, path: 'translation', times, values: translations });
    }
  }

  return { name: spec.name, channels };
}
