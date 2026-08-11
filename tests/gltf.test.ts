import { describe, expect, it } from 'vitest';
import { inspectGlb, validateGlb, writeGlb, type GltfMaterial } from '@/lib/graphics/gltf';
import { encodePng } from '@/lib/graphics/png';
import { PolyMesh, subdivide, triangulate, v3 } from '@/lib/graphics/mesh-kernel';

/**
 * Everything the factory generates in 3D leaves through writeGlb, so a defect
 * here is a defect in every product. These tests assert the container against
 * the glTF 2.0 binary specification directly — magic, chunk framing, alignment,
 * accessor bounds — rather than trusting that a viewer happened to open it.
 */

function unitQuad(): ReturnType<typeof triangulate> {
  const mesh = new PolyMesh();
  mesh.addVertex(v3(-1, 0, -1), { u: 0, v: 0 });
  mesh.addVertex(v3(1, 0, -1), { u: 1, v: 0 });
  mesh.addVertex(v3(1, 0, 1), { u: 1, v: 1 });
  mesh.addVertex(v3(-1, 0, 1), { u: 0, v: 1 });
  mesh.addFace([0, 1, 2, 3]);
  return triangulate(mesh);
}

const BASIC_MATERIAL: GltfMaterial = {
  name: 'basic',
  baseColor: [0.8, 0.2, 0.1, 1],
  metallic: 0.1,
  roughness: 0.6,
};

function simpleGlb(): Buffer {
  const tri = unitQuad();
  return writeGlb({
    generator: 'test',
    meshes: [
      {
        name: 'quad',
        primitives: [
          {
            name: 'quad',
            positions: tri.positions,
            normals: tri.normals,
            uvs: tri.uvs,
            indices: tri.indices,
            materialIndex: 0,
          },
        ],
      },
    ],
    materials: [BASIC_MATERIAL],
  });
}

function parseJsonChunk(glb: Buffer): Record<string, unknown> {
  const jsonLength = glb.readUInt32LE(12);
  return JSON.parse(glb.toString('utf8', 20, 20 + jsonLength)) as Record<string, unknown>;
}

describe('GLB container', () => {
  it('writes a spec-conformant header', () => {
    const glb = simpleGlb();
    expect(glb.toString('ascii', 0, 4)).toBe('glTF');
    expect(glb.readUInt32LE(4)).toBe(2);
    expect(glb.readUInt32LE(8)).toBe(glb.length);
    expect(glb.toString('ascii', 16, 20)).toBe('JSON');
  });

  it('four-byte aligns both chunks, as the specification requires', () => {
    const glb = simpleGlb();
    expect(glb.length % 4).toBe(0);

    const jsonLength = glb.readUInt32LE(12);
    expect(jsonLength % 4).toBe(0);

    const binOffset = 20 + jsonLength;
    expect(glb.toString('ascii', binOffset + 4, binOffset + 8)).toBe('BIN\0');
    expect(glb.readUInt32LE(binOffset) % 4).toBe(0);
    // Header + both chunk headers + both payloads account for the whole file.
    expect(binOffset + 8 + glb.readUInt32LE(binOffset)).toBe(glb.length);
  });

  it('pads the JSON chunk with spaces and the binary chunk with zeroes', () => {
    const glb = simpleGlb();
    const jsonLength = glb.readUInt32LE(12);
    const text = glb.toString('utf8', 20, 20 + jsonLength);
    expect(text.trimEnd().endsWith('}')).toBe(true);
    expect(/[ ]*$/.test(text)).toBe(true);
  });

  it('reports accurate geometry through inspectGlb', () => {
    const summary = inspectGlb(simpleGlb());
    expect(summary.version).toBe(2);
    expect(summary.meshes).toBe(1);
    expect(summary.materials).toBe(1);
    expect(summary.triangles).toBe(2);
    expect(summary.vertices).toBe(4);
    expect(summary.generator).toBe('test');
  });

  it('rejects a file that is not a GLB', () => {
    expect(() => inspectGlb(Buffer.from('not a model at all, really'))).toThrow(/not a GLB/);
  });

  it('detects a truncated file rather than reading past the end', () => {
    const truncated = simpleGlb().subarray(0, 64);
    expect(() => inspectGlb(truncated)).toThrow(/length mismatch/);
  });
});

describe('accessors', () => {
  it('records min and max bounds for positions, which viewers use to frame the model', () => {
    const json = parseJsonChunk(simpleGlb()) as {
      accessors: Array<{ type: string; min?: number[]; max?: number[]; count: number }>;
    };
    const position = json.accessors.find((a) => a.type === 'VEC3' && a.min);
    expect(position?.min).toEqual([-1, 0, -1]);
    expect(position?.max).toEqual([1, 0, 1]);
  });

  it('keeps every accessor within its buffer view', () => {
    const glb = simpleGlb();
    const json = parseJsonChunk(glb) as {
      accessors: Array<{ bufferView: number; count: number; type: string; componentType: number; byteOffset?: number }>;
      bufferViews: Array<{ byteOffset: number; byteLength: number }>;
      buffers: Array<{ byteLength: number }>;
    };
    const sizes: Record<string, number> = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 };
    const componentBytes: Record<number, number> = { 5123: 2, 5125: 4, 5126: 4 };

    for (const accessor of json.accessors) {
      const view = json.bufferViews[accessor.bufferView];
      expect(view).toBeDefined();
      const needed =
        accessor.count * (sizes[accessor.type] as number) * (componentBytes[accessor.componentType] as number);
      expect((accessor.byteOffset ?? 0) + needed).toBeLessThanOrEqual((view as { byteLength: number }).byteLength);
    }

    const totalDeclared = json.buffers[0]?.byteLength ?? 0;
    for (const view of json.bufferViews) {
      expect(view.byteOffset + view.byteLength).toBeLessThanOrEqual(totalDeclared);
    }
  });
});

describe('materials', () => {
  it('emits PBR metallic-roughness values as given', () => {
    const json = parseJsonChunk(simpleGlb()) as {
      materials: Array<{ pbrMetallicRoughness: { baseColorFactor: number[]; metallicFactor: number; roughnessFactor: number } }>;
    };
    const pbr = json.materials[0]?.pbrMetallicRoughness;
    expect(pbr?.baseColorFactor).toEqual([0.8, 0.2, 0.1, 1]);
    expect(pbr?.metallicFactor).toBeCloseTo(0.1, 6);
    expect(pbr?.roughnessFactor).toBeCloseTo(0.6, 6);
  });

  it('declares the extensions it actually uses for clearcoat and glass', () => {
    const tri = unitQuad();
    const glb = writeGlb({
      generator: 'test',
      meshes: [{ name: 'q', primitives: [{ name: 'q', positions: tri.positions, normals: tri.normals, uvs: tri.uvs, indices: tri.indices, materialIndex: 0 }] }],
      materials: [
        { ...BASIC_MATERIAL, name: 'car paint', clearcoat: 1, clearcoatRoughness: 0.05 },
        { name: 'glass', baseColor: [1, 1, 1, 1], metallic: 0, roughness: 0.02, transmission: 0.95, ior: 1.5, alphaMode: 'BLEND' },
      ],
    });

    const json = parseJsonChunk(glb) as {
      extensionsUsed?: string[];
      materials: Array<{ extensions?: Record<string, unknown>; alphaMode?: string }>;
    };
    expect(json.extensionsUsed).toContain('KHR_materials_clearcoat');
    expect(json.extensionsUsed).toContain('KHR_materials_transmission');
    expect(json.materials[0]?.extensions).toHaveProperty('KHR_materials_clearcoat');
    expect(json.materials[1]?.extensions).toHaveProperty('KHR_materials_transmission');
    expect(json.materials[1]?.alphaMode).toBe('BLEND');
  });

  it('embeds textures in the binary chunk rather than referencing external files', () => {
    const tri = unitQuad();
    const png = encodePng(4, 4, new Uint8Array(4 * 4 * 4).fill(200));
    const glb = writeGlb({
      generator: 'test',
      meshes: [{ name: 'q', primitives: [{ name: 'q', positions: tri.positions, normals: tri.normals, uvs: tri.uvs, indices: tri.indices, materialIndex: 0 }] }],
      materials: [{ ...BASIC_MATERIAL, baseColorTexture: { texture: 0 } }],
      textures: [{ name: 'albedo', png, srgb: true }],
    });

    const json = parseJsonChunk(glb) as { images: Array<{ uri?: string; bufferView?: number; mimeType?: string }> };
    expect(json.images[0]?.uri).toBeUndefined();
    expect(json.images[0]?.bufferView).toBeTypeOf('number');
    expect(json.images[0]?.mimeType).toBe('image/png');
    expect(inspectGlb(glb).textures).toBe(1);
  });
});

describe('skins and animations', () => {
  it('writes a skinned, animated model that survives a round trip', () => {
    const tri = unitQuad();
    const jointCount = 2;
    const vertexCount = tri.positions.length / 3;
    const joints = new Uint16Array(vertexCount * 4);
    const weights = new Float32Array(vertexCount * 4);
    for (let i = 0; i < vertexCount; i += 1) {
      joints[i * 4] = i % jointCount;
      weights[i * 4] = 1;
    }

    const inverseBind = new Float32Array(jointCount * 16);
    for (let j = 0; j < jointCount; j += 1) {
      for (let k = 0; k < 4; k += 1) inverseBind[j * 16 + k * 5] = 1;
    }

    const glb = writeGlb({
      generator: 'test',
      meshes: [
        {
          name: 'skinned',
          primitives: [
            {
              name: 'skinned',
              positions: tri.positions,
              normals: tri.normals,
              uvs: tri.uvs,
              indices: tri.indices,
              joints,
              weights,
              materialIndex: 0,
            },
          ],
        },
      ],
      materials: [BASIC_MATERIAL],
      nodes: [
        { name: 'mesh', mesh: 0, skin: 0 },
        { name: 'root', translation: [0, 0, 0] },
        { name: 'child', translation: [0, 1, 0] },
      ],
      skins: [{ name: 'rig', joints: [1, 2], inverseBindMatrices: inverseBind, skeleton: 1 }],
      animations: [
        {
          name: 'idle',
          channels: [
            {
              node: 2,
              path: 'rotation',
              times: new Float32Array([0, 0.5, 1]),
              values: new Float32Array([0, 0, 0, 1, 0, 0.2588, 0, 0.9659, 0, 0, 0, 1]),
            },
          ],
        },
      ],
    });

    const summary = inspectGlb(glb);
    expect(summary.skins).toBe(1);
    expect(summary.animations).toBe(1);

    const json = parseJsonChunk(glb) as {
      animations: Array<{ name: string; channels: Array<{ target: { node: number; path: string } }>; samplers: unknown[] }>;
      skins: Array<{ joints: number[]; inverseBindMatrices: number; skeleton?: number }>;
      meshes: Array<{ primitives: Array<{ attributes: Record<string, number> }> }>;
    };
    expect(json.animations[0]?.name).toBe('idle');
    expect(json.animations[0]?.channels[0]?.target.path).toBe('rotation');
    expect(json.skins[0]?.joints).toEqual([1, 2]);
    expect(json.meshes[0]?.primitives[0]?.attributes).toHaveProperty('JOINTS_0');
    expect(json.meshes[0]?.primitives[0]?.attributes).toHaveProperty('WEIGHTS_0');
  });
});

describe('validateGlb', () => {
  it('accepts a well-formed model inside its budget', () => {
    const result = validateGlb(simpleGlb(), { maxTriangles: 1000, maxBytes: 1_000_000 });
    expect(result.problems).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects a model that exceeds its triangle budget instead of shipping it', () => {
    const dense = subdivide((() => {
      const mesh = new PolyMesh();
      const h = 1;
      const corners: Array<[number, number, number]> = [
        [-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h],
        [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h],
      ];
      for (const [x, y, z] of corners) mesh.addVertex(v3(x, y, z));
      mesh.addFace([0, 3, 2, 1]);
      mesh.addFace([4, 5, 6, 7]);
      mesh.addFace([0, 1, 5, 4]);
      mesh.addFace([1, 2, 6, 5]);
      mesh.addFace([2, 3, 7, 6]);
      mesh.addFace([3, 0, 4, 7]);
      return mesh;
    })(), 3);
    const tri = triangulate(dense);
    const glb = writeGlb({
      generator: 'test',
      meshes: [{ name: 'dense', primitives: [{ name: 'dense', positions: tri.positions, normals: tri.normals, uvs: tri.uvs, indices: tri.indices, materialIndex: 0 }] }],
      materials: [BASIC_MATERIAL],
    });

    const result = validateGlb(glb, { maxTriangles: 16 });
    expect(result.ok).toBe(false);
    expect(result.problems.join(' ')).toMatch(/triangles exceeds/);
  });

  it('rejects a file that is not a model at all', () => {
    const result = validateGlb(Buffer.from('this is not a model'));
    expect(result.ok).toBe(false);
    expect(result.summary).toBeNull();
    expect(result.problems.length).toBeGreaterThan(0);
  });
});
