import fs from 'node:fs';
import path from 'node:path';
import { workspaceFor, type Project } from '@/lib/workspace/project';
import type { WorkspaceFs } from '@/lib/workspace/filesystem';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('generation.scaffold');

/**
 * Project scaffolding.
 *
 * Writes the *infrastructure* every generated product needs — HTML shell, PWA
 * manifest and service worker, TypeScript configuration, package manifest, the
 * runtime SDK, and the harness the automated runtime tests attach to.
 *
 * It deliberately writes no product logic: gameplay, screens, data models and
 * content all come from the design and coding agents. The scaffold is the
 * equivalent of a framework's project template, not the product.
 */

export interface BrandIdentity {
  readonly name: string;
  readonly tagline: string;
  readonly primary: string;
  readonly secondary: string;
  readonly accent: string;
  readonly background: string;
  readonly surface: string;
  readonly text: string;
  readonly fontStack: string;
  readonly toneKeywords: readonly string[];
}

export interface ScaffoldOptions {
  readonly project: Project;
  readonly kind: 'app' | 'game' | 'hybrid';
  readonly brand: BrandIdentity;
  readonly description: string;
  readonly seed: number;
}

/** Absolute path to the platform-authored runtime SDK sources. */
export function runtimeSourceDir(): string {
  const candidates = [
    path.join(process.cwd(), 'src', 'runtime'),
    path.join(process.cwd(), '..', 'src', 'runtime'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'engine', 'index.ts'))) return candidate;
  }
  throw new Error(
    'Runtime SDK sources not found. Expected src/runtime/engine relative to the working directory; ' +
      'ensure the deployment includes src/runtime.',
  );
}

function copyRuntime(target: WorkspaceFs, subdirectory: 'engine' | 'appkit'): string[] {
  const source = path.join(runtimeSourceDir(), subdirectory);
  const written: string[] = [];
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
    const relative = `src/${subdirectory}/${entry.name}`;
    target.write(relative, fs.readFileSync(path.join(source, entry.name)));
    written.push(relative);
  }
  return written;
}

function indexHtml(options: ScaffoldOptions): string {
  const { brand, kind } = options;
  const mount = kind === 'game' ? '<canvas id="stage" aria-label="Game viewport"></canvas>' : '<main id="app" class="app-root"></main>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, user-scalable=no" />
<meta name="theme-color" content="${brand.background}" />
<meta name="description" content="${escapeAttribute(options.description)}" />
<meta name="mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<title>${escapeHtml(brand.name)}</title>
<link rel="manifest" href="./manifest.webmanifest" />
<link rel="icon" type="image/png" href="./assets/icons/icon-192.png" />
<link rel="apple-touch-icon" href="./assets/icons/icon-192.png" />
<link rel="stylesheet" href="./styles.css" />
</head>
<body class="${kind === 'game' ? 'is-game' : 'is-app'}">
<noscript>This product requires JavaScript.</noscript>
<div id="boot" class="boot">
  <img src="./assets/icons/icon-192.png" width="88" height="88" alt="" />
  <p class="boot-name">${escapeHtml(brand.name)}</p>
  <div class="boot-bar"><i></i></div>
</div>
${mount}
<script type="module" src="./bundle.js"></script>
</body>
</html>
`;
}

function stylesCss(brand: BrandIdentity, kind: string): string {
  return `:root{
  --brand-primary:${brand.primary};
  --brand-secondary:${brand.secondary};
  --brand-accent:${brand.accent};
  --brand-bg:${brand.background};
  --brand-surface:${brand.surface};
  --brand-text:${brand.text};
  --brand-font:${brand.fontStack};
  --radius:14px;
}
*{box-sizing:border-box}
html,body{margin:0;padding:0;height:100%;background:var(--brand-bg);color:var(--brand-text);font-family:var(--brand-font);
  -webkit-font-smoothing:antialiased;overscroll-behavior:none}
body.is-game{overflow:hidden;touch-action:none}
canvas#stage{display:block;width:100%;height:100%;outline:none}
.app-root{min-height:100%;padding:max(16px,env(safe-area-inset-top)) 16px calc(24px + env(safe-area-inset-bottom));max-width:820px;margin:0 auto}
.boot{position:fixed;inset:0;display:grid;place-content:center;justify-items:center;gap:14px;background:var(--brand-bg);z-index:50;
  transition:opacity .35s ease}
.boot[hidden]{display:none}
.boot.is-done{opacity:0;pointer-events:none}
.boot img{border-radius:22%;box-shadow:0 18px 50px rgba(0,0,0,.45)}
.boot-name{margin:0;font-size:18px;font-weight:600;letter-spacing:.01em}
.boot-bar{width:180px;height:6px;border-radius:999px;background:rgba(255,255,255,.14);overflow:hidden}
.boot-bar>i{display:block;height:100%;width:35%;background:var(--brand-accent);animation:boot-slide 1.1s ease-in-out infinite}
@keyframes boot-slide{0%{transform:translateX(-100%)}100%{transform:translateX(320%)}}
.view{display:grid;gap:16px}
.card{background:var(--brand-surface);border:1px solid rgba(255,255,255,.1);border-radius:var(--radius);padding:16px}
.button{appearance:none;border:0;border-radius:var(--radius);background:var(--brand-primary);color:var(--brand-bg);
  font:600 15px/1 var(--brand-font);padding:13px 18px;cursor:pointer}
.button.secondary{background:transparent;border:1px solid rgba(255,255,255,.2);color:var(--brand-text)}
.input{width:100%;padding:12px 14px;border-radius:var(--radius);border:1px solid rgba(255,255,255,.18);
  background:rgba(255,255,255,.05);color:var(--brand-text);font:15px/1.4 var(--brand-font)}
.nav{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.nav a{color:var(--brand-text);text-decoration:none;padding:8px 12px;border-radius:999px;background:rgba(255,255,255,.06);font-size:14px}
.nav a[aria-current="page"]{background:var(--brand-primary);color:var(--brand-bg)}
@media (prefers-reduced-motion: reduce){*{animation-duration:.01ms !important;transition-duration:.01ms !important}}
/* kind: ${kind} */
`;
}

function manifest(options: ScaffoldOptions): string {
  return JSON.stringify(
    {
      name: options.brand.name,
      short_name: options.brand.name.slice(0, 12),
      description: options.description.slice(0, 300),
      start_url: './index.html',
      scope: './',
      display: 'standalone',
      orientation: options.kind === 'game' ? 'landscape' : 'portrait',
      background_color: options.brand.background,
      theme_color: options.brand.primary,
      icons: [
        { src: './assets/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: './assets/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: './assets/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2,
  );
}

function serviceWorker(project: Project): string {
  return `// Offline shell for ${project.name}. Precaches the app shell and serves it
// cache-first so the product opens instantly and works without connectivity.
const CACHE = '${project.slug}-v' + (self.__BUILD_ID__ || '1');
const SHELL = ['./', './index.html', './styles.css', './bundle.js', './manifest.webmanifest',
  './assets/icons/icon-192.png', './assets/icons/icon-512.png'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => {
          if (response.ok) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        })
        .catch(() => cached || Response.error());
      return cached || network;
    }),
  );
});
`;
}

function packageJson(options: ScaffoldOptions): string {
  const dependencies = options.kind === 'game' ? { three: '^0.172.0' } : {};
  return JSON.stringify(
    {
      name: options.project.slug,
      version: options.project.versionName,
      private: true,
      description: options.description.slice(0, 200),
      type: 'module',
      scripts: {
        build: 'node ./build.mjs',
        typecheck: 'tsc --noEmit',
      },
      dependencies,
      devDependencies: { esbuild: '^0.24.2', typescript: '^5.7.3', '@types/three': '^0.172.0' },
    },
    null,
    2,
  );
}

function tsconfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        lib: ['ES2023', 'DOM', 'DOM.Iterable'],
        module: 'ESNext',
        moduleResolution: 'bundler',
        strict: true,
        noUncheckedIndexedAccess: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noImplicitOverride: true,
        noEmit: true,
        skipLibCheck: true,
        isolatedModules: true,
        forceConsistentCasingInFileNames: true,
      },
      include: ['src/**/*.ts', 'tests/**/*.ts'],
    },
    null,
    2,
  );
}

function buildScript(): string {
  return `// Standalone build entry point so the generated project can be built
// outside the factory with: npm install && npm run build
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/bundle.js',
  bundle: true,
  minify: true,
  sourcemap: false,
  format: 'esm',
  target: ['es2022', 'chrome100', 'safari15'],
  legalComments: 'none',
  logLevel: 'info',
});
`;
}

/**
 * The runtime harness. It is injected into the page by the preview server and
 * by the headless validator; it collects console output, errors, engine
 * diagnostics and frame timings into a single object the factory reads back.
 */
export function runtimeHarnessScript(): string {
  return `(function(){
  if (window.__adafHarness) return;
  var state = { console: [], errors: [], diagnostics: [], frames: [], ready: false, startedAt: Date.now() };
  window.__adafHarness = state;

  ['log','info','warn','error','debug'].forEach(function(level){
    var original = console[level].bind(console);
    console[level] = function(){
      try {
        state.console.push({ level: level, ts: Date.now(),
          text: Array.prototype.map.call(arguments, function(a){
            try { return typeof a === 'string' ? a : JSON.stringify(a); } catch (e) { return String(a); }
          }).join(' ').slice(0, 2000) });
        if (state.console.length > 400) state.console.shift();
      } catch (e) { /* never break the product */ }
      original.apply(null, arguments);
    };
  });

  window.addEventListener('error', function(event){
    state.errors.push({ kind: 'error', message: event.message, source: event.filename,
      line: event.lineno, column: event.colno, stack: event.error && event.error.stack ? String(event.error.stack).slice(0, 4000) : null, ts: Date.now() });
  });
  window.addEventListener('unhandledrejection', function(event){
    state.errors.push({ kind: 'unhandledrejection', message: String(event.reason),
      stack: event.reason && event.reason.stack ? String(event.reason.stack).slice(0, 4000) : null, ts: Date.now() });
  });
  window.addEventListener('message', function(event){
    var data = event.data;
    if (data && data.source === 'adaf-runtime') {
      state.diagnostics.push(data);
      if (data.type === 'ready') state.ready = true;
      if (state.diagnostics.length > 200) state.diagnostics.shift();
    }
  });

  var last = performance.now();
  function frame(now){
    state.frames.push(now - last);
    if (state.frames.length > 600) state.frames.shift();
    last = now;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  window.__adafReport = function(){
    var frames = state.frames.slice(-240).filter(function(f){ return f > 0 && f < 1000; });
    var sorted = frames.slice().sort(function(a,b){ return a-b; });
    var avg = frames.length ? frames.reduce(function(a,b){ return a+b; }, 0) / frames.length : 0;
    return {
      ready: state.ready,
      uptimeMs: Date.now() - state.startedAt,
      console: state.console.slice(-120),
      errors: state.errors.slice(-40),
      diagnostics: state.diagnostics.slice(-40),
      frameStats: {
        samples: frames.length,
        averageMs: Number(avg.toFixed(2)),
        p95Ms: sorted.length ? Number(sorted[Math.floor(sorted.length * 0.95)].toFixed(2)) : 0,
        fps: avg > 0 ? Number((1000 / avg).toFixed(1)) : 0
      }
    };
  };
})();`;
}

export interface ScaffoldResult {
  readonly files: readonly string[];
  readonly runtimeModule: 'engine' | 'appkit';
}

export function scaffoldProject(options: ScaffoldOptions): ScaffoldResult {
  const source = workspaceFor(options.project, 'source');
  const runtimeModule = options.kind === 'app' ? 'appkit' : 'engine';
  const files: string[] = [];

  const write = (relative: string, contents: string): void => {
    source.write(relative, contents);
    files.push(relative);
  };

  write('index.html', indexHtml(options));
  write('styles.css', stylesCss(options.brand, options.kind));
  write('manifest.webmanifest', manifest(options));
  write('sw.js', serviceWorker(options.project));
  write('package.json', packageJson(options));
  write('tsconfig.json', tsconfig());
  write('build.mjs', buildScript());
  write(
    'src/brand.ts',
    `/** Brand tokens generated from the product concept. Imported by product code. */
export const BRAND = ${JSON.stringify(
      {
        name: options.brand.name,
        tagline: options.brand.tagline,
        primary: options.brand.primary,
        secondary: options.brand.secondary,
        accent: options.brand.accent,
        background: options.brand.background,
        surface: options.brand.surface,
        text: options.brand.text,
        tone: options.brand.toneKeywords,
      },
      null,
      2,
    )} as const;

/** Deterministic seed: every procedural system derives from this single value. */
export const SEED = ${options.seed >>> 0};
`,
  );
  write(
    'README.md',
    `# ${options.brand.name}\n\n${options.description}\n\n` +
      `Generated by the Autonomous Daily App Factory.\n\n## Build\n\n\`\`\`bash\nnpm install\nnpm run build\n\`\`\`\n\n` +
      `The build emits \`dist/bundle.js\`; serve this directory over HTTP to run the product.\n\n` +
      `## Structure\n\n- \`src/${runtimeModule}/\` — runtime SDK (platform-authored infrastructure)\n` +
      `- \`src/\` — product code\n- \`tests/\` — automated tests\n- \`assets/\` — generated artwork and textures\n`,
  );

  files.push(...copyRuntime(source, runtimeModule));

  log.info('project scaffolded', { projectId: options.project.id, files: files.length, runtimeModule });
  return { files, runtimeModule };
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttribute(value: string): string {
  return escapeHtml(value).replace(/"/g, '&quot;');
}
