import * as THREE from 'three';
import { hashNoise } from './world';

/**
 * Visual effects: procedural texture synthesis, a shared material factory and a
 * pooled GPU particle system. Textures are generated on the device from a seed
 * rather than downloaded, which keeps the APK small and load time short.
 */

export type TexturePattern = 'noise' | 'grain' | 'stripes' | 'cells' | 'gradient' | 'checker';

export interface ProceduralTextureOptions {
  readonly size?: number;
  readonly pattern: TexturePattern;
  readonly seed: number;
  readonly colorA: number;
  readonly colorB: number;
  readonly scale?: number;
  readonly contrast?: number;
  readonly repeat?: number;
}

function fbm2(x: number, y: number, seed: number, octaves: number): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o += 1) {
    const xi = Math.floor(x * freq);
    const yi = Math.floor(y * freq);
    const fx = x * freq - xi;
    const fy = y * freq - yi;
    const sx = fx * fx * (3 - 2 * fx);
    const sy = fy * fy * (3 - 2 * fy);
    const a = hashNoise(xi, yi, seed + o * 977);
    const b = hashNoise(xi + 1, yi, seed + o * 977);
    const c = hashNoise(xi, yi + 1, seed + o * 977);
    const d = hashNoise(xi + 1, yi + 1, seed + o * 977);
    sum += amp * ((a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy);
    norm += amp;
    amp *= 0.5;
    freq *= 2;
  }
  return norm === 0 ? 0 : sum / norm;
}

/** Renders a seamless texture into an offscreen canvas and uploads it once. */
export function createProceduralTexture(options: ProceduralTextureOptions): THREE.CanvasTexture {
  const size = options.size ?? 256;
  const scale = options.scale ?? 6;
  const contrast = options.contrast ?? 1;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable for procedural texture generation');

  const image = ctx.createImageData(size, size);
  const a = new THREE.Color(options.colorA);
  const b = new THREE.Color(options.colorB);
  const mixed = new THREE.Color();

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const u = x / size;
      const v = y / size;
      let t: number;
      switch (options.pattern) {
        case 'grain':
          t = hashNoise(x, y, options.seed);
          break;
        case 'stripes':
          t = 0.5 + 0.5 * Math.sin((u * scale + fbm2(u * 3, v * 3, options.seed, 3) * 0.6) * Math.PI * 2);
          break;
        case 'cells': {
          let nearest = 1;
          for (let cy = -1; cy <= 1; cy += 1) {
            for (let cx = -1; cx <= 1; cx += 1) {
              const gx = Math.floor(u * scale) + cx;
              const gy = Math.floor(v * scale) + cy;
              const px = (gx + hashNoise(gx, gy, options.seed)) / scale;
              const py = (gy + hashNoise(gx, gy, options.seed + 7)) / scale;
              nearest = Math.min(nearest, Math.hypot(u - px, v - py) * scale);
            }
          }
          t = Math.min(1, nearest);
          break;
        }
        case 'gradient':
          t = v;
          break;
        case 'checker':
          t = (Math.floor(u * scale) + Math.floor(v * scale)) % 2 === 0 ? 0.15 : 0.85;
          break;
        case 'noise':
        default:
          t = fbm2(u * scale, v * scale, options.seed, 5);
          break;
      }
      t = Math.max(0, Math.min(1, (t - 0.5) * contrast + 0.5));
      mixed.copy(a).lerp(b, t);
      const index = (y * size + x) * 4;
      image.data[index] = Math.round(mixed.r * 255);
      image.data[index + 1] = Math.round(mixed.g * 255);
      image.data[index + 2] = Math.round(mixed.b * 255);
      image.data[index + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.setScalar(options.repeat ?? 1);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export interface SurfaceOptions {
  readonly color: number;
  readonly roughness?: number;
  readonly metalness?: number;
  readonly emissive?: number;
  readonly emissiveIntensity?: number;
  readonly texture?: ProceduralTextureOptions;
  readonly transparent?: boolean;
  readonly opacity?: number;
  readonly flatShading?: boolean;
}

/**
 * Material cache. Generated worlds reuse a small number of materials so that
 * instanced draw calls batch and the mobile GPU stays inside its state-change
 * budget.
 */
export class MaterialLibrary {
  private readonly cache = new Map<string, THREE.MeshStandardMaterial>();
  private readonly textures: THREE.Texture[] = [];

  surface(key: string, options: SurfaceOptions): THREE.MeshStandardMaterial {
    const existing = this.cache.get(key);
    if (existing) return existing;
    const material = new THREE.MeshStandardMaterial({
      color: options.color,
      roughness: options.roughness ?? 0.85,
      metalness: options.metalness ?? 0.05,
      emissive: options.emissive ?? 0x000000,
      emissiveIntensity: options.emissiveIntensity ?? 1,
      transparent: options.transparent ?? false,
      opacity: options.opacity ?? 1,
      flatShading: options.flatShading ?? false,
    });
    if (options.texture) {
      const texture = createProceduralTexture(options.texture);
      material.map = texture;
      this.textures.push(texture);
    }
    this.cache.set(key, material);
    return material;
  }

  dispose(): void {
    for (const material of this.cache.values()) material.dispose();
    for (const texture of this.textures) texture.dispose();
    this.cache.clear();
    this.textures.length = 0;
  }
}

export interface ParticleBurstOptions {
  readonly origin: THREE.Vector3;
  readonly count: number;
  readonly speed: number;
  readonly spread: number;
  readonly life: number;
  readonly size: number;
  readonly color: number;
  readonly gravity?: number;
}

/**
 * Pooled additive particle system drawn as a single Points object. The pool is
 * allocated once at the configured budget; bursts beyond the budget recycle the
 * oldest particles instead of allocating.
 */
export class ParticleSystem {
  readonly points: THREE.Points;
  private readonly positions: Float32Array;
  private readonly velocities: Float32Array;
  private readonly lives: Float32Array;
  private readonly maxLives: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private cursor = 0;
  private readonly gravity: number;

  constructor(private readonly budget: number, gravity = 9.2) {
    this.gravity = gravity;
    this.positions = new Float32Array(budget * 3);
    this.velocities = new Float32Array(budget * 3);
    this.lives = new Float32Array(budget);
    this.maxLives = new Float32Array(budget);
    this.colors = new Float32Array(budget * 3);
    this.sizes = new Float32Array(budget);

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geometry.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));

    const material = new THREE.ShaderMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      uniforms: {},
      vertexShader: `
        attribute float size; varying vec3 vColor;
        void main(){
          vColor = color;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (240.0 / max(-mv.z, 0.001));
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColor;
        void main(){
          vec2 d = gl_PointCoord - vec2(0.5);
          float a = smoothstep(0.5, 0.05, length(d));
          if (a <= 0.01) discard;
          gl_FragColor = vec4(vColor, a);
        }`,
      vertexColors: true,
    });

    this.points = new THREE.Points(geometry, material);
    this.points.frustumCulled = false;
    this.points.name = 'particles';
  }

  burst(options: ParticleBurstOptions): void {
    const color = new THREE.Color(options.color);
    const count = Math.min(options.count, this.budget);
    for (let i = 0; i < count; i += 1) {
      const index = this.cursor;
      this.cursor = (this.cursor + 1) % this.budget;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(1 - Math.random() * (1 + Math.cos(options.spread)));
      const speed = options.speed * (0.5 + Math.random());
      this.positions[index * 3] = options.origin.x;
      this.positions[index * 3 + 1] = options.origin.y;
      this.positions[index * 3 + 2] = options.origin.z;
      this.velocities[index * 3] = Math.sin(phi) * Math.cos(theta) * speed;
      this.velocities[index * 3 + 1] = Math.cos(phi) * speed;
      this.velocities[index * 3 + 2] = Math.sin(phi) * Math.sin(theta) * speed;
      this.lives[index] = options.life;
      this.maxLives[index] = options.life;
      this.colors[index * 3] = color.r;
      this.colors[index * 3 + 1] = color.g;
      this.colors[index * 3 + 2] = color.b;
      this.sizes[index] = options.size;
    }
  }

  update(dt: number): void {
    const gravity = this.gravity;
    for (let i = 0; i < this.budget; i += 1) {
      if ((this.lives[i] as number) <= 0) {
        if ((this.sizes[i] as number) !== 0) this.sizes[i] = 0;
        continue;
      }
      this.lives[i] = (this.lives[i] as number) - dt;
      this.velocities[i * 3 + 1] = (this.velocities[i * 3 + 1] as number) - gravity * dt;
      this.positions[i * 3] = (this.positions[i * 3] as number) + (this.velocities[i * 3] as number) * dt;
      this.positions[i * 3 + 1] = (this.positions[i * 3 + 1] as number) + (this.velocities[i * 3 + 1] as number) * dt;
      this.positions[i * 3 + 2] = (this.positions[i * 3 + 2] as number) + (this.velocities[i * 3 + 2] as number) * dt;
      const fade = Math.max(0, (this.lives[i] as number) / (this.maxLives[i] as number));
      this.sizes[i] = (this.sizes[i] as number) * 0.5 + fade * (this.sizes[i] as number) * 0.5;
    }
    const geometry = this.points.geometry;
    (geometry.attributes.position as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.size as THREE.BufferAttribute).needsUpdate = true;
    (geometry.attributes.color as THREE.BufferAttribute).needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    (this.points.material as THREE.Material).dispose();
  }
}

/** Convex low-poly rock/crystal geometry built from a seeded icosahedron. */
export function createFacetedGeometry(radius: number, detail: number, seed: number, jitter = 0.28): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(radius, detail);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < position.count; i += 1) {
    const scale = 1 + (hashNoise(Math.round(position.getX(i) * 97), Math.round(position.getZ(i) * 97), seed) - 0.5) * jitter * 2;
    position.setXYZ(i, position.getX(i) * scale, position.getY(i) * scale, position.getZ(i) * scale);
  }
  geometry.computeVertexNormals();
  return geometry;
}

/** Tapered trunk-and-canopy geometry for scattered vegetation. */
export function createFoliageGeometry(height: number, seed: number): THREE.BufferGeometry {
  const trunk = new THREE.CylinderGeometry(height * 0.05, height * 0.09, height * 0.55, 6);
  trunk.translate(0, height * 0.275, 0);
  const canopy = createFacetedGeometry(height * 0.34, 1, seed, 0.34);
  canopy.translate(0, height * 0.72, 0);
  const merged = mergeGeometries([trunk, canopy]);
  trunk.dispose();
  canopy.dispose();
  return merged;
}

/** Minimal geometry merge for non-indexed position/normal/uv attributes. */
export function mergeGeometries(geometries: readonly THREE.BufferGeometry[]): THREE.BufferGeometry {
  const nonIndexed = geometries.map((g) => (g.index ? g.toNonIndexed() : g.clone()));
  let vertexCount = 0;
  for (const geometry of nonIndexed) vertexCount += (geometry.attributes.position as THREE.BufferAttribute).count;

  const positions = new Float32Array(vertexCount * 3);
  const normals = new Float32Array(vertexCount * 3);
  const uvs = new Float32Array(vertexCount * 2);
  let offset = 0;

  for (const geometry of nonIndexed) {
    const position = geometry.attributes.position as THREE.BufferAttribute;
    const normal = geometry.attributes.normal as THREE.BufferAttribute | undefined;
    const uv = geometry.attributes.uv as THREE.BufferAttribute | undefined;
    positions.set(position.array as Float32Array, offset * 3);
    if (normal) normals.set(normal.array as Float32Array, offset * 3);
    if (uv) uvs.set(uv.array as Float32Array, offset * 2);
    offset += position.count;
    geometry.dispose();
  }

  const merged = new THREE.BufferGeometry();
  merged.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  merged.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  merged.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
  merged.computeVertexNormals();
  return merged;
}
