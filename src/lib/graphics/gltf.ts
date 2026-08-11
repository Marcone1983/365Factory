/**
 * glTF 2.0 binary (.glb) writer.
 *
 * Emits a single-buffer, indexed, PBR-material GLB from generated geometry.
 * Output is validated by the asset checker and loads in three.js, Blender and
 * the Android/Web viewers without post-processing.
 */

export interface MeshPrimitiveData {
  readonly name: string;
  readonly positions: Float32Array;
  readonly normals: Float32Array;
  readonly uvs?: Float32Array;
  readonly indices: Uint32Array;
  readonly materialIndex: number;
}

export interface GltfMaterial {
  readonly name: string;
  /** Linear RGBA base colour, components 0..1. */
  readonly baseColor: readonly [number, number, number, number];
  readonly metallic: number;
  readonly roughness: number;
  readonly emissive?: readonly [number, number, number];
  readonly doubleSided?: boolean;
}

export interface GltfNode {
  readonly name: string;
  readonly meshIndex: number;
  readonly translation?: readonly [number, number, number];
  readonly rotation?: readonly [number, number, number, number];
  readonly scale?: readonly [number, number, number];
}

export interface GlbInput {
  readonly generator: string;
  readonly primitives: readonly MeshPrimitiveData[];
  readonly materials: readonly GltfMaterial[];
  readonly nodes?: readonly GltfNode[];
}

const COMPONENT_FLOAT = 5126;
const COMPONENT_UINT = 5125;
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

export function writeGlb(input: GlbInput): Buffer {
  const bufferChunks: Buffer[] = [];
  const bufferViews: Array<Record<string, number>> = [];
  const accessors: Array<Record<string, unknown>> = [];
  let byteOffset = 0;

  const pushView = (data: Buffer, target: number): number => {
    const padding = align4(byteOffset) - byteOffset;
    if (padding > 0) {
      bufferChunks.push(Buffer.alloc(padding));
      byteOffset += padding;
    }
    bufferViews.push({ buffer: 0, byteOffset, byteLength: data.length, target });
    bufferChunks.push(data);
    byteOffset += data.length;
    return bufferViews.length - 1;
  };

  const meshes: Array<Record<string, unknown>> = [];

  for (const primitive of input.primitives) {
    const vertexCount = primitive.positions.length / 3;
    if (primitive.normals.length !== primitive.positions.length) {
      throw new Error(`glTF export: normals length mismatch for primitive "${primitive.name}"`);
    }
    if (primitive.uvs && primitive.uvs.length !== vertexCount * 2) {
      throw new Error(`glTF export: uv length mismatch for primitive "${primitive.name}"`);
    }
    for (const index of primitive.indices) {
      if (index >= vertexCount) {
        throw new Error(`glTF export: index ${index} out of range for primitive "${primitive.name}"`);
      }
    }

    const positionView = pushView(Buffer.from(primitive.positions.buffer, primitive.positions.byteOffset, primitive.positions.byteLength), TARGET_ARRAY_BUFFER);
    const positionBounds = bounds(primitive.positions, 3);
    accessors.push({
      bufferView: positionView,
      componentType: COMPONENT_FLOAT,
      count: vertexCount,
      type: 'VEC3',
      min: positionBounds.min,
      max: positionBounds.max,
    });
    const positionAccessor = accessors.length - 1;

    const normalView = pushView(Buffer.from(primitive.normals.buffer, primitive.normals.byteOffset, primitive.normals.byteLength), TARGET_ARRAY_BUFFER);
    accessors.push({ bufferView: normalView, componentType: COMPONENT_FLOAT, count: vertexCount, type: 'VEC3' });
    const normalAccessor = accessors.length - 1;

    let uvAccessor: number | null = null;
    if (primitive.uvs) {
      const uvView = pushView(Buffer.from(primitive.uvs.buffer, primitive.uvs.byteOffset, primitive.uvs.byteLength), TARGET_ARRAY_BUFFER);
      accessors.push({ bufferView: uvView, componentType: COMPONENT_FLOAT, count: vertexCount, type: 'VEC2' });
      uvAccessor = accessors.length - 1;
    }

    const indexView = pushView(Buffer.from(primitive.indices.buffer, primitive.indices.byteOffset, primitive.indices.byteLength), TARGET_ELEMENT_ARRAY_BUFFER);
    accessors.push({ bufferView: indexView, componentType: COMPONENT_UINT, count: primitive.indices.length, type: 'SCALAR' });
    const indexAccessor = accessors.length - 1;

    const attributes: Record<string, number> = { POSITION: positionAccessor, NORMAL: normalAccessor };
    if (uvAccessor !== null) attributes.TEXCOORD_0 = uvAccessor;

    meshes.push({
      name: primitive.name,
      primitives: [{ attributes, indices: indexAccessor, material: primitive.materialIndex, mode: 4 }],
    });
  }

  const nodeInputs: readonly GltfNode[] = input.nodes ?? input.primitives.map((p, i) => ({ name: p.name, meshIndex: i }));
  const nodes = nodeInputs.map((node) => {
    const record: Record<string, unknown> = { name: node.name, mesh: node.meshIndex };
    if (node.translation) record.translation = node.translation;
    if (node.rotation) record.rotation = node.rotation;
    if (node.scale) record.scale = node.scale;
    return record;
  });

  const json = {
    asset: { version: '2.0', generator: input.generator },
    scene: 0,
    scenes: [{ nodes: nodes.map((_node, i) => i) }],
    nodes,
    meshes,
    materials: input.materials.map((material) => ({
      name: material.name,
      doubleSided: material.doubleSided ?? false,
      pbrMetallicRoughness: {
        baseColorFactor: material.baseColor,
        metallicFactor: material.metallic,
        roughnessFactor: material.roughness,
      },
      emissiveFactor: material.emissive ?? [0, 0, 0],
    })),
    accessors,
    bufferViews,
    buffers: [{ byteLength: align4(byteOffset) }],
  };

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
  readonly triangles: number;
  readonly vertices: number;
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
    meshes?: Array<{ primitives: Array<{ indices: number }> }>;
    materials?: unknown[];
    accessors?: Array<{ count: number; type: string }>;
  };

  const binaryOffset = 20 + jsonLength;
  const binaryLength = binaryOffset + 8 <= data.length ? data.readUInt32LE(binaryOffset) : 0;

  let triangles = 0;
  let vertices = 0;
  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives) {
      const accessor = json.accessors?.[primitive.indices];
      if (accessor) triangles += Math.floor(accessor.count / 3);
    }
  }
  for (const accessor of json.accessors ?? []) {
    if (accessor.type === 'VEC3') vertices = Math.max(vertices, accessor.count);
  }

  return {
    version,
    jsonLength,
    binaryLength,
    meshes: json.meshes?.length ?? 0,
    materials: json.materials?.length ?? 0,
    triangles,
    vertices,
  };
}
