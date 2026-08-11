import * as THREE from 'three';

/**
 * Engine core: renderer bootstrap, fixed-timestep simulation loop, adaptive
 * quality and the diagnostics bridge the factory's preview loop observes.
 *
 * This module is platform-authored infrastructure that is copied into every
 * generated 3D product. Game-specific behaviour lives in the generated systems
 * that register against it — the engine never encodes what a game *is*.
 */

export type QualityTier = 'low' | 'medium' | 'high';

export interface QualityProfile {
  readonly pixelRatioCap: number;
  readonly shadows: boolean;
  readonly shadowMapSize: number;
  readonly anisotropy: number;
  readonly viewDistance: number;
  readonly particleBudget: number;
  readonly antialias: boolean;
}

export const QUALITY_PROFILES: Record<QualityTier, QualityProfile> = {
  low: { pixelRatioCap: 1, shadows: false, shadowMapSize: 512, anisotropy: 1, viewDistance: 180, particleBudget: 200, antialias: false },
  medium: { pixelRatioCap: 1.5, shadows: true, shadowMapSize: 1024, anisotropy: 4, viewDistance: 320, particleBudget: 600, antialias: true },
  high: { pixelRatioCap: 2, shadows: true, shadowMapSize: 2048, anisotropy: 8, viewDistance: 520, particleBudget: 1500, antialias: true },
};

export interface FrameContext {
  /** Fixed simulation step in seconds. */
  readonly dt: number;
  /** Seconds since the loop started. */
  readonly elapsed: number;
  readonly frame: number;
  readonly app: Engine;
}

export interface RenderContext {
  /** Interpolation factor between the last two simulation steps, 0..1. */
  readonly alpha: number;
  readonly elapsed: number;
  readonly app: Engine;
}

export interface System {
  readonly name: string;
  /** Called once after the engine is ready and assets are loaded. */
  init?(app: Engine): void | Promise<void>;
  /** Fixed-rate simulation update. */
  update?(ctx: FrameContext): void;
  /** Called once per rendered frame, before the draw call. */
  render?(ctx: RenderContext): void;
  /** Called on teardown; must release GPU resources it created. */
  dispose?(): void;
}

export interface EngineOptions {
  readonly canvas?: HTMLCanvasElement;
  readonly container?: HTMLElement;
  readonly quality?: QualityTier;
  /** Simulation rate in Hz. 60 is the default; physics-heavy games may raise it. */
  readonly simulationHz?: number;
  readonly clearColor?: number;
  readonly maxSubSteps?: number;
}

export interface PerformanceSample {
  readonly fps: number;
  readonly frameMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly programs: number;
  readonly geometries: number;
  readonly textures: number;
  readonly quality: QualityTier;
}

/** Diagnostics channel consumed by the factory's preview harness. */
export interface DiagnosticEvent {
  readonly type: 'ready' | 'error' | 'performance' | 'state' | 'test';
  readonly payload: Record<string, unknown>;
}

export function reportDiagnostic(event: DiagnosticEvent): void {
  const message = { source: 'adaf-runtime', ...event, ts: Date.now() };
  try {
    window.parent?.postMessage(message, '*');
  } catch {
    /* preview harness absent: the game still runs standalone */
  }
  const bucket = (window as unknown as { __adafDiagnostics?: unknown[] }).__adafDiagnostics ?? [];
  bucket.push(message);
  (window as unknown as { __adafDiagnostics?: unknown[] }).__adafDiagnostics = bucket.slice(-200);
}

export class Engine {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene: THREE.Scene;
  readonly camera: THREE.PerspectiveCamera;
  readonly clock = new THREE.Clock(false);
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;

  quality: QualityTier;
  profile: QualityProfile;
  paused = false;

  private readonly systems: System[] = [];
  private readonly stepSeconds: number;
  private readonly maxSubSteps: number;
  private accumulator = 0;
  private elapsed = 0;
  private frame = 0;
  private running = false;
  private rafHandle = 0;
  private lastPerfEmit = 0;
  private externalRenderer: ((deltaSeconds: number) => void) | null = null;
  private fpsWindow: number[] = [];
  private disposed = false;

  constructor(options: EngineOptions = {}) {
    this.container = options.container ?? document.body;
    this.canvas = options.canvas ?? document.createElement('canvas');
    if (!this.canvas.parentElement) this.container.appendChild(this.canvas);

    this.quality = options.quality ?? detectQuality();
    this.profile = QUALITY_PROFILES[this.quality];
    this.stepSeconds = 1 / (options.simulationHz ?? 60);
    this.maxSubSteps = options.maxSubSteps ?? 5;

    this.renderer = new THREE.WebGLRenderer({
      canvas: this.canvas,
      antialias: this.profile.antialias,
      powerPreference: 'high-performance',
      alpha: false,
      stencil: false,
    });
    this.renderer.setClearColor(options.clearColor ?? 0x0a0d16, 1);
    this.renderer.shadowMap.enabled = this.profile.shadows;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.1, this.profile.viewDistance);
    this.camera.position.set(0, 4, 8);

    this.applyViewportSize();
    window.addEventListener('resize', this.handleResize, { passive: true });
    document.addEventListener('visibilitychange', this.handleVisibility);
    this.canvas.addEventListener('webglcontextlost', this.handleContextLost as EventListener, false);
    this.canvas.addEventListener('webglcontextrestored', this.handleContextRestored as EventListener, false);
    window.addEventListener('error', this.handleWindowError);
    window.addEventListener('unhandledrejection', this.handleRejection);
  }

  add(system: System): this {
    this.systems.push(system);
    return this;
  }

  get<T extends System>(name: string): T | undefined {
    return this.systems.find((s) => s.name === name) as T | undefined;
  }

  async start(): Promise<void> {
    for (const system of this.systems) await system.init?.(this);
    // Exposed for the factory's runtime inspector and the in-IDE debugger.
    (window as unknown as { __adafEngine?: Engine }).__adafEngine = this;
    this.clock.start();
    this.running = true;
    this.accumulator = 0;
    this.rafHandle = requestAnimationFrame(this.tick);
    reportDiagnostic({
      type: 'ready',
      payload: { quality: this.quality, systems: this.systems.map((s) => s.name), rendererInfo: this.renderer.capabilities.isWebGL2 ? 'webgl2' : 'webgl' },
    });
  }

  stop(): void {
    this.running = false;
    if (this.rafHandle) cancelAnimationFrame(this.rafHandle);
    this.rafHandle = 0;
    this.clock.stop();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    for (const system of this.systems) system.dispose?.();
    window.removeEventListener('resize', this.handleResize);
    document.removeEventListener('visibilitychange', this.handleVisibility);
    this.canvas.removeEventListener('webglcontextlost', this.handleContextLost as EventListener);
    this.canvas.removeEventListener('webglcontextrestored', this.handleContextRestored as EventListener);
    window.removeEventListener('error', this.handleWindowError);
    window.removeEventListener('unhandledrejection', this.handleRejection);
    disposeObject(this.scene);
    this.renderer.dispose();
  }

  /**
   * Replaces the direct draw call with a custom renderer (the post-processing
   * composer). Passing null restores direct rendering.
   */
  setExternalRenderer(render: ((deltaSeconds: number) => void) | null): void {
    this.externalRenderer = render;
  }

  setQuality(tier: QualityTier): void {
    this.quality = tier;
    this.profile = QUALITY_PROFILES[tier];
    this.renderer.shadowMap.enabled = this.profile.shadows;
    this.camera.far = this.profile.viewDistance;
    this.camera.updateProjectionMatrix();
    this.applyViewportSize();
    reportDiagnostic({ type: 'state', payload: { quality: tier } });
  }

  performance(): PerformanceSample {
    const info = this.renderer.info;
    const fps = this.fpsWindow.length === 0 ? 0 : this.fpsWindow.reduce((a, b) => a + b, 0) / this.fpsWindow.length;
    return {
      fps: Number(fps.toFixed(1)),
      frameMs: fps > 0 ? Number((1000 / fps).toFixed(2)) : 0,
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      programs: info.programs?.length ?? 0,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      quality: this.quality,
    };
  }

  private applyViewportSize(): void {
    const width = Math.max(1, this.container.clientWidth || window.innerWidth);
    const height = Math.max(1, this.container.clientHeight || window.innerHeight);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, this.profile.pixelRatioCap));
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
  }

  private readonly handleResize = (): void => this.applyViewportSize();

  private readonly handleVisibility = (): void => {
    this.paused = document.hidden;
    if (!document.hidden) this.accumulator = 0;
  };

  private readonly handleContextLost = (event: Event): void => {
    event.preventDefault();
    this.stop();
    reportDiagnostic({ type: 'error', payload: { kind: 'webgl_context_lost' } });
  };

  private readonly handleContextRestored = (): void => {
    reportDiagnostic({ type: 'state', payload: { kind: 'webgl_context_restored' } });
    this.running = true;
    this.clock.start();
    this.rafHandle = requestAnimationFrame(this.tick);
  };

  private readonly handleWindowError = (event: ErrorEvent): void => {
    reportDiagnostic({
      type: 'error',
      payload: { kind: 'runtime_error', message: event.message, source: event.filename, line: event.lineno, column: event.colno },
    });
  };

  private readonly handleRejection = (event: PromiseRejectionEvent): void => {
    reportDiagnostic({ type: 'error', payload: { kind: 'unhandled_rejection', message: String(event.reason) } });
  };

  private readonly tick = (): void => {
    if (!this.running) return;
    this.rafHandle = requestAnimationFrame(this.tick);

    const delta = Math.min(this.clock.getDelta(), 0.25);
    if (this.paused) return;

    this.fpsWindow.push(delta > 0 ? 1 / delta : 0);
    if (this.fpsWindow.length > 90) this.fpsWindow.shift();

    this.accumulator += delta;
    let steps = 0;
    while (this.accumulator >= this.stepSeconds && steps < this.maxSubSteps) {
      this.elapsed += this.stepSeconds;
      this.frame += 1;
      const ctx: FrameContext = { dt: this.stepSeconds, elapsed: this.elapsed, frame: this.frame, app: this };
      for (const system of this.systems) system.update?.(ctx);
      this.accumulator -= this.stepSeconds;
      steps += 1;
    }
    if (steps === this.maxSubSteps) this.accumulator = 0;

    const alpha = this.accumulator / this.stepSeconds;
    const renderCtx: RenderContext = { alpha, elapsed: this.elapsed, app: this };
    for (const system of this.systems) system.render?.(renderCtx);
    if (this.externalRenderer) this.externalRenderer(delta);
    else this.renderer.render(this.scene, this.camera);

    const now = performance.now();
    if (now - this.lastPerfEmit > 2000) {
      this.lastPerfEmit = now;
      const sample = this.performance();
      reportDiagnostic({ type: 'performance', payload: { ...sample } });
      this.adaptQuality(sample);
    }
  };

  /** Drops one quality tier when the frame budget is persistently missed. */
  private adaptQuality(sample: PerformanceSample): void {
    if (sample.fps === 0) return;
    if (sample.fps < 28 && this.quality === 'high') this.setQuality('medium');
    else if (sample.fps < 24 && this.quality === 'medium') this.setQuality('low');
  }
}

export function detectQuality(): QualityTier {
  const memory = (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? 4;
  const cores = navigator.hardwareConcurrency ?? 4;
  const coarse = window.matchMedia?.('(pointer: coarse)').matches ?? false;
  if (memory <= 2 || cores <= 2) return 'low';
  if (coarse && memory <= 4) return 'medium';
  return memory >= 8 && cores >= 8 ? 'high' : 'medium';
}

/** Recursively releases geometries, materials and textures under `root`. */
export function disposeObject(root: THREE.Object3D): void {
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    mesh.geometry?.dispose?.();
    const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(material)) material.forEach(disposeMaterial);
    else if (material) disposeMaterial(material);
  });
  root.clear();
}

function disposeMaterial(material: THREE.Material): void {
  for (const value of Object.values(material as unknown as Record<string, unknown>)) {
    if (value instanceof THREE.Texture) value.dispose();
  }
  material.dispose();
}
