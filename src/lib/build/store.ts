import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, fromJson, newId, nowIso, toJson } from '@/lib/db/client';
import { emitEvent } from '@/lib/observability/events';
import { ensureDir } from '@/lib/workspace/paths';
import type { Project } from '@/lib/workspace/project';

/**
 * Build and artifact bookkeeping.
 *
 * A build row exists from the moment a build starts, so an interrupted or
 * crashed build is visible as RUNNING rather than silently missing. Artifacts
 * are only recorded once the file exists on disk and its SHA-256 has been
 * computed from the bytes that were actually written.
 */

export type BuildTarget = 'web' | 'android-apk' | 'android-aab';
export type BuildMode = 'debug' | 'release';
export type BuildStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';

export interface BuildDiagnostic {
  readonly severity: 'error' | 'warning';
  readonly file?: string;
  readonly line?: number;
  readonly column?: number;
  readonly message: string;
  readonly code?: string;
}

export interface BuildRecord {
  readonly id: string;
  readonly projectId: string;
  readonly target: BuildTarget;
  readonly mode: BuildMode;
  readonly status: BuildStatus;
  readonly versionName: string;
  readonly versionCode: number;
  readonly exitCode: number | null;
  readonly durationMs: number;
  readonly logPath: string;
  readonly errorSummary: string;
  readonly diagnostics: BuildDiagnostic[];
  readonly toolchain: Record<string, unknown>;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
}

interface BuildRow {
  id: string;
  project_id: string;
  target: string;
  mode: string;
  status: string;
  version_name: string;
  version_code: number;
  exit_code: number | null;
  duration_ms: number;
  log_path: string;
  error_summary: string;
  diagnostics: string;
  toolchain: string;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

function toBuild(row: BuildRow): BuildRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    target: row.target as BuildTarget,
    mode: row.mode as BuildMode,
    status: row.status as BuildStatus,
    versionName: row.version_name,
    versionCode: row.version_code,
    exitCode: row.exit_code,
    durationMs: row.duration_ms,
    logPath: row.log_path,
    errorSummary: row.error_summary,
    diagnostics: fromJson<BuildDiagnostic[]>(row.diagnostics, []),
    toolchain: fromJson<Record<string, unknown>>(row.toolchain, {}),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    createdAt: row.created_at,
  };
}

export interface StartBuildInput {
  readonly project: Project;
  readonly target: BuildTarget;
  readonly mode: BuildMode;
  readonly toolchain?: Record<string, unknown>;
}

export function startBuild(input: StartBuildInput): BuildRecord {
  const id = newId('bld');
  const logsDir = path.join(input.project.workspacePath, 'logs');
  ensureDir(logsDir);
  const logPath = path.join(logsDir, `${id}.log`);
  fs.writeFileSync(logPath, `# build ${id} target=${input.target} mode=${input.mode}\n# started ${nowIso()}\n`, { mode: 0o640 });

  db()
    .prepare(
      `INSERT INTO builds (id, project_id, target, mode, status, version_name, version_code, duration_ms,
         log_path, error_summary, diagnostics, toolchain, started_at, created_at)
       VALUES (?, ?, ?, ?, 'RUNNING', ?, ?, 0, ?, '', '[]', ?, ?, ?)`,
    )
    .run(
      id,
      input.project.id,
      input.target,
      input.mode,
      input.project.versionName,
      input.project.version,
      logPath,
      toJson(input.toolchain ?? {}),
      nowIso(),
      nowIso(),
    );

  emitEvent({
    type: 'build.started',
    scope: 'build',
    projectId: input.project.id,
    message: `${input.target} ${input.mode} build started`,
    data: { buildId: id, target: input.target, mode: input.mode },
  });

  return toBuild(db().prepare<[string], BuildRow>('SELECT * FROM builds WHERE id = ?').get(id) as BuildRow);
}

export function appendBuildLog(build: BuildRecord, chunk: string): void {
  try {
    fs.appendFileSync(build.logPath, chunk);
  } catch {
    /* a full disk must not abort a build that is otherwise succeeding */
  }
  emitEvent({
    type: 'build.log',
    scope: 'build',
    projectId: build.projectId,
    message: chunk.length > 400 ? `${chunk.slice(0, 400)}…` : chunk,
    data: { buildId: build.id },
  });
}

export function readBuildLog(buildId: string, maxBytes = 400_000): string {
  const row = db().prepare<[string], BuildRow>('SELECT * FROM builds WHERE id = ?').get(buildId);
  if (!row) return '';
  try {
    const data = fs.readFileSync(row.log_path);
    return data.length > maxBytes ? `…\n${data.subarray(data.length - maxBytes).toString('utf8')}` : data.toString('utf8');
  } catch {
    return '';
  }
}

export interface FinishBuildInput {
  readonly status: BuildStatus;
  readonly exitCode?: number | null;
  readonly errorSummary?: string;
  readonly diagnostics?: readonly BuildDiagnostic[];
  readonly toolchain?: Record<string, unknown>;
}

export function finishBuild(build: BuildRecord, input: FinishBuildInput): BuildRecord {
  const finishedAt = nowIso();
  const duration = build.startedAt ? Date.parse(finishedAt) - Date.parse(build.startedAt) : 0;
  db()
    .prepare(
      `UPDATE builds SET status = ?, exit_code = ?, duration_ms = ?, error_summary = ?, diagnostics = ?,
         toolchain = COALESCE(?, toolchain), finished_at = ? WHERE id = ?`,
    )
    .run(
      input.status,
      input.exitCode ?? null,
      duration,
      (input.errorSummary ?? '').slice(0, 4000),
      toJson(input.diagnostics ?? []),
      input.toolchain ? toJson(input.toolchain) : null,
      finishedAt,
      build.id,
    );

  emitEvent({
    type: 'build.finished',
    scope: 'build',
    projectId: build.projectId,
    message: `${build.target} build ${input.status.toLowerCase()} in ${(duration / 1000).toFixed(1)}s`,
    data: { buildId: build.id, status: input.status, durationMs: duration, errorSummary: input.errorSummary ?? '' },
  });

  return toBuild(db().prepare<[string], BuildRow>('SELECT * FROM builds WHERE id = ?').get(build.id) as BuildRow);
}

export type ArtifactKind = 'apk' | 'aab' | 'web-bundle' | 'mapping' | 'source-archive';

export interface BuildArtifact {
  readonly id: string;
  readonly buildId: string;
  readonly projectId: string;
  readonly kind: ArtifactKind;
  readonly filename: string;
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly signed: boolean;
  readonly signatureInfo: Record<string, unknown>;
  readonly createdAt: string;
}

interface ArtifactRow {
  id: string;
  build_id: string;
  project_id: string;
  kind: string;
  filename: string;
  path: string;
  bytes: number;
  sha256: string;
  signed: number;
  signature_info: string;
  created_at: string;
}

function toArtifact(row: ArtifactRow): BuildArtifact {
  return {
    id: row.id,
    buildId: row.build_id,
    projectId: row.project_id,
    kind: row.kind as ArtifactKind,
    filename: row.filename,
    path: row.path,
    bytes: row.bytes,
    sha256: row.sha256,
    signed: row.signed === 1,
    signatureInfo: fromJson<Record<string, unknown>>(row.signature_info, {}),
    createdAt: row.created_at,
  };
}

/** Records an artifact, hashing the bytes on disk. Throws if the file is absent. */
export function recordArtifact(input: {
  build: BuildRecord;
  kind: ArtifactKind;
  absolutePath: string;
  signed?: boolean;
  signatureInfo?: Record<string, unknown>;
}): BuildArtifact {
  const stats = fs.statSync(input.absolutePath);
  if (!stats.isFile() || stats.size === 0) {
    throw new Error(`Refusing to record artifact ${input.absolutePath}: file is missing or empty`);
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(input.absolutePath)).digest('hex');
  const id = newId('art');
  db()
    .prepare(
      `INSERT INTO build_artifacts (id, build_id, project_id, kind, filename, path, bytes, sha256, signed, signature_info, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.build.id,
      input.build.projectId,
      input.kind,
      path.basename(input.absolutePath),
      input.absolutePath,
      stats.size,
      hash,
      input.signed ? 1 : 0,
      toJson(input.signatureInfo ?? {}),
      nowIso(),
    );
  return toArtifact(db().prepare<[string], ArtifactRow>('SELECT * FROM build_artifacts WHERE id = ?').get(id) as ArtifactRow);
}

export function listBuilds(projectId: string, limit = 25): BuildRecord[] {
  return db()
    .prepare<[string, number], BuildRow>('SELECT * FROM builds WHERE project_id = ? ORDER BY created_at DESC LIMIT ?')
    .all(projectId, limit)
    .map(toBuild);
}

export function getBuild(id: string): BuildRecord | null {
  const row = db().prepare<[string], BuildRow>('SELECT * FROM builds WHERE id = ?').get(id);
  return row ? toBuild(row) : null;
}

export function listArtifacts(projectId: string): BuildArtifact[] {
  return db()
    .prepare<[string], ArtifactRow>('SELECT * FROM build_artifacts WHERE project_id = ? ORDER BY created_at DESC')
    .all(projectId)
    .map(toArtifact);
}

export function getArtifact(id: string): BuildArtifact | null {
  const row = db().prepare<[string], ArtifactRow>('SELECT * FROM build_artifacts WHERE id = ?').get(id);
  return row ? toArtifact(row) : null;
}

export function latestArtifact(projectId: string, kind: ArtifactKind): BuildArtifact | null {
  const row = db()
    .prepare<[string, string], ArtifactRow>(
      'SELECT * FROM build_artifacts WHERE project_id = ? AND kind = ? ORDER BY created_at DESC LIMIT 1',
    )
    .get(projectId, kind);
  return row ? toArtifact(row) : null;
}

export function latestSuccessfulBuild(projectId: string, target: BuildTarget): BuildRecord | null {
  const row = db()
    .prepare<[string, string], BuildRow>(
      "SELECT * FROM builds WHERE project_id = ? AND target = ? AND status = 'SUCCEEDED' ORDER BY created_at DESC LIMIT 1",
    )
    .get(projectId, target);
  return row ? toBuild(row) : null;
}
