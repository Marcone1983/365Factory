import * as THREE from 'three';

/**
 * World construction: deterministic terrain heightfields, sky and lighting rig,
 * and instanced scattering. Every function is seed-driven so a generated world
 * is byte-identical across runs, which is what makes the automated scene-load
 * and gameplay tests meaningful.
 */

export function hashNoise(x: number, y: number, seed: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(seed | 0, 2147483647)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

export function valueNoise2D(x: number, y: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;
  const u = smooth(xf);
  const v = smooth(yf);
  const a = hashNoise(xi, yi, seed);
  const b = hashNoise(xi + 1, yi, seed);
  const c = hashNoise(xi, yi + 1, seed);
  const d = hashNoise(xi + 1, yi + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

export interface TerrainOptions {
  readonly size: number;
  readonly segments: number;
  readonly seed: number;
  readonly amplitude: number;
  readonly frequency: number;
  readonly octaves?: number;
  readonly ridged?: boolean;
  /** Flattens the centre so the player always spawns on level ground. */
  readonly spawnFlatRadius?: number;
}

export interface Heightfield {
  readonly size: number;
  readonly segments: number;
  readonly heights: Float32Array;
  heightAt(x: number, z: number): number;
  normalAt(x: number, z: number): THREE.Vector3;
}

export function generateHeightfield(options: TerrainOptions): Heightfield {
  const { size, segments, seed, amplitude, frequency } = options;
  const octaves = options.octaves ?? 5;
  const flatRadius = options.spawnFlatRadius ?? size * 0.06;
  const stride = segments + 1;
  const heights = new Float32Array(stride * stride);

  for (let j = 0; j < stride; j += 1) {
    for (let i = 0; i < stride; i += 1) {
      const u = i / segments;
      const v = j / segments;
      let amp = 1;
      let freq = frequency;
      let sum = 0;
      let norm = 0;
      for (let o = 0; o < octaves; o += 1) {
        const n = valueNoise2D(u * freq, v * freq, seed + o * 1013);
        sum += amp * (options.ridged ? 1 - Math.abs(n * 2 - 1) : n);
        norm += amp;
        amp *= 0.5;
        freq *= 2;
      }
      let height = (sum / norm) * amplitude;

      // Island falloff keeps the playable area bounded without invisible walls.
      const dx = (u - 0.5) * 2;
      const dz = (v - 0.5) * 2;
      const radial = Math.min(1, Math.hypot(dx, dz));
      height *= 1 - smooth(Math.max(0, (radial - 0.55) / 0.45));

      const worldX = (u - 0.5) * size;
      const worldZ = (v - 0.5) * size;
      const distanceToSpawn = Math.hypot(worldX, worldZ);
      if (distanceToSpawn < flatRadius) {
        height *= smooth(Math.min(1, distanceToSpawn / flatRadius));
      }
      heights[j * stride + i] = height;
    }
  }

  const heightAt = (x: number, z: number): number => {
    const u = (x / size + 0.5) * segments;
    const v = (z / size + 0.5) * segments;
    const i = Math.max(0, Math.min(segments - 1, Math.floor(u)));
    const j = Math.max(0, Math.min(segments - 1, Math.floor(v)));
    const fu = Math.max(0, Math.min(1, u - i));
    const fv = Math.max(0, Math.min(1, v - j));
    const h00 = heights[j * stride + i] as number;
    const h10 = heights[j * stride + i + 1] as number;
    const h01 = heights[(j + 1) * stride + i] as number;
    const h11 = heights[(j + 1) * stride + i + 1] as number;
    return (h00 * (1 - fu) + h10 * fu) * (1 - fv) + (h01 * (1 - fu) + h11 * fu) * fv;
  };

  const normalAt = (x: number, z: number): THREE.Vector3 => {
    const step = size / segments;
    const hl = heightAt(x - step, z);
    const hr = heightAt(x + step, z);
    const hd = heightAt(x, z - step);
    const hu = heightAt(x, z + step);
    return new THREE.Vector3(hl - hr, 2 * step, hd - hu).normalize();
  };

  return { size, segments, heights, heightAt, normalAt };
}

export interface TerrainPalette {
  /** Colour ramp from lowest to highest elevation. */
  readonly bands: ReadonlyArray<{ at: number; color: number }>;
  readonly slopeColor: number;
}

export function buildTerrainMesh(field: Heightfield, palette: TerrainPalette): THREE.Mesh {
  const geometry = new THREE.PlaneGeometry(field.size, field.size, field.segments, field.segments);
  geometry.rotateX(-Math.PI / 2);
  const position = geometry.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(position.count * 3);

  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < field.heights.length; i += 1) {
    const h = field.heights[i] as number;
    if (h < min) min = h;
    if (h > max) max = h;
  }
  const range = Math.max(1e-4, max - min);
  const slope = new THREE.Color(palette.slopeColor);
  const temp = new THREE.Color();

  for (let i = 0; i < position.count; i += 1) {
    const x = position.getX(i);
    const z = position.getZ(i);
    const height = field.heightAt(x, z);
    position.setY(i, height);

    const t = (height - min) / range;
    const band = sampleBands(palette.bands, t, temp);
    const normal = field.normalAt(x, z);
    const steepness = 1 - Math.max(0, Math.min(1, normal.y));
    band.lerp(slope, Math.min(1, steepness * 2.2));
    colors[i * 3] = band.r;
    colors[i * 3 + 1] = band.g;
    colors[i * 3 + 2] = band.b;
  }

  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();

  const material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0.02, flatShading: false });
  const mesh = new THREE.Mesh(geometry, material);
  mesh.receiveShadow = true;
  mesh.name = 'terrain';
  return mesh;
}

function sampleBands(bands: TerrainPalette['bands'], t: number, out: THREE.Color): THREE.Color {
  if (bands.length === 0) return out.setRGB(0.4, 0.5, 0.35);
  const sorted = [...bands].sort((a, b) => a.at - b.at);
  const first = sorted[0] as { at: number; color: number };
  const last = sorted[sorted.length - 1] as { at: number; color: number };
  if (t <= first.at) return out.set(first.color);
  if (t >= last.at) return out.set(last.color);
  for (let i = 0; i + 1 < sorted.length; i += 1) {
    const a = sorted[i] as { at: number; color: number };
    const b = sorted[i + 1] as { at: number; color: number };
    if (t >= a.at && t <= b.at) {
      const k = b.at === a.at ? 0 : (t - a.at) / (b.at - a.at);
      return out.set(a.color).lerp(new THREE.Color(b.color), k);
    }
  }
  return out.set(last.color);
}

export interface SkyOptions {
  readonly topColor: number;
  readonly horizonColor: number;
  readonly sunColor: number;
  readonly sunElevation: number;
  readonly sunAzimuth: number;
  readonly fogDensity: number;
  readonly ambientIntensity?: number;
  readonly sunIntensity?: number;
}

export interface SkyRig {
  readonly sky: THREE.Mesh;
  readonly sun: THREE.DirectionalLight;
  readonly ambient: THREE.HemisphereLight;
  dispose(): void;
}

/** Gradient sky dome with a matching hemisphere/directional lighting rig. */
export function buildSky(scene: THREE.Scene, options: SkyOptions, shadowMapSize: number, viewDistance: number): SkyRig {
  // The dome is drawn first, without depth, and recentred on the camera each
  // frame. That keeps it inside the far plane at any view distance — a dome
  // sized to the far plane itself gets clipped and the sky renders black.
  const geometry = new THREE.SphereGeometry(Math.max(10, viewDistance * 0.4), 32, 16);
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    depthTest: false,
    fog: false,
    uniforms: {
      topColor: { value: new THREE.Color(options.topColor) },
      horizonColor: { value: new THREE.Color(options.horizonColor) },
      sunColor: { value: new THREE.Color(options.sunColor) },
      sunDirection: { value: sunDirection(options).clone() },
    },
    vertexShader: `
      varying vec3 vWorld;
      void main() {
        vWorld = normalize((modelMatrix * vec4(position, 1.0)).xyz);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      uniform vec3 topColor; uniform vec3 horizonColor; uniform vec3 sunColor; uniform vec3 sunDirection;
      varying vec3 vWorld;
      void main() {
        float h = clamp(vWorld.y * 0.5 + 0.5, 0.0, 1.0);
        vec3 base = mix(horizonColor, topColor, pow(h, 0.65));
        float sun = pow(max(dot(normalize(vWorld), normalize(sunDirection)), 0.0), 220.0);
        float glow = pow(max(dot(normalize(vWorld), normalize(sunDirection)), 0.0), 6.0) * 0.25;
        gl_FragColor = vec4(base + sunColor * (sun + glow), 1.0);
      }`,
  });
  const sky = new THREE.Mesh(geometry, material);
  sky.name = 'sky';
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  sky.onBeforeRender = (_renderer, _scene, camera): void => {
    sky.position.copy(camera.position);
  };
  scene.add(sky);

  scene.fog = new THREE.FogExp2(options.horizonColor, options.fogDensity);

  const ambient = new THREE.HemisphereLight(options.topColor, options.horizonColor, options.ambientIntensity ?? 0.9);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(options.sunColor, options.sunIntensity ?? 2.8);
  sun.position.copy(sunDirection(options).multiplyScalar(viewDistance * 0.4));
  sun.castShadow = shadowMapSize > 0;
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = viewDistance;
  const extent = Math.max(40, viewDistance * 0.25);
  sun.shadow.camera.left = -extent;
  sun.shadow.camera.right = extent;
  sun.shadow.camera.top = extent;
  sun.shadow.camera.bottom = -extent;
  sun.shadow.bias = -0.0006;
  scene.add(sun);
  scene.add(sun.target);

  return {
    sky,
    sun,
    ambient,
    dispose(): void {
      geometry.dispose();
      material.dispose();
      scene.remove(sky, sun, sun.target, ambient);
    },
  };
}

function sunDirection(options: SkyOptions): THREE.Vector3 {
  const elevation = THREE.MathUtils.degToRad(options.sunElevation);
  const azimuth = THREE.MathUtils.degToRad(options.sunAzimuth);
  return new THREE.Vector3(
    Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth),
  ).normalize();
}

export interface ScatterOptions {
  readonly count: number;
  readonly seed: number;
  readonly area: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  readonly maxSlope?: number;
  readonly minScale?: number;
  readonly maxScale?: number;
  readonly exclusionRadius?: number;
  readonly alignToNormal?: boolean;
}

/**
 * Instanced scattering over a heightfield with slope, elevation and spawn-area
 * rejection. One draw call per prop type keeps mobile GPUs inside budget.
 */
export function scatterInstances(
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  field: Heightfield,
  options: ScatterOptions,
): THREE.InstancedMesh {
  const placements: THREE.Matrix4[] = [];
  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quaternion = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const exclusion = options.exclusionRadius ?? 6;
  const maxSlope = options.maxSlope ?? 0.55;

  let attempts = 0;
  const maxAttempts = options.count * 12;
  while (placements.length < options.count && attempts < maxAttempts) {
    const n = attempts;
    attempts += 1;
    const x = (hashNoise(n, 1, options.seed) - 0.5) * options.area;
    const z = (hashNoise(n, 2, options.seed) - 0.5) * options.area;
    if (Math.hypot(x, z) < exclusion) continue;
    const y = field.heightAt(x, z);
    if (options.minHeight !== undefined && y < options.minHeight) continue;
    if (options.maxHeight !== undefined && y > options.maxHeight) continue;
    const normal = field.normalAt(x, z);
    if (1 - normal.y > maxSlope) continue;

    const s = THREE.MathUtils.lerp(options.minScale ?? 0.8, options.maxScale ?? 1.4, hashNoise(n, 3, options.seed));
    position.set(x, y, z);
    scale.set(s, s * THREE.MathUtils.lerp(0.85, 1.25, hashNoise(n, 4, options.seed)), s);
    if (options.alignToNormal) quaternion.setFromUnitVectors(up, normal);
    else quaternion.setFromAxisAngle(up, hashNoise(n, 5, options.seed) * Math.PI * 2);
    placements.push(matrix.clone().compose(position, quaternion, scale));
  }

  const mesh = new THREE.InstancedMesh(geometry, material, Math.max(1, placements.length));
  placements.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.count = placements.length;
  mesh.instanceMatrix.needsUpdate = true;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = true;
  return mesh;
}
