import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { chromium, type Browser } from 'playwright-core';
import { findBrowserExecutable } from '@/lib/qa/browser';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('generation.review.render');

/**
 * Photographs a generated asset so it can be judged.
 *
 * Two kinds of image come back, and the second matters more than it looks:
 *
 *  - lit views under studio image-based lighting, which is how the asset will
 *    actually be seen;
 *  - a flat black silhouette against white.
 *
 * The silhouette is the one that catches structural failure. Recognition of an
 * object happens overwhelmingly at the level of its outline — modellers squint
 * at their work for exactly this reason — and a lit render hides a bad shape
 * behind material and specular detail. A lantern whose housing does not read as
 * a separate mass looks passable lit and obviously wrong as a silhouette.
 */

export interface AssetView {
  readonly label: string;
  readonly png: Buffer;
  readonly kind: 'lit' | 'silhouette';
}

export interface RenderReviewResult {
  readonly views: readonly AssetView[];
  readonly measured: {
    readonly triangles: number;
    readonly meshes: number;
    readonly materials: number;
    readonly textures: number;
    readonly sizeMetres: { x: number; y: number; z: number };
  };
  readonly runtimeErrors: readonly string[];
}

export interface RenderOptions {
  readonly width?: number;
  readonly height?: number;
  /** [azimuth°, elevation°, distance multiplier, label] */
  readonly shots?: ReadonlyArray<readonly [number, number, number, string]>;
  readonly includeSilhouette?: boolean;
  readonly timeoutMs?: number;
}

/**
 * Default framings.
 *
 * Front, side and three-quarter are the views a modeller checks first: they are
 * the ones in which proportion errors are unmissable. The high view catches
 * layout mistakes that all three elevations hide.
 */
const DEFAULT_SHOTS: ReadonlyArray<readonly [number, number, number, string]> = [
  [35, 12, 1.0, 'three-quarter'],
  [0, 4, 1.0, 'front'],
  [90, 4, 1.0, 'side'],
  [30, 52, 1.05, 'above'],
];

const PAGE = (width: number, height: number): string => /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;background:#0a0c11;overflow:hidden}canvas{display:block}</style></head>
<body>
<script type="importmap">
{ "imports": { "three": "/three/build/three.module.js", "three/addons/": "/three/examples/jsm/" } }
</script>
<script type="module">
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

const W = ${width}, H = ${height};
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(36, W / H, 0.01, 500);

function studio() {
  const env = new THREE.Scene();
  env.add(new THREE.Mesh(
    new THREE.SphereGeometry(60, 32, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { top: { value: new THREE.Color(0x8095b8) }, bottom: { value: new THREE.Color(0x0b0d12) } },
      vertexShader: 'varying vec3 vP; void main(){ vP=position; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h=clamp(normalize(vP).y*0.5+0.5,0.0,1.0); gl_FragColor=vec4(mix(bottom,top,pow(h,0.7)),1.0); }',
    }),
  ));
  const panel = (x,y,z,w,h,c,i) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w,h), new THREE.MeshBasicMaterial({ color: new THREE.Color(c).multiplyScalar(i), side: THREE.DoubleSide }));
    m.position.set(x,y,z); m.lookAt(0, y*0.35, 0); env.add(m);
  };
  panel(-14,12,10,22,16,0xffffff,3.6);
  panel(16,8,-6,18,14,0xbfd4ff,2.0);
  panel(0,16,-16,26,10,0xfff0d8,2.5);
  return env;
}

const pmrem = new THREE.PMREMGenerator(renderer);
const envTarget = pmrem.fromScene(studio(), 0.02);
scene.environment = envTarget.texture;
scene.background = new THREE.Color(0x0a0c11);

const key = new THREE.DirectionalLight(0xfff4e6, 2.6);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.02;
scene.add(key, key.target);
const rim = new THREE.DirectionalLight(0x9ec5ff, 1.4);
scene.add(rim);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
composer.addPass(new UnrealBloomPass(new THREE.Vector2(W,H), 0.3, 0.7, 0.92));
composer.addPass(new OutputPass());

let current = null, ground = null, size = null, originals = new Map();

window.loadModel = async (url) => {
  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;
  let tris = 0, meshes = 0;
  const materials = new Set(), textures = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    o.castShadow = true; o.receiveShadow = true;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
      materials.add(m.uuid);
      for (const s of ['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap']) if (m[s]) textures.add(m[s].uuid);
      if (m.map) m.map.anisotropy = 8;
    }
    originals.set(o.uuid, o.material);
  });

  const bbox = new THREE.Box3().setFromObject(root);
  size = bbox.getSize(new THREE.Vector3());
  const centre = bbox.getCenter(new THREE.Vector3());
  root.position.sub(centre);
  root.position.y += size.y / 2;
  scene.add(root);
  current = root;

  const r = Math.max(size.x, size.y, size.z);
  ground = new THREE.Mesh(new THREE.CircleGeometry(r*6, 96).rotateX(-Math.PI/2),
    new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.35, metalness: 0.1 }));
  ground.receiveShadow = true;
  scene.add(ground);

  const span = r * 2.2;
  Object.assign(key.shadow.camera, { left:-span, right:span, top:span, bottom:-span, near:0.1, far:span*8 });
  key.shadow.camera.updateProjectionMatrix();
  key.position.set(-r*1.3, r*1.9, r*1.5);
  key.target.position.set(0, size.y*0.45, 0);
  key.target.updateMatrixWorld();
  rim.position.set(r*1.6, r*1.1, -r*1.7);

  return { triangles: Math.round(tris), meshes, materials: materials.size, textures: textures.size,
           sizeMetres: { x:+size.x.toFixed(3), y:+size.y.toFixed(3), z:+size.z.toFixed(3) } };
};

/**
 * Silhouette mode: every surface becomes flat black, the ground and the
 * environment become white, and post-processing is bypassed. What is left is
 * pure outline.
 */
window.setSilhouette = (on) => {
  if (!current) return false;
  if (on) {
    scene.background = new THREE.Color(0xffffff);
    scene.environment = null;
    if (ground) ground.visible = false;
    current.traverse((o) => { if (o.isMesh) o.material = new THREE.MeshBasicMaterial({ color: 0x000000 }); });
  } else {
    scene.background = new THREE.Color(0x0a0c11);
    scene.environment = envTarget.texture;
    if (ground) ground.visible = true;
    current.traverse((o) => { if (o.isMesh && originals.has(o.uuid)) o.material = originals.get(o.uuid); });
  }
  return true;
};

window.shoot = (azimuth, elevation, distanceScale, silhouette) => {
  const r = Math.max(size.x, size.y, size.z);
  const dist = r * 1.9 * distanceScale;
  const a = azimuth * Math.PI / 180, e = elevation * Math.PI / 180;
  const target = new THREE.Vector3(0, size.y * 0.45, 0);
  camera.position.set(
    target.x + Math.cos(e)*Math.sin(a)*dist,
    target.y + Math.sin(e)*dist,
    target.z + Math.cos(e)*Math.cos(a)*dist,
  );
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  if (silhouette) renderer.render(scene, camera);
  else composer.render();
  return true;
};

window.__ready = true;
</script></body></html>`;

/**
 * Renders an asset for review. The browser is launched per call and closed
 * afterwards: a review runs once per asset, and a leaked browser across a
 * day of unattended generation is far more expensive than the launch cost.
 */
export async function renderForReview(glb: Buffer, options: RenderOptions = {}): Promise<RenderReviewResult> {
  const executable = findBrowserExecutable();
  if (!executable) {
    throw new Error('visual review needs a Chromium executable; set BROWSER_EXECUTABLE_PATH');
  }

  const width = options.width ?? 900;
  const height = options.height ?? 700;
  const shots = options.shots ?? DEFAULT_SHOTS;
  const threeRoot = path.resolve('node_modules/three');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adaf-review-'));
  const glbPath = path.join(workDir, 'asset.glb');
  fs.writeFileSync(glbPath, glb);

  const server = http.createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0] as string;
    try {
      if (url === '/' || url === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(PAGE(width, height));
        return;
      }
      const file = url.startsWith('/three/') ? path.join(threeRoot, url.slice('/three/'.length)) : path.join(workDir, url.replace(/^\//, ''));
      const body = fs.readFileSync(file);
      response.writeHead(200, {
        'content-type': file.endsWith('.js') ? 'text/javascript' : file.endsWith('.glb') ? 'model/gltf-binary' : 'application/octet-stream',
      });
      response.end(body);
    } catch {
      if (!response.headersSent) response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  let browser: Browser | null = null;
  const runtimeErrors: string[] = [];

  try {
    browser = await chromium.launch({
      executablePath: executable,
      headless: true,
      args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
    });
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    page.on('pageerror', (error) => runtimeErrors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error') runtimeErrors.push(message.text());
    });

    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: options.timeoutMs ?? 60_000 });
    await page.waitForFunction('window.__ready === true', undefined, { timeout: options.timeoutMs ?? 60_000 });

    const measured = (await page.evaluate(
      (url) => (window as unknown as { loadModel: (u: string) => Promise<unknown> }).loadModel(url),
      '/asset.glb',
    )) as RenderReviewResult['measured'];

    const views: AssetView[] = [];

    for (const [azimuth, elevation, distance, label] of shots) {
      await page.evaluate(
        ([a, e, d]) => (window as unknown as { shoot: (a: number, e: number, d: number, s: boolean) => boolean }).shoot(a as number, e as number, d as number, false),
        [azimuth, elevation, distance] as const,
      );
      views.push({ label, kind: 'lit', png: await page.screenshot({ type: 'png' }) });
    }

    if (options.includeSilhouette !== false) {
      await page.evaluate(() => (window as unknown as { setSilhouette: (on: boolean) => boolean }).setSilhouette(true));
      // Two silhouettes are enough: the profile and the front elevation are
      // where a wrong outline is most obvious.
      for (const [azimuth, elevation, distance, label] of [
        [90, 2, 1.0, 'side'],
        [0, 2, 1.0, 'front'],
      ] as const) {
        await page.evaluate(
          ([a, e, d]) => (window as unknown as { shoot: (a: number, e: number, d: number, s: boolean) => boolean }).shoot(a as number, e as number, d as number, true),
          [azimuth, elevation, distance] as const,
        );
        views.push({ label: `${label}-silhouette`, kind: 'silhouette', png: await page.screenshot({ type: 'png' }) });
      }
    }

    return { views, measured, runtimeErrors };
  } finally {
    await browser?.close();
    server.close();
    fs.rmSync(workDir, { recursive: true, force: true });
    if (runtimeErrors.length > 0) log.warn('renderer reported errors during review', { count: runtimeErrors.length });
  }
}
