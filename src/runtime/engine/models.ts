import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { reportDiagnostic, type Engine, type FrameContext, type System } from './core';

/**
 * Model loading and animation playback.
 *
 * Generated products ship real glTF assets — rigged characters, vehicles with
 * separable wheels, weapons with attachment nodes, circuits with gameplay
 * metadata. This module loads them, wires up an animation mixer per instance,
 * caches by URL so the same asset is parsed once, and exposes named nodes so
 * gameplay code can attach effects without walking the scene graph by hand.
 */

export interface LoadedModel {
  readonly scene: THREE.Group;
  readonly animations: readonly THREE.AnimationClip[];
  readonly nodes: ReadonlyMap<string, THREE.Object3D>;
  readonly bounds: THREE.Box3;
  readonly triangles: number;
}

export interface ModelInstance {
  readonly root: THREE.Group;
  readonly nodes: ReadonlyMap<string, THREE.Object3D>;
  readonly mixer: THREE.AnimationMixer | null;
  /** Cross-fades to a named clip. Returns false if the clip does not exist. */
  play(name: string, options?: { fade?: number; loop?: boolean; speed?: number }): boolean;
  readonly current: string | null;
  update(dt: number): void;
  dispose(): void;
}

const cache = new Map<string, Promise<LoadedModel>>();

function indexNodes(root: THREE.Object3D): Map<string, THREE.Object3D> {
  const nodes = new Map<string, THREE.Object3D>();
  root.traverse((object) => {
    if (object.name) nodes.set(object.name, object);
  });
  return nodes;
}

function countTriangles(root: THREE.Object3D): number {
  let triangles = 0;
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    const geometry = mesh.geometry as THREE.BufferGeometry | undefined;
    if (!geometry) return;
    const count = geometry.index ? geometry.index.count : (geometry.attributes.position?.count ?? 0);
    const instances = (mesh as Partial<THREE.InstancedMesh>).isInstancedMesh ? ((mesh as THREE.InstancedMesh).count ?? 1) : 1;
    triangles += Math.floor(count / 3) * instances;
  });
  return triangles;
}

/** Loads (and caches) a GLB. Meshes are set up for shadows and correct culling. */
export function loadModel(url: string, options: { anisotropy?: number } = {}): Promise<LoadedModel> {
  const existing = cache.get(url);
  if (existing) return existing;

  const promise = new GLTFLoader()
    .loadAsync(url)
    .then((gltf) => {
      const scene = gltf.scene as THREE.Group;
      scene.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) return;
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.frustumCulled = true;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          const standard = material as THREE.MeshStandardMaterial;
          if (standard.map && options.anisotropy) standard.map.anisotropy = options.anisotropy;
          // Generated meshes are closed solids; back-face culling is free performance.
          standard.side = THREE.FrontSide;
        }
      });
      const bounds = new THREE.Box3().setFromObject(scene);
      return { scene, animations: gltf.animations, nodes: indexNodes(scene), bounds, triangles: countTriangles(scene) };
    })
    .catch((error: unknown) => {
      cache.delete(url);
      reportDiagnostic({ type: 'error', payload: { kind: 'model_load_failed', url, message: String(error) } });
      throw error instanceof Error ? error : new Error(String(error));
    });

  cache.set(url, promise);
  return promise;
}

/**
 * Instantiates a loaded model. Skinned meshes are cloned with `SkeletonUtils`
 * semantics — bones are deep-copied and re-bound — so multiple characters can
 * share one download while animating independently.
 */
export function instantiate(model: LoadedModel): ModelInstance {
  const root = cloneSkinned(model.scene) as THREE.Group;
  const nodes = indexNodes(root);
  const mixer = model.animations.length > 0 ? new THREE.AnimationMixer(root) : null;
  const actions = new Map<string, THREE.AnimationAction>();
  if (mixer) {
    for (const clip of model.animations) actions.set(clip.name, mixer.clipAction(clip));
  }
  let current: string | null = null;

  return {
    root,
    nodes,
    mixer,
    get current(): string | null {
      return current;
    },
    play(name, playOptions = {}): boolean {
      const action = actions.get(name);
      if (!action || !mixer) return false;
      if (current === name) return true;
      const fade = playOptions.fade ?? 0.22;
      action.reset();
      action.setLoop(playOptions.loop === false ? THREE.LoopOnce : THREE.LoopRepeat, Infinity);
      action.clampWhenFinished = playOptions.loop === false;
      action.timeScale = playOptions.speed ?? 1;
      action.play();
      const previous = current ? actions.get(current) : null;
      if (previous) previous.crossFadeTo(action, fade, false);
      else action.fadeIn(fade);
      current = name;
      return true;
    },
    update(dt): void {
      mixer?.update(dt);
    },
    dispose(): void {
      mixer?.stopAllAction();
      root.removeFromParent();
    },
  };
}

/**
 * Deep clone that preserves skinning.
 *
 * `Object3D.clone()` shares the skeleton, so every clone would animate
 * identically. This rebuilds the bone hierarchy per clone and rebinds each
 * SkinnedMesh to it.
 */
export function cloneSkinned(source: THREE.Object3D): THREE.Object3D {
  const clone = source.clone(true);
  const sourceBones: THREE.Bone[] = [];
  const clonedBones: THREE.Bone[] = [];

  source.traverse((object) => {
    if ((object as THREE.Bone).isBone) sourceBones.push(object as THREE.Bone);
  });
  clone.traverse((object) => {
    if ((object as THREE.Bone).isBone) clonedBones.push(object as THREE.Bone);
  });

  const skinned: THREE.SkinnedMesh[] = [];
  clone.traverse((object) => {
    if ((object as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(object as THREE.SkinnedMesh);
  });

  for (const mesh of skinned) {
    const originalSkeleton = mesh.skeleton;
    const bones = originalSkeleton.bones.map((bone) => {
      const index = sourceBones.indexOf(bone);
      return index >= 0 ? (clonedBones[index] as THREE.Bone) : bone;
    });
    mesh.bind(new THREE.Skeleton(bones, originalSkeleton.boneInverses), mesh.bindMatrix);
  }
  return clone;
}

/**
 * Level-of-detail helper. Distant instances swap to a decimated variant, which
 * is the single most effective way to keep a populated world inside a mobile
 * draw-call budget.
 */
export class LodGroup extends THREE.LOD {
  constructor(levels: ReadonlyArray<{ object: THREE.Object3D; distance: number }>) {
    super();
    for (const level of levels) this.addLevel(level.object, level.distance);
  }
}

/** Drives every registered animation mixer from the engine's fixed step. */
export class AnimationSystem implements System {
  readonly name = 'animation';
  private readonly instances = new Set<ModelInstance>();

  register(instance: ModelInstance): ModelInstance {
    this.instances.add(instance);
    return instance;
  }

  unregister(instance: ModelInstance): void {
    this.instances.delete(instance);
    instance.dispose();
  }

  update(ctx: FrameContext): void {
    for (const instance of this.instances) instance.update(ctx.dt);
  }

  dispose(): void {
    for (const instance of this.instances) instance.dispose();
    this.instances.clear();
  }
}

/**
 * Loads a manifest of models in parallel and reports progress, so the product
 * can show a real loading bar instead of a spinner of unknown duration.
 */
export async function preloadModels(
  app: Engine,
  manifest: Readonly<Record<string, string>>,
  onProgress?: (loaded: number, total: number, name: string) => void,
): Promise<Record<string, LoadedModel>> {
  const entries = Object.entries(manifest);
  const out: Record<string, LoadedModel> = {};
  let loaded = 0;

  await Promise.all(
    entries.map(async ([name, url]) => {
      try {
        out[name] = await loadModel(url, { anisotropy: app.profile.anisotropy });
      } finally {
        loaded += 1;
        onProgress?.(loaded, entries.length, name);
      }
    }),
  );

  reportDiagnostic({
    type: 'state',
    payload: {
      kind: 'models_loaded',
      count: entries.length,
      triangles: Object.values(out).reduce((sum, model) => sum + model.triangles, 0),
    },
  });
  return out;
}

/** Fetches the gameplay JSON emitted next to a generated model. */
export async function loadModelData<T>(url: string): Promise<T> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`model data ${url} returned HTTP ${response.status}`);
  return (await response.json()) as T;
}
