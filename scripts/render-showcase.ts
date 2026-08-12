import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { findBrowserExecutable } from '../src/lib/qa/browser';
import { generateModel, type ModelKind } from '../src/lib/generation/models/catalog';
import { inspectGlb } from '../src/lib/graphics/gltf';
import { buildAssetFromRecipe } from '../src/lib/generation/recipe/build';
import { RECIPE_EXAMPLES } from '../src/lib/generation/recipe/examples';

/**
 * Renders generated models so their quality can be judged by looking at them.
 *
 * This is not a screenshot of a viewer: it builds the same lighting a game
 * would use — image-based lighting from a generated environment, a key light
 * with soft shadows, bloom and tone mapping — and photographs the model from
 * several angles. A model that only looks acceptable under flat lighting fails
 * here, which is the point.
 *
 *   npx tsx scripts/render-showcase.ts [outputDir]
 */

const args = process.argv.slice(2);
const OUT = args.find((a) => !a.startsWith('--')) ?? path.resolve('var/showcase');
/** Renders one subject at a time; three large models at once exhausts memory. */
const ONLY = args.find((a) => a.startsWith('--only='))?.split('=')[1];
const WIDTH = 1280;
const HEIGHT = 800;

interface Subject {
  readonly kind: ModelKind;
  readonly name: string;
  readonly seed: number;
  readonly palette: readonly string[];
  /** Camera framings: [azimuth°, elevation°, distance multiplier, label]. */
  readonly shots: ReadonlyArray<[number, number, number, string]>;
}

const SUBJECTS: readonly Subject[] = [
  {
    // Proof that the operator set is general: a bouquet has no dedicated
    // machinery in the kernel, only swept curves, radial arrays and bends.
    kind: 'bouquet',
    name: 'roses',
    seed: 4242,
    palette: ['#d33b5c', '#2f5d3a', '#e8c9d2', '#f7e7a1', '#7fb069'],
    shots: [
      [28, 12, 1.0, 'three-quarter'],
      [90, 8, 1.0, 'side'],
      [20, 55, 0.95, 'from-above'],
      [35, 16, 0.5, 'close'],
    ],
  },
  {
    kind: 'vehicle',
    name: 'apex_gt',
    seed: 20260811,
    palette: ['#b3122c', '#0d0f14', '#d8dee9', '#f2a33c', '#39d0c4'],
    shots: [
      [35, 14, 1.0, 'three-quarter-front'],
      [148, 12, 1.0, 'three-quarter-rear'],
      [90, 4, 1.05, 'profile'],
      [12, 46, 1.15, 'high-front'],
    ],
  },
  {
    kind: 'character',
    name: 'operative',
    seed: 77123,
    palette: ['#2f6fed', '#161a22', '#e6ebf5', '#f0a500', '#31c48d'],
    shots: [
      [22, 6, 1.0, 'front'],
      [150, 6, 1.0, 'back'],
      [90, 6, 1.0, 'profile'],
      [30, 26, 0.62, 'head-detail'],
    ],
  },
];

const page = /* html */ `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0a0c11;overflow:hidden}
  canvas{display:block}
</style></head>
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

const W = ${WIDTH}, H = ${HEIGHT};

const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, preserveDrawingBuffer: true });
renderer.setSize(W, H);
renderer.setPixelRatio(1);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.05;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(38, W / H, 0.05, 400);

/**
 * A studio environment built procedurally: a gradient dome plus three emissive
 * softbox panels. Rendered to a PMREM so it drives real image-based lighting —
 * this is what makes clearcoat and metal read as those materials rather than as
 * flat colour.
 */
function buildEnvironment() {
  const env = new THREE.Scene();
  const dome = new THREE.Mesh(
    new THREE.SphereGeometry(60, 32, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: { top: { value: new THREE.Color(0x7d93b8) }, bottom: { value: new THREE.Color(0x0b0d12) } },
      vertexShader: 'varying vec3 vP; void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: 'uniform vec3 top; uniform vec3 bottom; varying vec3 vP; void main(){ float h = clamp(normalize(vP).y*0.5+0.5,0.0,1.0); gl_FragColor = vec4(mix(bottom, top, pow(h,0.7)), 1.0); }',
    }),
  );
  env.add(dome);

  const panel = (x, y, z, w, h, colour, intensity) => {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(w, h),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(colour).multiplyScalar(intensity), side: THREE.DoubleSide }),
    );
    m.position.set(x, y, z);
    m.lookAt(0, y * 0.35, 0);
    env.add(m);
  };
  panel(-14, 12, 10, 22, 16, 0xffffff, 3.4);   // key
  panel(16, 8, -6, 18, 14, 0xbfd4ff, 1.9);     // fill, cool
  panel(0, 16, -16, 26, 10, 0xfff0d8, 2.4);    // rim, warm
  return env;
}

const pmrem = new THREE.PMREMGenerator(renderer);
pmrem.compileEquirectangularShader();
const envTarget = pmrem.fromScene(buildEnvironment(), 0.02);
scene.environment = envTarget.texture;
scene.background = new THREE.Color(0x0a0c11);

// Key light: a real shadow-casting source on top of the IBL, because IBL alone
// gives no contact shadow and the model floats.
const key = new THREE.DirectionalLight(0xfff4e6, 2.6);
key.position.set(-6, 9, 7);
key.castShadow = true;
key.shadow.mapSize.set(2048, 2048);
key.shadow.bias = -0.0006;
key.shadow.normalBias = 0.02;
scene.add(key);

const rim = new THREE.DirectionalLight(0x9ec5ff, 1.4);
rim.position.set(7, 5, -8);
scene.add(rim);

const composer = new EffectComposer(renderer);
composer.addPass(new RenderPass(scene, camera));
const bloom = new UnrealBloomPass(new THREE.Vector2(W, H), 0.32, 0.72, 0.92);
composer.addPass(bloom);
composer.addPass(new OutputPass());

let ground = null;
let current = null;

window.loadModel = async (url) => {
  if (current) { scene.remove(current); current = null; }
  if (ground) { scene.remove(ground); ground = null; }

  const gltf = await new GLTFLoader().loadAsync(url);
  const root = gltf.scene;

  let tris = 0, meshes = 0, materials = new Set(), textures = new Set();
  root.traverse((o) => {
    if (!o.isMesh) return;
    meshes++;
    o.castShadow = true;
    o.receiveShadow = true;
    const g = o.geometry;
    tris += (g.index ? g.index.count : g.attributes.position.count) / 3;
    const list = Array.isArray(o.material) ? o.material : [o.material];
    for (const m of list) {
      materials.add(m.uuid);
      for (const slot of ['map','normalMap','roughnessMap','metalnessMap','aoMap','emissiveMap']) {
        if (m[slot]) textures.add(m[slot].uuid);
      }
      if (m.map) m.map.anisotropy = 8;
    }
  });

  const box = new THREE.Box3().setFromObject(root);
  const size = box.getSize(new THREE.Vector3());
  const centre = box.getCenter(new THREE.Vector3());
  root.position.sub(centre);
  root.position.y += size.y / 2;
  scene.add(root);
  current = root;

  const radius = Math.max(size.x, size.y, size.z);

  // A reflective floor: contact shadows and a grounded reflection are most of
  // what makes a render read as a real object rather than a floating mesh.
  ground = new THREE.Mesh(
    new THREE.CircleGeometry(radius * 6, 96).rotateX(-Math.PI / 2),
    new THREE.MeshStandardMaterial({ color: 0x14181f, roughness: 0.35, metalness: 0.1 }),
  );
  ground.receiveShadow = true;
  scene.add(ground);

  const span = radius * 2.2;
  key.shadow.camera.left = -span; key.shadow.camera.right = span;
  key.shadow.camera.top = span; key.shadow.camera.bottom = -span;
  key.shadow.camera.near = 0.1; key.shadow.camera.far = span * 8;
  key.position.set(-radius * 1.3, radius * 1.9, radius * 1.5);
  key.target.position.set(0, size.y * 0.45, 0);
  key.target.updateMatrixWorld();
  key.shadow.camera.updateProjectionMatrix();
  rim.position.set(radius * 1.6, radius * 1.1, -radius * 1.7);

  return { triangles: Math.round(tris), meshes, materials: materials.size, textures: textures.size,
           size: { x: +size.x.toFixed(2), y: +size.y.toFixed(2), z: +size.z.toFixed(2) }, radius };
};

window.shoot = (azimuth, elevation, distanceScale, focusY) => {
  const box = new THREE.Box3().setFromObject(current);
  const size = box.getSize(new THREE.Vector3());
  const radius = Math.max(size.x, size.y, size.z);
  const dist = radius * 1.85 * distanceScale;

  const a = (azimuth * Math.PI) / 180;
  const e = (elevation * Math.PI) / 180;
  const target = new THREE.Vector3(0, focusY !== undefined ? focusY : size.y * 0.45, 0);

  camera.position.set(
    target.x + Math.cos(e) * Math.sin(a) * dist,
    target.y + Math.sin(e) * dist,
    target.z + Math.cos(e) * Math.cos(a) * dist,
  );
  camera.lookAt(target);
  camera.updateProjectionMatrix();
  composer.render();
  return true;
};

window.__ready = true;
</script>
</body></html>`;

async function main(): Promise<void> {
  const executable = findBrowserExecutable();
  if (!executable) throw new Error('no Chromium executable found');

  fs.mkdirSync(OUT, { recursive: true });
  const glbDir = path.join(OUT, 'glb');
  fs.mkdirSync(glbDir, { recursive: true });

  // Generate first, so the server can serve real files.
  const isRecipeName = ONLY ? RECIPE_EXAMPLES.some((e) => e.recipe.name === ONLY) : false;
  const subjects =
    ONLY === 'recipes' || isRecipeName ? [] : ONLY ? SUBJECTS.filter((s) => s.name === ONLY || s.kind === ONLY) : SUBJECTS;
  if (subjects.length === 0 && ONLY !== 'recipes' && !isRecipeName) {
    throw new Error(`no subject matches "${ONLY ?? ''}"`);
  }

  const generated: Array<{ subject: Subject; file: string; stats: Record<string, unknown> }> = [];

  // Recipes render alongside the hand-written generators, because the whole
  // point is that they are the same kind of asset by the time they reach a game.
  const recipeFilter = ONLY && ONLY !== 'recipes' ? ONLY : null;
  if (!ONLY || ONLY === 'recipes' || RECIPE_EXAMPLES.some((e) => e.recipe.name === ONLY)) {
    for (const example of RECIPE_EXAMPLES) {
      if (recipeFilter && example.recipe.name !== recipeFilter) continue;
      process.stdout.write(`building recipe "${example.recipe.name}"…\n`);
      // Each example carries its own palette: a dark-green utility vehicle and a
      // crimson hypercar cannot share one.
      const palette =
        example.recipe.name === 'trail_utility_4x4'
          ? ['#4e7a52', '#2a2f2a', '#aeb8c4', '#0d1116', '#ffe9b8', '#15150f', '#1a1a14']
          : ['#8c1230', '#ff3355', '#c9d1de', '#101418', '#8892a0', '#555a63', '#17171b'];
      const built = buildAssetFromRecipe(example.recipe, {
        palette,
        seed: 4242,
        textureSize: 1024,
      });
      const file = path.join(glbDir, `${built.name}.glb`);
      fs.writeFileSync(file, built.glb);
      process.stdout.write(
        `  ${(built.glb.length / 1024 / 1024).toFixed(2)} MB · ${built.triangleCount} triangles · ` +
          `${built.materialCount} materials · ${built.textureCount} textures · ${built.stats.steps} steps in ${built.stats.durationMs}ms\n`,
      );
      generated.push({
        subject: {
          kind: 'character',
          name: built.name,
          seed: 0,
          palette: [],
          shots: [
            [32, 12, 1.0, 'three-quarter'],
            [90, 4, 1.0, 'side'],
            [0, 6, 1.0, 'front'],
            [25, 50, 1.0, 'above'],
          ],
        },
        file,
        stats: { bytes: built.glb.length, triangles: built.triangleCount, warnings: built.warnings },
      });
    }
  }

  for (const subject of subjects) {
    process.stdout.write(`generating ${subject.kind} "${subject.name}"…\n`);
    const started = Date.now();
    const model = generateModel({
      kind: subject.kind,
      name: subject.name,
      seed: subject.seed,
      palette: subject.palette,
      textureSize: 1024,
      smoothness: 2,
    });
    const file = path.join(glbDir, `${subject.name}.glb`);
    fs.writeFileSync(file, model.glb);
    const summary = inspectGlb(model.glb);
    generated.push({
      subject,
      file,
      stats: {
        ms: Date.now() - started,
        bytes: model.glb.length,
        storedTriangles: model.triangleCount,
        renderedTriangles: model.renderedTriangleCount,
        vertices: summary.vertices,
        materials: model.materialCount,
        textures: model.textureCount,
        skins: summary.skins,
        animations: summary.animations,
        warnings: model.warnings,
      },
    });
    process.stdout.write(
      `  ${(model.glb.length / 1024 / 1024).toFixed(2)} MB · ${model.triangleCount} stored / ${model.renderedTriangleCount} rendered triangles · ` +
        `${model.materialCount} materials · ${model.textureCount} textures · ${summary.animations} animations\n`,
    );
    if (model.warnings.length > 0) process.stdout.write(`  warnings: ${model.warnings.join('; ')}\n`);
  }

  const threePkg = path.resolve('node_modules/three');
  if (!fs.existsSync(path.join(threePkg, 'build/three.module.js'))) {
    throw new Error(`three.js was not found at ${threePkg}`);
  }

  const server = http.createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0] as string;
    try {
      if (url === '/' || url === '/index.html') {
        response.writeHead(200, { 'content-type': 'text/html' });
        response.end(page);
        return;
      }
      const file = url.startsWith('/three/')
        ? path.join(threePkg, url.slice('/three/'.length))
        : path.join(OUT, url.replace(/^\//, ''));
      const type = file.endsWith('.js')
        ? 'text/javascript'
        : file.endsWith('.glb')
          ? 'model/gltf-binary'
          : 'application/octet-stream';
      // Read before writing the header: a missing file must produce a 404, and
      // a header already sent cannot be taken back.
      const body = fs.readFileSync(file);
      response.writeHead(200, { 'content-type': type });
      response.end(body);
    } catch {
      if (!response.headersSent) response.writeHead(404);
      response.end('not found');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;

  const browser = await chromium.launch({
    executablePath: executable,
    headless: true,
    args: ['--no-sandbox', '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--disable-dev-shm-usage'],
  });
  const context = await browser.newContext({ viewport: { width: WIDTH, height: HEIGHT } });
  const browserPage = await context.newPage();
  const failures: string[] = [];
  browserPage.on('pageerror', (error) => failures.push(error.message));
  browserPage.on('console', (message) => {
    if (message.type() === 'error') failures.push(message.text());
  });

  await browserPage.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
  await browserPage.waitForFunction('window.__ready === true', undefined, { timeout: 60_000 });

  const report: Record<string, unknown>[] = [];
  for (const entry of generated) {
    const url = `/glb/${path.basename(entry.file)}`;
    const loaded = (await browserPage.evaluate(
      (u) => (window as unknown as { loadModel: (u: string) => Promise<unknown> }).loadModel(u),
      url,
    )) as Record<string, unknown>;
    process.stdout.write(`rendering ${entry.subject.name}: ${JSON.stringify(loaded)}\n`);

    for (const [azimuth, elevation, distance, label] of entry.subject.shots) {
      // The head shot needs its own focus height; everything else frames the body.
      const focusY =
        label === 'head-detail' ? ((loaded.size as { y: number }).y ?? 1) * 0.88 : undefined;
      await browserPage.evaluate(
        ([a, e, d, f]) =>
          (window as unknown as { shoot: (a: number, e: number, d: number, f?: number) => boolean }).shoot(
            a as number,
            e as number,
            d as number,
            f as number | undefined,
          ),
        [azimuth, elevation, distance, focusY] as const,
      );
      const out = path.join(OUT, `${entry.subject.name}-${label}.png`);
      await browserPage.screenshot({ path: out });
      process.stdout.write(`  → ${path.basename(out)}\n`);
    }
    report.push({ name: entry.subject.name, kind: entry.subject.kind, ...entry.stats, runtime: loaded });
  }

  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));

  await browser.close();
  server.close();

  if (failures.length > 0) {
    process.stderr.write(`\nrenderer reported ${failures.length} errors:\n${failures.join('\n')}\n`);
    process.exit(1);
  }
  process.stdout.write(`\nwrote ${OUT}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  process.exit(1);
});
