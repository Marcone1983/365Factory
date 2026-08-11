import fs from 'node:fs';
import path from 'node:path';
import { db, newId, nowIso, toJson } from '@/lib/db/client';
import { openPage, browserStatus } from './browser';
import { ensureDir } from '@/lib/workspace/paths';
import { createLogger } from '@/lib/observability/logger';
import { emitEvent } from '@/lib/observability/events';
import type { Project } from '@/lib/workspace/project';

const log = createLogger('qa.runtime');

/**
 * Runtime validation.
 *
 * The generated product is loaded in a real browser and exercised. Every check
 * below observes actual runtime behaviour — console output, engine diagnostics,
 * frame timings, DOM state and the product's own inspection hook. A product is
 * never marked READY on the strength of a successful compile alone.
 *
 * Generated products cooperate through a small, documented contract:
 *
 *   window.__adafGame = {
 *     snapshot(): { scene, entities, player: {x,y,z}, score?, state },
 *     input(action: string, down: boolean): void,
 *     save(): boolean,
 *     load(): boolean,
 *   }
 *
 * Applications expose `window.__adafApp` with `snapshot()` and `route(path)`.
 * The contract is part of the coding agent's system prompt and is asserted here.
 */

export const GAME_RUNTIME_CONTRACT = `window.__adafGame = {
  snapshot(): { scene: string; entities: number; player: { x: number; y: number; z: number }; state: string; score?: number },
  input(action: string, down: boolean): void,
  save(): boolean,
  load(): boolean,
}`;

export const APP_RUNTIME_CONTRACT = `window.__adafApp = {
  snapshot(): { route: string; records: number; state: string },
  route(path: string): void,
}`;

export type CheckStatus = 'passed' | 'failed' | 'skipped';

export interface RuntimeCheck {
  readonly name: string;
  readonly status: CheckStatus;
  readonly critical: boolean;
  readonly detail: string;
  readonly durationMs: number;
  readonly data?: Record<string, unknown>;
}

export interface HarnessReport {
  ready: boolean;
  uptimeMs: number;
  console: Array<{ level: string; text: string; ts: number }>;
  errors: Array<{ kind: string; message: string; source?: string; line?: number; stack?: string | null }>;
  diagnostics: Array<{ type: string; payload: Record<string, unknown> }>;
  frameStats: { samples: number; averageMs: number; p95Ms: number; fps: number };
}

export interface RuntimeValidationResult {
  readonly id: string;
  readonly status: 'passed' | 'failed' | 'unavailable';
  readonly checks: readonly RuntimeCheck[];
  readonly report: HarnessReport | null;
  readonly screenshots: readonly string[];
  readonly durationMs: number;
  readonly summary: string;
}

export interface RuntimeValidationOptions {
  readonly url: string;
  readonly kind: 'app' | 'game' | 'hybrid';
  readonly buildId?: string;
  readonly minimumFps?: number;
  readonly observeMs?: number;
  readonly signal?: AbortSignal;
}

const EMPTY_REPORT: HarnessReport = {
  ready: false,
  uptimeMs: 0,
  console: [],
  errors: [],
  diagnostics: [],
  frameStats: { samples: 0, averageMs: 0, p95Ms: 0, fps: 0 },
};

export async function validateRuntime(project: Project, options: RuntimeValidationOptions): Promise<RuntimeValidationResult> {
  const started = Date.now();
  const status = browserStatus();
  if (!status.available) {
    const result: RuntimeValidationResult = {
      id: newId('tst'),
      status: 'unavailable',
      checks: [],
      report: null,
      screenshots: [],
      durationMs: 0,
      summary: status.detail,
    };
    persistTestRun(project, options.buildId, 'runtime', result);
    return result;
  }

  const checks: RuntimeCheck[] = [];
  const screenshots: string[] = [];
  const screenshotDir = path.join(project.workspacePath, 'logs', 'screenshots');
  ensureDir(screenshotDir);
  const isGame = options.kind !== 'app';
  const origin = new URL(options.url).origin;

  const session = await openPage({
    viewport: isGame ? { width: 960, height: 540 } : { width: 412, height: 892 },
    isMobile: !isGame,
    deviceScaleFactor: isGame ? 1 : 2,
    allowedOrigin: origin,
  });

  const timed = async (name: string, critical: boolean, run: () => Promise<{ detail: string; data?: Record<string, unknown> }>): Promise<void> => {
    const at = Date.now();
    try {
      const outcome = await run();
      checks.push({ name, status: 'passed', critical, detail: outcome.detail, durationMs: Date.now() - at, data: outcome.data });
    } catch (error) {
      checks.push({ name, status: 'failed', critical, detail: (error as Error).message, durationMs: Date.now() - at });
    }
  };

  let report: HarnessReport = EMPTY_REPORT;

  try {
    await timed('boot', true, async () => {
      const response = await session.page.goto(options.url, { waitUntil: 'domcontentloaded' });
      if (!response) throw new Error('navigation produced no response');
      if (!response.ok()) throw new Error(`preview returned HTTP ${response.status()}`);
      return { detail: `loaded ${options.url} (HTTP ${response.status()})` };
    });

    // Give the product time to boot, initialise systems and render frames.
    await session.page.waitForTimeout(options.observeMs ?? 4500);
    report = ((await session.page.evaluate('typeof window.__adafReport === "function" ? window.__adafReport() : null')) as HarnessReport | null) ?? EMPTY_REPORT;

    const shot = path.join(screenshotDir, `runtime-${Date.now()}.png`);
    await session.page.screenshot({ path: shot, fullPage: false });
    screenshots.push(shot);

    await timed('no_runtime_errors', true, async () => {
      const fatal = report.errors.filter((e) => !/ResizeObserver loop/i.test(e.message));
      if (fatal.length > 0) {
        throw new Error(`${fatal.length} runtime error(s); first: ${fatal[0]?.message ?? 'unknown'}`);
      }
      return { detail: 'no uncaught errors or unhandled rejections observed' };
    });

    await timed('no_console_errors', false, async () => {
      const errors = report.console.filter((entry) => entry.level === 'error');
      if (errors.length > 0) throw new Error(`${errors.length} console error(s); first: ${errors[0]?.text.slice(0, 200) ?? ''}`);
      return { detail: 'console clean' };
    });

    if (isGame) {
      await timed('scene_load', true, async () => {
        const ready = report.diagnostics.find((d) => d.type === 'ready');
        if (!ready) throw new Error('the engine never reported a ready diagnostic; the scene did not finish loading');
        const systems = (ready.payload.systems as string[] | undefined) ?? [];
        return { detail: `engine ready with ${systems.length} systems`, data: { systems, renderer: ready.payload.rendererInfo } };
      });

      await timed('webgl_context', true, async () => {
        const info = (await session.page.evaluate(`(() => {
          const canvas = document.querySelector('canvas');
          if (!canvas) return null;
          const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
          if (!gl) return null;
          return { version: gl.getParameter(gl.VERSION), width: canvas.width, height: canvas.height };
        })()`)) as { version: string; width: number; height: number } | null;
        if (!info) throw new Error('no canvas with a WebGL context is present');
        if (info.width < 2 || info.height < 2) throw new Error(`canvas has a degenerate size (${info.width}x${info.height})`);
        return { detail: `${info.version} at ${info.width}x${info.height}`, data: { ...info } };
      });

      await timed('rendering', true, async () => {
        const perf = [...report.diagnostics].reverse().find((d) => d.type === 'performance');
        if (!perf) throw new Error('the engine never reported a performance sample; the render loop is not running');
        const triangles = Number(perf.payload.triangles ?? 0);
        const drawCalls = Number(perf.payload.drawCalls ?? 0);
        if (drawCalls === 0 || triangles === 0) {
          throw new Error(`the renderer submitted nothing (${drawCalls} draw calls, ${triangles} triangles): the scene is empty`);
        }
        return { detail: `${drawCalls} draw calls, ${triangles} triangles`, data: { drawCalls, triangles } };
      });

      await timed('player_spawn', true, async () => {
        const snapshot = (await session.page.evaluate(
          '(() => (window.__adafGame && typeof window.__adafGame.snapshot === "function") ? window.__adafGame.snapshot() : null)()',
        )) as { scene?: string; entities?: number; player?: { x: number; y: number; z: number }; state?: string } | null;
        if (!snapshot) throw new Error('window.__adafGame.snapshot() is missing: the runtime contract is not implemented');
        if (!snapshot.player || typeof snapshot.player.y !== 'number') throw new Error('snapshot did not report a player position');
        if (!Number.isFinite(snapshot.player.x) || !Number.isFinite(snapshot.player.y) || !Number.isFinite(snapshot.player.z)) {
          throw new Error('player position contains non-finite values');
        }
        return {
          detail: `player at (${snapshot.player.x.toFixed(1)}, ${snapshot.player.y.toFixed(1)}, ${snapshot.player.z.toFixed(1)}) in scene "${snapshot.scene ?? 'unknown'}"`,
          data: { ...snapshot },
        };
      });

      await timed('input_response', true, async () => {
        const before = (await session.page.evaluate('window.__adafGame.snapshot()')) as { player: { x: number; z: number } };
        await session.page.evaluate('window.__adafGame.input("forward", true)');
        await session.page.keyboard.down('KeyW');
        await session.page.waitForTimeout(1200);
        await session.page.keyboard.up('KeyW');
        await session.page.evaluate('window.__adafGame.input("forward", false)');
        const after = (await session.page.evaluate('window.__adafGame.snapshot()')) as { player: { x: number; z: number } };
        const moved = Math.hypot(after.player.x - before.player.x, after.player.z - before.player.z);
        if (moved < 0.25) throw new Error(`holding "forward" for 1.2s moved the player only ${moved.toFixed(3)} units`);
        return { detail: `player moved ${moved.toFixed(2)} units in response to input`, data: { moved } };
      });

      await timed('save_load', true, async () => {
        const saved = (await session.page.evaluate('window.__adafGame.save()')) as boolean;
        if (!saved) throw new Error('save() returned false');
        const loaded = (await session.page.evaluate('window.__adafGame.load()')) as boolean;
        if (!loaded) throw new Error('load() returned false');
        return { detail: 'save and load round-tripped' };
      });
    } else {
      await timed('app_boot', true, async () => {
        const snapshot = (await session.page.evaluate(
          '(() => (window.__adafApp && typeof window.__adafApp.snapshot === "function") ? window.__adafApp.snapshot() : null)()',
        )) as { route?: string; records?: number; state?: string } | null;
        if (!snapshot) throw new Error('window.__adafApp.snapshot() is missing: the runtime contract is not implemented');
        return { detail: `app ready on route "${snapshot.route ?? '/'}" with ${snapshot.records ?? 0} records`, data: { ...snapshot } };
      });

      await timed('renders_content', true, async () => {
        const text = (await session.page.evaluate('document.body.innerText.trim().length')) as number;
        if (text < 20) throw new Error(`the page rendered only ${text} characters of text`);
        return { detail: `${text} characters rendered` };
      });

      await timed('interactive', true, async () => {
        const buttons = await session.page.locator('button, [role="button"], a[href]').count();
        if (buttons === 0) throw new Error('no interactive elements were rendered');
        return { detail: `${buttons} interactive elements` };
      });
    }

    // A software rasteriser (SwiftShader/llvmpipe on a GPU-less host) is one to
    // two orders of magnitude slower than any real device. Measuring against a
    // device frame budget there would be meaningless, so the floor drops and the
    // check stops being a release gate — while still catching a render loop that
    // has stopped entirely.
    const rendererName = await detectRenderer(session.page);
    const software = /swiftshader|llvmpipe|software|basic render/i.test(rendererName);

    await timed('performance', isGame && !software, async () => {
      const minimum = options.minimumFps ?? (software ? 3 : isGame ? 24 : 12);
      const { fps, samples, p95Ms } = report.frameStats;
      if (samples < 10) throw new Error(`only ${samples} frames were observed; the product is not animating`);
      if (fps < minimum) throw new Error(`average ${fps} fps is below the ${minimum} fps floor (p95 frame ${p95Ms}ms)`);
      return {
        detail: software
          ? `${fps} fps on a software rasteriser (${rendererName}); not representative of device performance`
          : `${fps} fps average over ${samples} frames (p95 ${p95Ms}ms)`,
        data: { fps, samples, p95Ms, renderer: rendererName, softwareRasteriser: software },
      };
    });

    await timed('offline_shell', false, async () => {
      const manifest = await session.page.locator('link[rel="manifest"]').count();
      if (manifest === 0) throw new Error('no web app manifest is linked');
      return { detail: 'manifest linked' };
    });
  } finally {
    await session.close();
  }

  const criticalFailures = checks.filter((c) => c.critical && c.status === 'failed');
  const result: RuntimeValidationResult = {
    id: newId('tst'),
    status: criticalFailures.length === 0 ? 'passed' : 'failed',
    checks,
    report,
    screenshots,
    durationMs: Date.now() - started,
    summary:
      criticalFailures.length === 0
        ? `${checks.filter((c) => c.status === 'passed').length}/${checks.length} runtime checks passed`
        : `${criticalFailures.length} critical runtime check(s) failed: ${criticalFailures.map((c) => c.name).join(', ')}`,
  };

  persistTestRun(project, options.buildId, 'runtime', result);
  emitEvent({
    type: 'test.finished',
    scope: 'qa',
    projectId: project.id,
    message: result.summary,
    data: { status: result.status, checks: checks.length, durationMs: result.durationMs },
  });
  log.info('runtime validation complete', { projectId: project.id, status: result.status, checks: checks.length });
  return result;
}

/** Reads the unmasked GPU renderer string, which identifies software rendering. */
async function detectRenderer(page: { evaluate(script: string): Promise<unknown> }): Promise<string> {
  try {
    const name = (await page.evaluate(`(() => {
      const canvas = document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return '';
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return info ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : String(gl.getParameter(gl.RENDERER));
    })()`)) as string;
    return name || 'unknown';
  } catch {
    return 'unknown';
  }
}

function persistTestRun(project: Project, buildId: string | undefined, suite: string, result: RuntimeValidationResult): void {
  const passed = result.checks.filter((c) => c.status === 'passed').length;
  const failed = result.checks.filter((c) => c.status === 'failed').length;
  const skipped = result.checks.filter((c) => c.status === 'skipped').length;
  db()
    .prepare(
      `INSERT INTO test_runs (id, project_id, build_id, suite, status, total, passed, failed, skipped, duration_ms, report, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      result.id,
      project.id,
      buildId ?? null,
      suite,
      result.status,
      result.checks.length,
      passed,
      failed,
      skipped,
      result.durationMs,
      toJson({ checks: result.checks, summary: result.summary, screenshots: result.screenshots, frameStats: result.report?.frameStats ?? null, errors: result.report?.errors ?? [] }),
      nowIso(),
    );
}

export interface TestRunSummary {
  readonly id: string;
  readonly suite: string;
  readonly status: string;
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly durationMs: number;
  readonly report: Record<string, unknown>;
  readonly createdAt: string;
}

export function listTestRuns(projectId: string, limit = 20): TestRunSummary[] {
  return db()
    .prepare<[string, number], {
      id: string; suite: string; status: string; total: number; passed: number; failed: number;
      duration_ms: number; report: string; created_at: string;
    }>('SELECT * FROM test_runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(projectId, limit)
    .map((row) => ({
      id: row.id,
      suite: row.suite,
      status: row.status,
      total: row.total,
      passed: row.passed,
      failed: row.failed,
      durationMs: row.duration_ms,
      report: JSON.parse(row.report) as Record<string, unknown>,
      createdAt: row.created_at,
    }));
}

/** Reads a stored screenshot for the artifact page. */
export function readScreenshot(absolutePath: string): Buffer | null {
  try {
    return fs.readFileSync(absolutePath);
  } catch {
    return null;
  }
}
