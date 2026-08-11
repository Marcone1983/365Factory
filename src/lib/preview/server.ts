import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '@/lib/config/env';
import { db, newId, nowIso, toJson } from '@/lib/db/client';
import { resolveInside } from '@/lib/workspace/paths';
import { getProject, type Project } from '@/lib/workspace/project';
import { createLogger } from '@/lib/observability/logger';
import { emitEvent } from '@/lib/observability/events';

const log = createLogger('preview.server');

/**
 * Preview engine.
 *
 * Serves the *actual build output* of a generated product over HTTP so the
 * product can be run — by the operator in an iframe and by the headless
 * validator in Chromium. There is no screenshot substitute anywhere in this
 * path: what the preview shows is the artifact that was built.
 *
 * The server binds to loopback only, serves exclusively from
 * `<workspace>/build/web`, resolves every request path through the workspace
 * jail, and sends a restrictive CSP so a generated page cannot reach the
 * platform's own origin or any third party.
 */

const MIME_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const PREVIEW_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "media-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

interface PreviewRegistration {
  readonly projectId: string;
  readonly root: string;
  readonly registeredAt: number;
}

const registry = new Map<string, PreviewRegistration>();
let server: http.Server | null = null;
let listening: Promise<{ host: string; port: number }> | null = null;

export interface PreviewServerInfo {
  readonly host: string;
  readonly port: number;
  readonly baseUrl: string;
  readonly projects: number;
}

function buildRoot(project: Project): string {
  return path.join(project.workspacePath, 'build', 'web');
}

export function isPreviewBuilt(project: Project): boolean {
  return fs.existsSync(path.join(buildRoot(project), 'index.html'));
}

/** Registers a project's build output for serving. Idempotent. */
export function registerPreview(project: Project): PreviewRegistration {
  const root = buildRoot(project);
  const registration: PreviewRegistration = { projectId: project.id, root, registeredAt: Date.now() };
  registry.set(project.id, registration);
  return registration;
}

export function unregisterPreview(projectId: string): void {
  registry.delete(projectId);
}

async function ensureServer(): Promise<{ host: string; port: number }> {
  if (listening) return listening;
  const cfg = config();
  listening = new Promise((resolve, reject) => {
    const instance = http.createServer(handleRequest);
    instance.on('error', (error) => {
      listening = null;
      reject(error);
    });
    instance.listen(cfg.PREVIEW_PORT, cfg.PREVIEW_HOST, () => {
      const address = instance.address();
      const port = typeof address === 'object' && address ? address.port : cfg.PREVIEW_PORT;
      server = instance;
      log.info('preview server listening', { host: cfg.PREVIEW_HOST, port });
      resolve({ host: cfg.PREVIEW_HOST, port });
    });
    instance.keepAliveTimeout = 5_000;
  });
  return listening;
}

function handleRequest(request: http.IncomingMessage, response: http.ServerResponse): void {
  const send = (status: number, body: string, contentType = 'text/plain; charset=utf-8'): void => {
    response.writeHead(status, {
      'content-type': contentType,
      'content-security-policy': PREVIEW_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
    });
    response.end(body);
  };

  try {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      send(405, 'Method not allowed');
      return;
    }
    const url = new URL(request.url ?? '/', 'http://preview.local');
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments[0] !== 'p' || !segments[1]) {
      send(404, 'Preview not found. Expected /p/<projectId>/<file>.');
      return;
    }
    const registration = registry.get(segments[1]);
    if (!registration) {
      send(404, `No preview is registered for project ${segments[1]}. Build the project first.`);
      return;
    }

    const relative = segments.slice(2).join('/') || 'index.html';
    let absolute: string;
    try {
      absolute = resolveInside(registration.root, relative);
    } catch {
      send(403, 'Forbidden path');
      return;
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      // Single-page products route on the client; fall back to the shell.
      const fallback = path.join(registration.root, 'index.html');
      if (!fs.existsSync(fallback)) {
        send(404, 'Not found');
        return;
      }
      absolute = fallback;
    }

    const extension = path.extname(absolute).toLowerCase();
    const data = fs.readFileSync(absolute);
    response.writeHead(200, {
      'content-type': MIME_TYPES[extension] ?? 'application/octet-stream',
      'content-length': data.length,
      'content-security-policy': PREVIEW_CSP,
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'no-referrer',
      'cache-control': 'no-store',
      'cross-origin-resource-policy': 'same-site',
    });
    if (request.method === 'HEAD') response.end();
    else response.end(data);
  } catch (error) {
    log.error('preview request failed', { error });
    send(500, 'Preview server error');
  }
}

export interface PreviewHandle {
  readonly id: string;
  readonly projectId: string;
  readonly url: string;
  readonly baseUrl: string;
  readonly status: 'RUNNING' | 'FAILED';
}

/** Starts (or reuses) the preview server and records a preview row. */
export async function startPreview(project: Project, buildId?: string): Promise<PreviewHandle> {
  if (!isPreviewBuilt(project)) {
    const message = 'No web build output found. Run a web build before starting a preview.';
    recordPreview(project, buildId, '', 'FAILED', message);
    throw new Error(message);
  }
  const { host, port } = await ensureServer();
  registerPreview(project);
  const cfg = config();
  const baseUrl = cfg.PREVIEW_PUBLIC_URL ?? `http://${host}:${port}`;
  const url = `${baseUrl}/p/${project.id}/index.html`;
  const id = recordPreview(project, buildId, url, 'RUNNING', null);

  emitEvent({
    type: 'preview.status',
    scope: 'preview',
    projectId: project.id,
    message: 'preview running',
    data: { url, buildId: buildId ?? null },
  });
  return { id, projectId: project.id, url, baseUrl, status: 'RUNNING' };
}

export function stopPreview(projectId: string): void {
  unregisterPreview(projectId);
  db().prepare("UPDATE previews SET status = 'STOPPED', stopped_at = ? WHERE project_id = ? AND status = 'RUNNING'")
    .run(nowIso(), projectId);
  emitEvent({ type: 'preview.status', scope: 'preview', projectId, message: 'preview stopped' });
}

function recordPreview(project: Project, buildId: string | undefined, url: string, status: string, error: string | null): string {
  const id = newId('prv');
  db()
    .prepare(
      `INSERT INTO previews (id, project_id, build_id, kind, url, status, metrics, last_error, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '{}', ?, ?, ?)`,
    )
    .run(id, project.id, buildId ?? null, project.kind === 'game' ? 'game' : 'app', url, status, error, nowIso(), nowIso());
  return id;
}

export function updatePreviewMetrics(previewId: string, metrics: Record<string, unknown>, error?: string): void {
  db().prepare('UPDATE previews SET metrics = ?, last_error = ? WHERE id = ?')
    .run(toJson(metrics), error ?? null, previewId);
}

export async function previewServerInfo(): Promise<PreviewServerInfo | null> {
  if (!listening) return null;
  const { host, port } = await listening;
  return { host, port, baseUrl: `http://${host}:${port}`, projects: registry.size };
}

/** Restores previews for every project that already has build output on disk. */
export async function restorePreviews(projects: readonly Project[]): Promise<number> {
  let restored = 0;
  for (const project of projects) {
    if (!isPreviewBuilt(project)) continue;
    registerPreview(project);
    restored += 1;
  }
  if (restored > 0) await ensureServer();
  return restored;
}

export function shutdownPreviewServer(): void {
  server?.close();
  server = null;
  listening = null;
  registry.clear();
}

/** Resolves a preview file from disk for the authenticated proxy route. */
export function readPreviewFile(projectId: string, relativePath: string): { data: Buffer; contentType: string } | null {
  const project = getProject(projectId);
  if (!project) return null;
  const root = buildRoot(project);
  const target = relativePath || 'index.html';
  let absolute: string;
  try {
    absolute = resolveInside(root, target);
  } catch {
    return null;
  }
  if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return null;
  return {
    data: fs.readFileSync(absolute),
    contentType: MIME_TYPES[path.extname(absolute).toLowerCase()] ?? 'application/octet-stream',
  };
}

export const PREVIEW_CONTENT_SECURITY_POLICY = PREVIEW_CSP;
