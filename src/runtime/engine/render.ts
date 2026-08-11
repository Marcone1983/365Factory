import * as THREE from 'three';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { SMAAPass } from 'three/examples/jsm/postprocessing/SMAAPass.js';
import type { Engine, QualityTier, RenderContext, System } from './core';

/**
 * Rendering quality stack.
 *
 * Three things separate a good-looking real-time scene from a flat one, and all
 * three are here:
 *
 *  1. Image-based lighting. A PBR material without an environment map has
 *     nothing to reflect, so metal looks like plastic. A procedural sky-and-
 *     ground environment is prefiltered through PMREM and used as `scene.environment`.
 *  2. Tone mapping and exposure, so bright sources roll off instead of clipping.
 *  3. Post-processing: bloom on genuinely bright pixels, a colour grade, subtle
 *     vignette and film grain, and morphological anti-aliasing.
 *
 * The whole stack is quality-tier aware and degrades to a direct render on low
 * tiers, where the post chain would cost more than it returns.
 */

export interface GradeUniforms {
  /** Overall exposure multiplier applied before grading. */
  exposure: number;
  /** Saturation, 1 = unchanged. */
  saturation: number;
  /** Contrast pivoted on mid grey, 1 = unchanged. */
  contrast: number;
  /** Colour cast applied in the shadows and in the highlights. */
  shadowTint: THREE.Color;
  highlightTint: THREE.Color;
  vignette: number;
  grain: number;
}

const GradeShader = {
  uniforms: {
    tDiffuse: { value: null as THREE.Texture | null },
    exposure: { value: 1 },
    saturation: { value: 1.05 },
    contrast: { value: 1.04 },
    shadowTint: { value: new THREE.Color(0.04, 0.05, 0.09) },
    highlightTint: { value: new THREE.Color(1.02, 1.0, 0.96) },
    vignette: { value: 0.32 },
    grain: { value: 0.025 },
    time: { value: 0 },
  },
  vertexShader: `
    varying vec2 vUv;
    void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
  fragmentShader: `
    uniform sampler2D tDiffuse;
    uniform float exposure; uniform float saturation; uniform float contrast;
    uniform vec3 shadowTint; uniform vec3 highlightTint;
    uniform float vignette; uniform float grain; uniform float time;
    varying vec2 vUv;

    float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

    void main(){
      vec4 texel = texture2D(tDiffuse, vUv);
      vec3 color = texel.rgb * exposure;

      // Split toning: lift the shadows toward one hue, the highlights to another.
      float luma = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color += shadowTint * (1.0 - smoothstep(0.0, 0.55, luma));
      color *= mix(vec3(1.0), highlightTint, smoothstep(0.45, 1.0, luma));

      color = mix(vec3(luma), color, saturation);
      color = (color - 0.5) * contrast + 0.5;

      vec2 centred = vUv - 0.5;
      float falloff = 1.0 - dot(centred, centred) * vignette * 2.2;
      color *= clamp(falloff, 0.0, 1.0);

      // Animated grain breaks up banding in dark gradients.
      color += (hash(vUv * 1024.0 + time) - 0.5) * grain;

      gl_FragColor = vec4(max(color, 0.0), texel.a);
    }`,
};

export interface EnvironmentOptions {
  readonly skyTop: number;
  readonly skyHorizon: number;
  readonly ground: number;
  readonly sunColor: number;
  readonly sunElevationDegrees: number;
  readonly sunAzimuthDegrees: number;
  readonly intensity?: number;
}

/**
 * Builds a prefiltered environment map from a procedural sky.
 *
 * Rendering a tiny scene into PMREM is far cheaper than shipping an HDR file and
 * gives every metal and clearcoat surface something real to reflect.
 */
export function buildEnvironment(renderer: THREE.WebGLRenderer, options: EnvironmentOptions): THREE.Texture {
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  const scene = new THREE.Scene();
  const intensity = options.intensity ?? 1;

  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(50, 32, 16),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        top: { value: new THREE.Color(options.skyTop).multiplyScalar(intensity) },
        horizon: { value: new THREE.Color(options.skyHorizon).multiplyScalar(intensity) },
        ground: { value: new THREE.Color(options.ground).multiplyScalar(intensity) },
        sun: { value: new THREE.Color(options.sunColor).multiplyScalar(intensity * 12) },
        sunDir: { value: sunDirection(options) },
      },
      vertexShader: `varying vec3 vDir; void main(){ vDir = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `
        uniform vec3 top; uniform vec3 horizon; uniform vec3 ground; uniform vec3 sun; uniform vec3 sunDir;
        varying vec3 vDir;
        void main(){
          float h = vDir.y;
          vec3 sky = mix(horizon, top, pow(clamp(h,0.0,1.0), 0.55));
          vec3 base = h < 0.0 ? mix(horizon, ground, clamp(-h*2.2,0.0,1.0)) : sky;
          float disc = pow(max(dot(normalize(vDir), normalize(sunDir)), 0.0), 900.0);
          float glow = pow(max(dot(normalize(vDir), normalize(sunDir)), 0.0), 8.0) * 0.18;
          gl_FragColor = vec4(base + sun * (disc + glow), 1.0);
        }`,
    }),
  );
  scene.add(dome);

  const target = pmrem.fromScene(scene, 0.02);
  dome.geometry.dispose();
  (dome.material as THREE.Material).dispose();
  pmrem.dispose();
  return target.texture;
}

function sunDirection(options: EnvironmentOptions): THREE.Vector3 {
  const elevation = THREE.MathUtils.degToRad(options.sunElevationDegrees);
  const azimuth = THREE.MathUtils.degToRad(options.sunAzimuthDegrees);
  return new THREE.Vector3(
    Math.cos(elevation) * Math.cos(azimuth),
    Math.sin(elevation),
    Math.cos(elevation) * Math.sin(azimuth),
  ).normalize();
}

export interface RenderPipelineOptions {
  readonly bloomStrength?: number;
  readonly bloomRadius?: number;
  readonly bloomThreshold?: number;
  readonly grade?: Partial<GradeUniforms>;
  readonly antialias?: boolean;
  readonly environment?: EnvironmentOptions;
}

/**
 * Post-processing system. Registering it makes the engine draw through the
 * composer instead of straight to the canvas.
 */
export class RenderPipeline implements System {
  readonly name = 'render-pipeline';
  private composer: EffectComposer | null = null;
  private grade: ShaderPass | null = null;
  private bloom: UnrealBloomPass | null = null;
  private environmentTexture: THREE.Texture | null = null;
  private engine: Engine | null = null;
  private enabled = true;
  private readonly viewport = new THREE.Vector2();
  private lastWidth = 0;
  private lastHeight = 0;

  constructor(private readonly options: RenderPipelineOptions = {}) {}

  init(app: Engine): void {
    this.engine = app;

    if (this.options.environment) {
      this.environmentTexture = buildEnvironment(app.renderer, this.options.environment);
      app.scene.environment = this.environmentTexture;
    }

    // On the low tier the composer's extra full-screen passes cost more than
    // they return, so the engine keeps rendering directly.
    if (app.quality === 'low') {
      this.enabled = false;
      return;
    }

    const size = new THREE.Vector2();
    app.renderer.getSize(size);
    const composer = new EffectComposer(app.renderer);
    composer.setPixelRatio(app.renderer.getPixelRatio());
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(app.scene, app.camera));

    this.bloom = new UnrealBloomPass(
      size,
      this.options.bloomStrength ?? (app.quality === 'high' ? 0.55 : 0.4),
      this.options.bloomRadius ?? 0.42,
      this.options.bloomThreshold ?? 0.86,
    );
    composer.addPass(this.bloom);

    this.grade = new ShaderPass(GradeShader);
    applyGrade(this.grade, this.options.grade);
    composer.addPass(this.grade);

    if ((this.options.antialias ?? true) && app.quality === 'high') {
      composer.addPass(new SMAAPass(size.x, size.y));
    }
    composer.addPass(new OutputPass());

    this.composer = composer;
    // The engine's own draw call is replaced by the composer.
    app.setExternalRenderer((delta) => {
      if (this.grade) (this.grade.uniforms.time as { value: number }).value += delta;
      composer.render(delta);
    });
  }

  render(ctx: RenderContext): void {
    if (!this.enabled || !this.composer || !this.engine) return;
    // The composer owns its own render targets, so it has to follow the canvas
    // through orientation changes and window resizes.
    this.engine.renderer.getSize(this.viewport);
    if (Math.abs(this.lastWidth - this.viewport.x) > 1 || Math.abs(this.lastHeight - this.viewport.y) > 1) {
      this.lastWidth = this.viewport.x;
      this.lastHeight = this.viewport.y;
      this.composer.setSize(this.viewport.x, this.viewport.y);
      this.bloom?.setSize(this.viewport.x, this.viewport.y);
    }
    void ctx;
  }

  setQuality(tier: QualityTier): void {
    if (!this.bloom) return;
    this.bloom.strength = tier === 'high' ? (this.options.bloomStrength ?? 0.55) : tier === 'medium' ? 0.4 : 0.25;
  }

  dispose(): void {
    this.composer?.dispose();
    this.environmentTexture?.dispose();
    this.engine?.setExternalRenderer(null);
  }
}

function applyGrade(pass: ShaderPass, grade?: Partial<GradeUniforms>): void {
  if (!grade) return;
  const uniforms = pass.uniforms as Record<string, { value: unknown }>;
  for (const [key, value] of Object.entries(grade)) {
    if (uniforms[key]) (uniforms[key] as { value: unknown }).value = value;
  }
}

/**
 * Cascaded-style shadow tuning.
 *
 * A single shadow map stretched over a large world produces either acne or mush.
 * Retargeting the shadow camera to a box around the player each frame keeps
 * texel density high where it is actually seen — the practical 90% of what a
 * full cascade implementation buys, at a fraction of the cost.
 */
export class FocusedShadows implements System {
  readonly name = 'focused-shadows';
  private readonly box = new THREE.Box3();
  private readonly centre = new THREE.Vector3();

  constructor(
    private readonly light: THREE.DirectionalLight,
    private readonly follow: () => THREE.Vector3,
    private readonly extent = 40,
  ) {}

  render(ctx: RenderContext): void {
    const target = this.follow();
    this.box.setFromCenterAndSize(target, new THREE.Vector3(this.extent * 2, this.extent * 2, this.extent * 2));
    this.box.getCenter(this.centre);

    const camera = this.light.shadow.camera;
    camera.left = -this.extent;
    camera.right = this.extent;
    camera.top = this.extent;
    camera.bottom = -this.extent;
    camera.near = 0.5;
    camera.far = this.extent * 6;
    camera.updateProjectionMatrix();

    // Keep the light a fixed distance from the focus so the frustum is stable.
    const direction = this.light.position.clone().sub(this.light.target.position).normalize();
    this.light.target.position.copy(this.centre);
    this.light.position.copy(this.centre).addScaledVector(direction, this.extent * 2.5);
    this.light.target.updateMatrixWorld();
    void ctx;
  }
}
