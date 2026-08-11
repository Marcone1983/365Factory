import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import type * as EsbuildModule from 'esbuild';
import { config } from '@/lib/config/env';
import { ensureDir, walkFiles } from '@/lib/workspace/paths';
import { runSandboxed } from '@/lib/workspace/sandbox';
import { runtimeHarnessScript } from '@/lib/generation/scaffold';
import { appendBuildLog, finishBuild, recordArtifact, startBuild, type BuildDiagnostic, type BuildRecord } from './store';
import { createLogger } from '@/lib/observability/logger';
import type { Project } from '@/lib/workspace/project';

const log = createLogger('build.web');

/**
 * Web build.
 *
 * Bundles the generated TypeScript with esbuild and assembles a complete,
 * servable directory: HTML shell, styles, manifest, service worker, generated
 * assets and the bundle. The same output is what the preview server serves and
 * what the Android build embeds, so the preview is the artifact, not a
 * rendering of it.
 *
 * esbuild only parses and emits code — it never executes the generated program —
 * so bundling runs in-process. Type checking, which invokes the TypeScript
 * compiler, runs in the sandbox.
 */

export interface WebBuildResult {
  readonly build: BuildRecord;
  readonly outputDir: string;
  readonly bundleBytes: number;
  readonly diagnostics: readonly BuildDiagnostic[];
  readonly succeeded: boolean;
}

function platformNodeModules(): string {
  return path.join(process.cwd(), 'node_modules');
}

/**
 * esbuild ships a native binary. It is loaded through `createRequire` at call
 * time so that no bundler attempts to trace or parse that binary while building
 * the console itself.
 */
let esbuildModule: typeof EsbuildModule | null = null;
function esbuild(): typeof EsbuildModule {
  if (!esbuildModule) {
    esbuildModule = createRequire(import.meta.url)('esbuild') as typeof EsbuildModule;
  }
  return esbuildModule;
}

function mapEsbuildMessages(messages: readonly EsbuildModule.Message[], severity: 'error' | 'warning'): BuildDiagnostic[] {
  return messages.map((message) => ({
    severity,
    file: message.location?.file,
    line: message.location?.line,
    column: message.location?.column,
    message: message.text,
    code: message.id || undefined,
  }));
}

/** Parses `tsc --pretty false` output into structured diagnostics. */
export function parseTscOutput(output: string): BuildDiagnostic[] {
  const diagnostics: BuildDiagnostic[] = [];
  const pattern = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/gm;
  let match = pattern.exec(output);
  while (match) {
    diagnostics.push({
      severity: match[4] === 'error' ? 'error' : 'warning',
      file: match[1],
      line: Number.parseInt(match[2] ?? '0', 10),
      column: Number.parseInt(match[3] ?? '0', 10),
      code: match[5],
      message: match[6] ?? '',
    });
    match = pattern.exec(output);
  }
  return diagnostics;
}

export interface TypecheckResult {
  readonly ok: boolean;
  readonly diagnostics: readonly BuildDiagnostic[];
  readonly output: string;
}

/** Runs the TypeScript compiler over the generated project in the sandbox. */
export async function typecheckProject(project: Project, signal?: AbortSignal): Promise<TypecheckResult> {
  const sourceDir = path.join(project.workspacePath, 'source');
  const tsc = path.join(platformNodeModules(), 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(tsc)) {
    return { ok: false, diagnostics: [{ severity: 'error', message: 'TypeScript compiler not found in the platform installation.' }], output: '' };
  }
  const result = await runSandboxed({
    executable: 'node',
    args: [tsc, '--noEmit', '--pretty', 'false', '-p', 'tsconfig.json'],
    cwd: sourceDir,
    jailRoot: project.workspacePath,
    timeoutMs: 180_000,
    signal,
  });
  const output = `${result.stdout}\n${result.stderr}`.trim();
  const diagnostics = parseTscOutput(output);
  return { ok: result.exitCode === 0, diagnostics, output };
}

export interface WebBuildOptions {
  readonly minify?: boolean;
  readonly injectHarness?: boolean;
  readonly runTypecheck?: boolean;
  readonly signal?: AbortSignal;
}

export async function buildWeb(project: Project, options: WebBuildOptions = {}): Promise<WebBuildResult> {
  const build = startBuild({
    project,
    target: 'web',
    mode: options.minify === false ? 'debug' : 'release',
    toolchain: { bundler: `esbuild ${esbuild().version}`, node: process.version },
  });

  const sourceDir = path.join(project.workspacePath, 'source');
  const assetsDir = path.join(project.workspacePath, 'assets');
  const outputDir = path.join(project.workspacePath, 'build', 'web');
  const diagnostics: BuildDiagnostic[] = [];

  try {
    const entry = path.join(sourceDir, 'src', 'main.ts');
    if (!fs.existsSync(entry)) {
      throw new Error('src/main.ts is missing: the project has no entry point to build.');
    }

    if (options.runTypecheck !== false) {
      appendBuildLog(build, '\n== typecheck ==\n');
      const typecheck = await typecheckProject(project, options.signal);
      appendBuildLog(build, `${typecheck.output.slice(0, 60_000)}\n`);
      diagnostics.push(...typecheck.diagnostics);
      if (!typecheck.ok) {
        const errors = typecheck.diagnostics.filter((d) => d.severity === 'error');
        const finished = finishBuild(build, {
          status: 'FAILED',
          exitCode: 2,
          errorSummary: `TypeScript reported ${errors.length} error(s). First: ${errors[0]?.message ?? 'unknown'}`,
          diagnostics,
        });
        return { build: finished, outputDir, bundleBytes: 0, diagnostics, succeeded: false };
      }
    }

    appendBuildLog(build, '\n== bundle ==\n');
    fs.rmSync(outputDir, { recursive: true, force: true });
    ensureDir(outputDir);

    const result = await esbuild().build({
      entryPoints: [entry],
      outfile: path.join(outputDir, 'bundle.js'),
      bundle: true,
      minify: options.minify !== false,
      sourcemap: false,
      format: 'esm',
      platform: 'browser',
      target: ['es2022', 'chrome100', 'safari15', 'firefox100'],
      legalComments: 'none',
      absWorkingDir: sourceDir,
      nodePaths: [platformNodeModules()],
      logLevel: 'silent',
      metafile: true,
      define: { 'process.env.NODE_ENV': '"production"' },
    });

    diagnostics.push(...mapEsbuildMessages(result.warnings, 'warning'));
    if (result.errors.length > 0) {
      diagnostics.push(...mapEsbuildMessages(result.errors, 'error'));
      const finished = finishBuild(build, {
        status: 'FAILED',
        exitCode: 1,
        errorSummary: result.errors.map((e) => e.text).join('; ').slice(0, 1000),
        diagnostics,
      });
      return { build: finished, outputDir, bundleBytes: 0, diagnostics, succeeded: false };
    }

    for (const staticFile of ['index.html', 'styles.css', 'manifest.webmanifest', 'sw.js']) {
      const from = path.join(sourceDir, staticFile);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(outputDir, staticFile));
    }

    // Assets are published under the path the HTML and manifest reference.
    const assetTarget = path.join(outputDir, 'assets');
    if (fs.existsSync(assetsDir)) {
      ensureDir(assetTarget);
      fs.cpSync(assetsDir, assetTarget, { recursive: true, force: true });
    }

    if (options.injectHarness) injectHarness(outputDir);

    const bundleBytes = fs.statSync(path.join(outputDir, 'bundle.js')).size;
    const totalBytes = walkFiles(outputDir, { maxFiles: 2000 })
      .map((relative) => fs.statSync(path.join(outputDir, relative)).size)
      .reduce((a, b) => a + b, 0);
    appendBuildLog(build, `bundle: ${bundleBytes} bytes, total output: ${totalBytes} bytes\n`);

    const archivePath = path.join(project.workspacePath, 'artifacts', `${project.slug}-web-${build.id}.zip`);
    ensureDir(path.dirname(archivePath));
    await createZip(outputDir, archivePath);
    recordArtifact({ build, kind: 'web-bundle', absolutePath: archivePath });

    const finished = finishBuild(build, {
      status: 'SUCCEEDED',
      exitCode: 0,
      diagnostics,
      toolchain: { bundler: `esbuild ${esbuild().version}`, node: process.version, bundleBytes, totalBytes },
    });
    log.info('web build succeeded', { projectId: project.id, bundleBytes, totalBytes });
    return { build: finished, outputDir, bundleBytes, diagnostics, succeeded: true };
  } catch (error) {
    const message = (error as Error).message;
    appendBuildLog(build, `\nBUILD FAILED: ${message}\n`);
    diagnostics.push({ severity: 'error', message });
    const finished = finishBuild(build, { status: 'FAILED', exitCode: 1, errorSummary: message, diagnostics });
    return { build: finished, outputDir, bundleBytes: 0, diagnostics, succeeded: false };
  }
}

/** Adds the observation harness to the served HTML without touching the source. */
export function injectHarness(outputDir: string): void {
  const indexPath = path.join(outputDir, 'index.html');
  if (!fs.existsSync(indexPath)) return;
  const html = fs.readFileSync(indexPath, 'utf8');
  if (html.includes('__adafHarness')) return;
  const script = `<script>${runtimeHarnessScript()}</script>`;
  const injected = html.includes('</head>') ? html.replace('</head>', `${script}\n</head>`) : `${script}\n${html}`;
  fs.writeFileSync(indexPath, injected);
}

// ------------------------------------------------------------------- zip --

/**
 * Minimal ZIP writer (stored + deflated entries, no external dependency).
 * Used for downloadable web bundles and for the Android build's asset packaging.
 */
export async function createZip(sourceDir: string, targetFile: string): Promise<number> {
  const zlib = await import('node:zlib');
  const files = walkFiles(sourceDir, { maxFiles: 5000 });
  const chunks: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;

  const crcTable = getCrcTable();
  const crc32 = (data: Buffer): number => {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i += 1) crc = (crcTable[(crc ^ (data[i] as number)) & 0xff] as number) ^ (crc >>> 8);
    return (crc ^ 0xffffffff) >>> 0;
  };

  for (const relative of files) {
    const data = fs.readFileSync(path.join(sourceDir, relative));
    const nameBuffer = Buffer.from(relative, 'utf8');
    const compressed = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = compressed.length < data.length;
    const payload = useDeflate ? compressed : data;
    const crc = crc32(data);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(useDeflate ? 8 : 0, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    chunks.push(localHeader, nameBuffer, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(useDeflate ? 8 : 0, 10);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuffer);

    offset += localHeader.length + nameBuffer.length + payload.length;
  }

  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);

  const archive = Buffer.concat([...chunks, centralBuffer, end]);
  ensureDir(path.dirname(targetFile));
  fs.writeFileSync(targetFile, archive);
  return archive.length;
}

let crcTableCache: Uint32Array | null = null;
function getCrcTable(): Uint32Array {
  if (crcTableCache) return crcTableCache;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  crcTableCache = table;
  return table;
}

void config;
