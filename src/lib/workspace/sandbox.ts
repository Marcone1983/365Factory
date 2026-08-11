import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { config } from '@/lib/config/env';
import { createLogger } from '@/lib/observability/logger';
import { counter, observe } from '@/lib/observability/metrics';

const log = createLogger('workspace.sandbox');

/**
 * Sandboxed process execution.
 *
 * AI-authored code is never evaluated inside the platform process. It is only
 * ever executed as a child process that is:
 *
 *  - restricted to an allow-listed executable (no shell metacharacters ever
 *    reach a shell: argv is passed as argv);
 *  - confined to a working directory inside the project workspace;
 *  - started with a scrubbed environment — no platform secrets are inherited;
 *  - bounded by address space, file size, process count and wall-clock limits;
 *  - bounded in output volume so a runaway log cannot exhaust memory or disk;
 *  - denied outbound network by default via proxy blackholing and offline flags.
 *
 * Kernel-level network isolation is a deployment concern: run the platform in a
 * container whose egress policy denies the build user. SECURITY.md documents the
 * exact requirement rather than pretending the process boundary is enough.
 */

export class SandboxViolationError extends Error {
  readonly code = 'SANDBOX_VIOLATION';
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = 'SandboxViolationError';
  }
}

/** Executables the platform is ever allowed to launch, by logical name. */
export const ALLOWED_EXECUTABLES = ['node', 'npm', 'npx', 'java', 'gradle', 'keytool', 'apksigner', 'zipalign', 'sh'] as const;
export type AllowedExecutable = (typeof ALLOWED_EXECUTABLES)[number];

export interface SandboxRequest {
  readonly executable: AllowedExecutable;
  /** Absolute path override for the executable (e.g. an SDK-local apksigner). */
  readonly executablePath?: string;
  readonly args: readonly string[];
  /** Must resolve inside `jailRoot`. */
  readonly cwd: string;
  readonly jailRoot: string;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly allowNetwork?: boolean;
  readonly maxOutputBytes?: number;
  readonly onOutput?: (chunk: string, stream: 'stdout' | 'stderr') => void;
  readonly signal?: AbortSignal;
}

export interface SandboxResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly truncated: boolean;
  readonly command: string;
}

const SAFE_ARG = /^[^\0]*$/;

function assertInsideJail(target: string, jailRoot: string): void {
  const root = fs.realpathSync(path.resolve(jailRoot));
  const resolved = fs.realpathSync(path.resolve(target));
  if (resolved !== root && !resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep)) {
    throw new SandboxViolationError(`working directory ${target} is outside the workspace jail`);
  }
}

/**
 * Builds the child environment. Everything from the platform process is dropped
 * except an explicit, non-secret allowlist.
 */
function buildEnv(request: SandboxRequest, tmpDir: string): Record<string, string> {
  const cfg = config();
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: tmpDir,
    TMPDIR: tmpDir,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    CI: 'true',
    NO_COLOR: '1',
    TERM: 'dumb',
    NODE_OPTIONS: '--max-old-space-size=2048',
  };
  if (process.env.JAVA_HOME) env.JAVA_HOME = process.env.JAVA_HOME;
  if (cfg.JAVA_HOME) env.JAVA_HOME = cfg.JAVA_HOME;
  const sdk = cfg.ANDROID_SDK_ROOT ?? cfg.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? process.env.ANDROID_HOME;
  if (sdk) {
    env.ANDROID_SDK_ROOT = sdk;
    env.ANDROID_HOME = sdk;
  }
  env.GRADLE_USER_HOME = path.join(tmpDir, 'gradle');

  if (!(request.allowNetwork ?? cfg.SANDBOX_ALLOW_NETWORK)) {
    // Blackhole any proxy-aware client and force package managers offline.
    env.HTTP_PROXY = 'http://127.0.0.1:1';
    env.HTTPS_PROXY = 'http://127.0.0.1:1';
    env.http_proxy = 'http://127.0.0.1:1';
    env.https_proxy = 'http://127.0.0.1:1';
    env.NO_PROXY = '';
    env.npm_config_offline = 'true';
    env.npm_config_audit = 'false';
    env.npm_config_fund = 'false';
    env.GRADLE_OPTS = '--offline';
  } else if (process.env.HTTPS_PROXY) {
    env.HTTPS_PROXY = process.env.HTTPS_PROXY;
    env.HTTP_PROXY = process.env.HTTP_PROXY ?? process.env.HTTPS_PROXY;
    env.NO_PROXY = process.env.NO_PROXY ?? '';
  }

  for (const [key, value] of Object.entries(request.env ?? {})) {
    if (/(?:key|secret|token|password|credential)/i.test(key)) {
      throw new SandboxViolationError(`refusing to pass secret-looking variable "${key}" into the sandbox`);
    }
    env[key] = value;
  }
  return env;
}

export async function runSandboxed(request: SandboxRequest): Promise<SandboxResult> {
  const cfg = config();
  if (!ALLOWED_EXECUTABLES.includes(request.executable)) {
    throw new SandboxViolationError(`executable "${request.executable}" is not allow-listed`);
  }
  for (const arg of request.args) {
    if (typeof arg !== 'string' || !SAFE_ARG.test(arg)) {
      throw new SandboxViolationError('arguments must be NUL-free strings');
    }
  }
  assertInsideJail(request.cwd, request.jailRoot);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adaf-sbx-'));
  const timeoutMs = request.timeoutMs ?? cfg.SANDBOX_DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = request.maxOutputBytes ?? cfg.BUILD_MAX_OUTPUT_BYTES;
  const target = request.executablePath ?? request.executable;

  // Resource limits are applied by a POSIX shell wrapper, then the real binary
  // replaces it via exec. Arguments are passed as argv, never interpolated.
  const limits = [
    `ulimit -v ${cfg.SANDBOX_MAX_PROCESS_MB * 1024}`,
    `ulimit -f ${cfg.SANDBOX_MAX_FILE_MB * 1024}`,
    `ulimit -u ${cfg.SANDBOX_MAX_PROCESSES}`,
    'ulimit -c 0',
  ].join('; ');
  const script = `${limits} 2>/dev/null; exec "$@"`;

  const started = Date.now();
  const child = spawn('/bin/sh', ['-c', script, 'adaf-sandbox', target, ...request.args], {
    cwd: request.cwd,
    // The child gets a scrubbed environment; the cast is needed because the
    // Node typings insist ProcessEnv carries NODE_ENV, which we deliberately drop.
    env: buildEnv(request, tmpDir) as NodeJS.ProcessEnv,
    stdio: ['ignore', 'pipe', 'pipe'] as const,
    detached: true,
  });

  let stdout = '';
  let stderr = '';
  let bytes = 0;
  let truncated = false;
  let timedOut = false;

  const capture = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
    const text = chunk.toString('utf8');
    bytes += chunk.length;
    if (bytes > maxOutputBytes) {
      if (!truncated) {
        truncated = true;
        const notice = `\n[output truncated at ${maxOutputBytes} bytes]\n`;
        if (stream === 'stdout') stdout += notice;
        else stderr += notice;
      }
      return;
    }
    if (stream === 'stdout') stdout += text;
    else stderr += text;
    request.onOutput?.(text, stream);
  };

  child.stdout?.on('data', capture('stdout'));
  child.stderr?.on('data', capture('stderr'));

  const killTree = (signal: NodeJS.Signals): void => {
    try {
      if (child.pid) process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        /* already gone */
      }
    }
  };

  const timer = setTimeout(() => {
    timedOut = true;
    killTree('SIGTERM');
    setTimeout(() => killTree('SIGKILL'), 5_000).unref();
  }, timeoutMs);

  const onAbort = (): void => killTree('SIGKILL');
  request.signal?.addEventListener('abort', onAbort, { once: true });

  const result = await new Promise<{ code: number | null; sig: NodeJS.Signals | null }>((resolve) => {
    child.on('error', (error) => {
      stderr += `\n[sandbox] failed to start process: ${error.message}\n`;
      resolve({ code: null, sig: null });
    });
    child.on('close', (code, sig) => resolve({ code, sig }));
  });

  clearTimeout(timer);
  request.signal?.removeEventListener('abort', onAbort);
  fs.rmSync(tmpDir, { recursive: true, force: true });

  const durationMs = Date.now() - started;
  const command = `${request.executable} ${request.args.join(' ')}`.slice(0, 400);
  observe('sandbox.duration', durationMs, { executable: request.executable, outcome: result.code === 0 ? 'success' : 'failure' });
  counter('sandbox.runs', { executable: request.executable, outcome: timedOut ? 'timeout' : result.code === 0 ? 'success' : 'failure' });
  if (result.code !== 0) {
    log.warn('sandboxed process exited non-zero', { command, exitCode: result.code, timedOut, durationMs });
  }

  return {
    exitCode: result.code,
    signal: result.sig,
    stdout,
    stderr,
    durationMs,
    timedOut,
    truncated,
    command,
  };
}
