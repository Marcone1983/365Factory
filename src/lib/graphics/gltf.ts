/**
 * glTF 2.0 binary (.glb) writer and reader.
 *
 * Supports everything a shippable game asset needs: multi-primitive meshes,
 * PBR metallic-roughness materials with embedded albedo / normal / ORM /
 * emissive textures, a node hierarchy, skinned meshes with inverse bind
 * matrices, and keyframe animations. Output loads unmodified in three.js,
 * Blender, Babylon and the Android/iOS model viewers.
 */

export interface MeshPrimitiveData {
  readonly name: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs?: Float32Array;
  readonly tangents?: Float32Array;
  readonly joints?: Uint16Array;
  readonly weights?: Float32Array;
  readonly indices: Uint32Array;
  readonly materialIndex: number;
}

export interface GltfTextureRef {
  /** Index into `GlbInput.textures`. */
  readonly texture: number;
  readonly uvSet?: number;
  readonly scale?: number;
}

export interface GltfMaterial {
  readonly name: string;
  /** Linear RGBA base colour, components 0..1. */
  readonly baseColor: readonly [number, number, number, number];
  readonly metallic: number;
  readonly roughness: number;
  readonly emissive?: readonly [number, number, number];
  readonly emissiveStrength?: number;
  readonly doubleSided?: boolean;
  readonly alphaMode?: 'OPAQUE' | 'MASK' | 'BLEND';
  readonly alphaCutoff?: number;
  readonly baseColorTexture?: GltfTextureRef;
  /** Occlusion (R) / roughness (G) / metallic (B) packed texture. */
  readonly metallicRoughnessTexture?: GltfTextureRef;
  readonly normalTexture?: GltfTextureRef;
  readonly occlusionTexture?: GltfTextureRef;
  readonly emissiveTexture?: GltfTextureRef;
  /** KHR_materials_clearcoat — car paint, varnished surfaces. */
  readonly clearcoat?: number;
  readonly clearcoatRoughness?: number;
  /** KHR_materials_transmission — glass. */
  readonly transmission?: number;
  readonly ior?: number;
}

export interface GlbTexture {
  readonly name: string;
  /** PNG bytes, embedded in the binary chunk. */
  readonly png: Buffer;
  /** sRGB for colour maps; linear for normal/ORM data maps. */
  readonly srgb: boolean;
  readonly wrap?: 'repeat' | 'clamp';
}

export interface GlbMesh {
  readonly name: string;
  readonly primitives: readonly MeshPrimitiveData[];
}

export interface GlbNode {
  readonly name: string;
  readonly mesh?: number;
  readonly skin?: number;
  readonly children?: readonly number[];
  readonly translation?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number, number];
  readonly scale?: readonly [number, number, number];
}

export interface GlbSkin {
  readonly name: string;
  readonly joints: readonly number[];
  /** Row-major 4x4 matrices, one per joint, flattened. */
  readonly inverseBindMatrices: Float32Array;
  readonly skeleton?: number;
}

export type AnimationPath = 'translation' | 'rotation' | 'scale';

export interface GlbAnimationChannel {
  readonly node: number;
  readonly path: AnimationPath;
  readonly times: Float32Array;
  /** vec3 for translation/scale, vec4 quaternion for rotation. */
  readonly values: Float32Array;
  readonly interpolation?: 'LINEAR' | 'STEP';
}

export interface GlbAnimation {
  readonly name: string;
  readonly channels: readonly GlbAnimationChannel[];
}

export interface GlbInput {
  readonly generator: string;
  readonly meshes: readonly GlbMesh[];
  readonly materials: readonly GltfMaterial[];
  readonly textures?: readonly GlbTexture[];
  readonly nodes?: readonly GlbNode[];
  readonly skins?: readonly GlbSkin[];
  readonly animations?: readonly GlbAnimation[];
  /** Node indices forming the scene root. Defaults to every parentless node. */
  readonly roots?: readonly number[];
}

const COMPONENT_FLOAT = 5126;
const COMPONENT_UINT = 5125;
const COMPONENT_USHORT = 5123;
const TARGET_ARRAY_BUFFER = 34962;
const TARGET_ELEMENT_ARRAY_BUFFER = 34963;

function align4(value: number): number {
  return (value + 3) & ~3;
}

function bounds(data: Float32Array, stride: number): { min: number[]; max: number[] } {
  const min = new Array<number>(stride).fill(Number.POSITIVE_INFINITY);
  const max = new Array<number>(stride).fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < data.length; i += stride) {
    for (let c = 0; c < stride; c += 1) {
      const value = data[i + c] as number;
      if (value < (min[c] as number)) min[c] = value;
      if (value > (max[c] as number)) max[c] = value;
    }
  }
  return { min, max };
}

function typedBuffer(array: Float32Array | Uint32Array | Uint16Array): Buffer {
  return Buffer.from(array.buffer, array.byteOffset, array.byteLength);
}

export function writeGlb(input: GlbInput): Buffer {
  const bufferChunks: Buffer[] = [];
  const bufferViews: Array<Record<string, number>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  let byteOffset = 0;

  const pushView = (data: Buffer, target?: number): number => {
    const padding = align4(byteOffset) - byteOffset;
    if (padding > 0) {
      bufferChunks.push(Buffer.alloc(padding));
      byteOffset += padding;
    }
    const view: Record<string, number> = { buffer: 0, byteOffset, byteLength: data.length };
    if (target !== undefined) view.target = target;
    bufferViews.push(view);
    bufferChunks.push(data);
    byteOffset += data.length;
    return bufferViews.length - 1;
  };

  const pushAccessor = (accessor: Record<string, unknown>): number => {
    accessors.push(accessor);
    return accessors.length - 1;
  };

  // ---------------------------------------------------------------- images --
  const images: Array<Record<string, unknown>> = [];
  const samplers: Array<Record<string, unknown>> = [];
  const textures: Array<Record<string, unknown>> = [];
  const samplerCache = new Map<string, number>();

  for (const texture of input.textures ?? []) {
    const view = pushView(texture.png);
    images.push({ name: texture.name, mimeType: 'image/png', bufferView: view });
    const wrapMode = texture.wrap === 'clamp' ? 33071 : 10497;
    const samplerKey = String(wrapMode);
    let samplerIndex = samplerCache.get(samplerKey);
    if (samplerIndex === undefined) {
      samplers.push({ magFilter: 9729, minFilter: 9987, wrapS: wrapMode, wrapT: wrapMode });
      samplerIndex = samplers.length - 1;
      samplerCache.set(samplerKey, samplerIndex);
    }
    textures.push({ name: texture.name, source: images.length - 1, sampler: samplerIndex });
  }

  // ---------------------------------------------------------------- meshes --
  const meshes: Array<Record<string, unknown>> = [];

  for (const mesh of input.meshes) {
    const primitives: Array<Record<string, unknown>> = [];
    for (const primitive of mesh.primitives) {
      const vertexCount = primitive.positions.length / 3;
      if (primitive.normals.length !== primitive.positions.length) {
        throw new Error(`glTF export: normal count mismatch in "${primitive.name}"`);
      }
      if (primitive.uvs && primitive.uvs.length !== vertexCount * 2) {
        throw new Error(`glTF export: uv count mismatch in "${primitive.name}"`);
      }
      if (primitive.joints && primitive.joints.length !== vertexCount * 4) {
        throw new Error(`glTF export: joint count mismatch in "${primitive.name}"`);
      }
      for (const index of primitive.indices) {
        if (index >= vertexCount) throw new Error(`glTF export: index ${index} out of range in "${primitive.name}"`);
      }

      const positionBounds = bounds(primitive.positions, 3);
      const attributes: Record<string, number> = {
        POSITION: pushAccessor({
          bufferView: pushView(typedBuffer(primitive.positions), TARGET_ARRAY_BUFFER),
          componentType: COMPONENT_FLOAT,
          count: vertexCount,
          type: 'VEC3',
          min: positionBounds.min,
          max: positionBounds.max,
        }),
        NORMAL: pushAccessor({
          bufferView: pushView(typedBuffer(primitive.normals), TARGET_ARRAY_BUFFER),
          componentType: COMPONENT_FLOAT,
          count: vertexCount,
          type: 'VEC3',
        }),
      };

      if (primitive.uvs) {
        attributes.TEXCOORD_0 = pushAccessor({
          bufferView: pushView(typedBuffer(primitive.uvs), TARGET_ARRAY_BUFFER),
          componentType: COMPONENT_FLOAT,
          count: vertexCount,
          type: 'VEC2',
        });
      }
      if (primitive.tangents) {
        attributes.TANGENT = pushAccessor({
          bufferView: pushView(typedBuffer(primitive.tangents), TARGET_ARRAY_BUFFER),
          componentType: COMPONENT_FLOAT,
          count: vertexCount,
          type: 'VEC4',
        });
      }
      if (primitive.joints && primitive.weights) {
        attributes.JOINTS_0 = pushAccessor({
          bufferView: pushView(typedBuffer(primitive.joints), TARGET_ARRAY_BUFFER),
          componentType: COMPONENT_USHORT,
          count: vertexCount,
          type: 'VEC4',
        });
        attributes.WEIGHTS_0 = pushAccessor({
          bufferView: pushView(typedBuffer(primitive.weights), TARGET_ARRAY_BUFFER),
          componentType: COMPONENT_FLOAT,
          count: vertexCount,
          type: 'VEC4',
        });
      }

      const indexAccessor = pushAccessor({
        bufferView: pushView(typedBuffer(primitive.indices), TARGET_ELEMENT_ARRAY_BUFFER),
        componentType: COMPONENT_UINT,
        count: primitive.indices.length,
        type: 'SCALAR',
      });

      primitives.push({ attributes, indices: indexAccessor, material: primitive.materialIndex, mode: 4 });
    }
    meshes.push({ name: mesh.name, primitives });
  }

  // ----------------------------------------------------------------- skins --
  const skins: Array<Record<string, unknown>> = [];
  for (const skin of input.skins ?? []) {
    if (skin.inverseBindMatrices.length !== skin.joints.length * 16) {
      throw new Error(`glTF export: skin "${skin.name}" has ${skin.joints.length} joints but ${skin.inverseBindMatrices.length / 16} bind matrices`);
    }
    const accessor = pushAccessor({
      bufferView: pushView(typedBuffer(skin.inverseBindMatrices)),
      componentType: COMPONENT_FLOAT,
      count: skin.joints.length,
      type: 'MAT4',
    });
    const record: Record<string, unknown> = { name: skin.name, joints: [...skin.joints], inverseBindMatrices: accessor };
    if (skin.skeleton !== undefined) record.skeleton = skin.skeleton;
    skins.push(record);
  }

  // ------------------------------------------------------------ animations --
  const animations: Array<Record<string, unknown>> = [];
  for (const animation of input.animations ?? []) {
    const channels: Array<Record<string, unknown>> = [];
    const animationSamplers: Array<Record<string, unknown>> = [];
    for (const channel of animation.channels) {
      const stride = channel.path === 'rotation' ? 4 : 3;
      if (channel.values.length !== channel.times.length * stride) {
        throw new Error(`glTF export: animation "${animation.name}" channel has ${channel.times.length} keys but ${channel.values.length} values`);
      }
      const timeBounds = bounds(channel.times, 1);
      const inputAccessor = pushAccessor({
        bufferView: pushView(typedBuffer(channel.times)),
        componentType: COMPONENT_FLOAT,
        count: channel.times.length,
        type: 'SCALAR',
        min: timeBounds.min,
        max: timeBounds.max,
      });
      const outputAccessor = pushAccessor({
        bufferView: pushView(typedBuffer(channel.values)),
        componentType: COMPONENT_FLOAT,
        count: channel.times.length,
        type: stride === 4 ? 'VEC4' : 'VEC3',
      });
      animationSamplers.push({ input: inputAccessor, output: outputAccessor, interpolation: channel.interpolation ?? 'LINEAR' });
      channels.push({ sampler: animationSamplers.length - 1, target: { node: channel.node, path: channel.path } });
    }
    animations.push({ name: animation.name, samplers: animationSamplers, channels });
  }

  // ----------------------------------------------------------------- nodes --
  const nodeInputs: readonly GlbNode[] =
    input.nodes ?? input.meshes.map((mesh, index) => ({ name: mesh.name, mesh: index }));
  const nodes = nodeInputs.map((node) => {
    const record: Record<string, unknown> = { name: node.name };
    if (node.mesh !== undefined) record.mesh = node.mesh;
    if (node.skin !== undefined) record.skin = node.skin;
    if (node.children?.length) record.children = [...node.children];
    if (node.translation) record.translation = node.translation;
    if (node.rotation) record.rotation = node.rotation;
    if (node.scale) record.scale = node.scale;
    return record;
  });

  const childIndices = new Set<number>();
  for (const node of nodeInputs) for (const child of node.children ?? []) childIndices.add(child);
  const roots = input.roots ?? nodeInputs.map((_node, index) => index).filter((index) => !childIndices.has(index));

  // ------------------------------------------------------------- materials --
  const usedExtensions = new Set<string>();
  const materials = input.materials.map((material) => {
    const pbr: Record<string, unknown> = {
      baseColorFactor: material.baseColor,
      metallicFactor: material.metallic,
      roughnessFactor: material.roughness,
    };
    if (material.baseColorTexture) pbr.baseColorTexture = textureRef(material.baseColorTexture);
    if (material.metallicRoughnessTexture) pbr.metallicRoughnessTexture = textureRef(material.metallicRoughnessTexture);

    const record: Record<string, unknown> = {
      name: material.name,
      doubleSided: material.doubleSided ?? false,
      pbrMetallicRoughness: pbr,
      emissiveFactor: material.emissive ?? [0, 0, 0],
      alphaMode: material.alphaMode ?? 'OPAQUE',
    };
    if (material.alphaMode === 'MASK') record.alphaCutoff = material.alphaCutoff ?? 0.5;
    if (material.normalTexture) {
      record.normalTexture = { ...textureRef(material.normalTexture), scale: material.normalTexture.scale ?? 1 };
    }
    if (material.occlusionTexture) record.occlusionTexture = textureRef(material.occlusionTexture);
    if (material.emissiveTexture) record.emissiveTexture = textureRef(material.emissiveTexture);

    const extensions: Record<string, unknown> = {};
    if (material.emissiveStrength !== undefined && material.emissiveStrength !== 1) {
      extensions.KHR_materials_emissive_strength = { emissiveStrength: material.emissiveStrength };
      usedExtensions.add('KHR_materials_emissive_strength');
    }
    if (material.clearcoat !== undefined && material.clearcoat > 0) {
      extensions.KHR_materials_clearcoat = {
        clearcoatFactor: material.clearcoat,
        clearcoatRoughnessFactor: material.clearcoatRoughness ?? 0.1,
      };
      usedExtensions.add('KHR_materials_clearcoat');
    }
    if (material.transmission !== undefined && material.transmission > 0) {
      extensions.KHR_materials_transmission = { transmissionFactor: material.transmission };
      usedExtensions.add('KHR_materials_transmission');
      if (material.ior !== undefined) {
        extensions.KHR_materials_ior = { ior: material.ior };
        usedExtensions.add('KHR_materials_ior');
      }
    }
    if (Object.keys(extensions).length > 0) record.extensions = extensions;
    return record;
  });

  function textureRef(ref: GltfTextureRef): Record<string, number> {
    const record: Record<string, number> = { index: ref.texture };
    if (ref.uvSet) record.texCoord = ref.uvSet;
    return record;
  }

  // ------------------------------------------------------------------ json --
  const json: Record<string, unknown> = {
    asset: { version: '2.0', generator: input.generator },
    scene: 0,
    scenes: [{ nodes: roots }],
    nodes,
    meshes,
    materials,
    accessors,
    bufferViews,
    buffers: [{ byteLength: align4(byteOffset) }],
  };
  if (images.length > 0) {
    json.images = images;
    json.samplers = samplers;
    json.textures = textures;
  }
  if (skins.length > 0) json.skins = skins;
  if (animations.length > 0) json.animations = animations;
  if (usedExtensions.size > 0) json.extensionsUsed = [...usedExtensions];

  const binaryPadding = align4(byteOffset) - byteOffset;
  if (binaryPadding > 0) bufferChunks.push(Buffer.alloc(binaryPadding));
  const binaryChunk = Buffer.concat(bufferChunks);

  let jsonChunk = Buffer.from(JSON.stringify(json), 'utf8');
  const jsonPadding = align4(jsonChunk.length) - jsonChunk.length;
  if (jsonPadding > 0) jsonChunk = Buffer.concat([jsonChunk, Buffer.alloc(jsonPadding, 0x20)]);

  const header = Buffer.alloc(12);
  header.write('glTF', 0, 'ascii');
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binaryChunk.length, 8);

  const jsonHeader = Buffer.alloc(8);
  jsonHeader.writeUInt32LE(jsonChunk.length, 0);
  jsonHeader.write('JSON', 4, 'ascii');

  const binaryHeader = Buffer.alloc(8);
  binaryHeader.writeUInt32LE(binaryChunk.length, 0);
  binaryHeader.write('BIN\0', 4, 'ascii');

  return Buffer.concat([header, jsonHeader, jsonChunk, binaryHeader, binaryChunk]);
}

export interface GlbSummary {
  readonly version: number;
  readonly jsonLength: number;
  readonly binaryLength: number;
  readonly meshes: number;
  readonly materials: number;
  readonly textures: number;
  readonly skins: number;
  readonly animations: number;
  readonly triangles: number;
  readonly vertices: number;
  readonly generator: string;
}

/** Parses a GLB header and manifest. Used by the asset validation step. */
export function inspectGlb(data: Buffer): GlbSummary {
  if (data.length < 20 || data.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a GLB file');
  const version = data.readUInt32LE(4);
  const totalLength = data.readUInt32LE(8);
  if (totalLength !== data.length) throw new Error(`GLB length mismatch: header says ${totalLength}, file is ${data.length}`);

  const jsonLength = data.readUInt32LE(12);
  if (data.toString('ascii', 16, 20) !== 'JSON') throw new Error('GLB first chunk is not JSON');
  const json = JSON.parse(data.toString('utf8', 20, 20 + jsonLength)) as {
    asset?: { generator?: string };
    meshes?: Array<{ primitives: Array<{ indices: number; attributes: Record<string, number> }> }>;
    materials?: unknown[];
    textures?: unknown[];
    skins?: unknown[];
    animations?: unknown[];
    accessors?: Array<{ count: number; type: string }>;
  };

  const binaryOffset = 20 + jsonLength;
  const binaryLength = binaryOffset + 8 <= data.length ? data.readUInt32LE(binaryOffset) : 0;

  let triangles = 0;
  let vertices = 0;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      const indexAccessor = json.accessors?.[primitive.indices];
      if (indexAccessor) triangles += Math.floor(indexAccessor.count / 3);
      const positionAccessor = json.accessors?.[primitive.attributes.POSITION ?? -1];
      if (positionAccessor) vertices += positionAccessor.count;
    }
  }

  return {
    version,
    jsonLength,
    binaryLength,
    meshes: json.meshes?.length ?? 0,
    materials: json.materials?.length ?? 0,
    textures: json.textures?.length ?? 0,
    skins: json.skins?.length ?? 0,
    animations: json.animations?.length ?? 0,
    triangles,
    vertices,
    generator: json.asset?.generator ?? 'unknown',
  };
}

/**
 * Validates a GLB produced elsewhere — a generative-3D service, or a model
 * program written by the coding agent — before it is accepted into a project.
 */
export interface GlbValidation {
  readonly ok: boolean;
  readonly summary: GlbSummary | null;
  readonly problems: readonly string[];
}

export interface GlbBudget {
  readonly maxTriangles?: number;
  readonly maxBytes?: number;
  readonly requireUvs?: boolean;
  readonly requireNormals?: boolean;
}

export function validateGlb(data: Buffer, budget: GlbBudget = {}): GlbValidation {
  const problems: string[] = [];
  let summary: GlbSummary | null = null;
  try {
    summary = inspectGlb(data);
  } catch (error) {
    return { ok: false, summary: null, problems: [(error as Error).message] };
  }

  if (summary.meshes === 0) problems.push('the file contains no meshes');
  if (summary.triangles === 0) problems.push('the file contains no triangles');
  if (budget.maxTriangles && summary.triangles > budget.maxTriangles) {
    problems.push(`${summary.triangles} triangles exceeds the ${budget.maxTriangles} budget for this asset class`);
  }
  if (budget.maxBytes && data.length > budget.maxBytes) {
    problems.push(`${data.length} bytes exceeds the ${budget.maxBytes} budget for this asset class`);
  }

  const jsonLength = data.readUInt32LE(12);
  const json = JSON.parse(data.toString('utf8', 20, 20 + jsonLength)) as {
    meshes?: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
  };
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      if (budget.requireNormals !== false && primitive.attributes.NORMAL === undefined) {
        problems.push('a primitive has no NORMAL attribute; it would render unlit');
      }
      if (budget.requireUvs && primitive.attributes.TEXCOORD_0 === undefined) {
        problems.push('a primitive has no TEXCOORD_0 attribute; it cannot be textured');
      }
    }
  }

  return { ok: problems.length === 0, summary, problems };
}
