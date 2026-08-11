import fs from 'node:fs';
import path from 'node:path';
import { config } from '@/lib/config/env';
import { db, fromJson, newId, nowIso, toJson } from '@/lib/db/client';
import { ensureDir } from './paths';
import { WorkspaceFs, unifiedDiff, type FileChange } from './filesystem';
import { emitEvent } from '@/lib/observability/events';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('workspace.project');

/**
 * Project lifecycle and workspace layout.
 *
 * Each generated product owns an isolated workspace:
 *
 *   workspaces/<projectId>/
 *     source/     generated application or game source
 *     assets/     generated raster art, textures and meshes
 *     build/      build outputs (web bundle, Android project, intermediates)
 *     preview/    the exact bundle served by the preview engine
 *     artifacts/  published, checksummed deliverables (APK/AAB/zip)
 *     logs/       build, test and runtime logs
 *     metadata/   concept, brand, plans, indexes
 *     versions/   immutable snapshots enabling diff and rollback
 */

export const PROJECT_STATUSES = [
  'DISCOVERED',
  'ANALYZING',
  'PROPOSED',
  'APPROVED',
  'GENERATING',
  'BUILDING',
  'TESTING',
  'READY',
  'FAILED',
  'ARCHIVED',
] as const;

export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export type ProjectKind = 'app' | 'game' | 'hybrid';

export const WORKSPACE_DIRECTORIES = ['source', 'assets', 'build', 'preview', 'artifacts', 'logs', 'metadata', 'versions'] as const;

export interface Project {
  readonly id: string;
  readonly conceptId: string | null;
  readonly userId: string | null;
  readonly name: string;
  readonly slug: string;
  readonly kind: ProjectKind;
  readonly description: string;
  readonly status: ProjectStatus;
  readonly version: number;
  readonly versionName: string;
  readonly applicationId: string;
  readonly workspacePath: string;
  readonly brand: Record<string, unknown>;
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
}

interface ProjectRow {
  id: string;
  concept_id: string | null;
  user_id: string | null;
  name: string;
  slug: string;
  kind: ProjectKind;
  description: string;
  status: ProjectStatus;
  version: number;
  version_name: string;
  application_id: string;
  workspace_path: string;
  brand: string;
  metadata: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    conceptId: row.concept_id,
    userId: row.user_id,
    name: row.name,
    slug: row.slug,
    kind: row.kind,
    description: row.description,
    status: row.status,
    version: row.version,
    versionName: row.version_name,
    applicationId: row.application_id,
    workspacePath: row.workspace_path,
    brand: fromJson<Record<string, unknown>>(row.brand, {}),
    metadata: fromJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
  };
}

export function projectSlug(name: string, suffix?: string): string {
  const base =
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'product';
  return suffix ? `${base}-${suffix}` : base;
}

/** Android applicationId derived from the slug; always a valid Java package. */
export function applicationIdFor(slug: string): string {
  const segments = slug
    .split('-')
    .filter(Boolean)
    .map((s) => s.replace(/[^a-z0-9]/g, ''))
    .filter(Boolean)
    .map((s) => (/^[0-9]/.test(s) ? `a${s}` : s));
  const tail = segments.length > 0 ? segments.join('') : 'product';
  return `studio.factory.${tail}`.slice(0, 100);
}

export interface CreateProjectInput {
  readonly name: string;
  readonly kind: ProjectKind;
  readonly description: string;
  readonly conceptId?: string;
  readonly userId?: string;
  readonly brand?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
  readonly status?: ProjectStatus;
}

export function createProject(input: CreateProjectInput): Project {
  const database = db();
  const id = newId('prj');
  let slug = projectSlug(input.name);
  if (database.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug)) {
    slug = projectSlug(input.name, id.slice(-6));
  }
  const workspacePath = path.join(config().workspacesDir, id);
  for (const dir of WORKSPACE_DIRECTORIES) ensureDir(path.join(workspacePath, dir));

  const now = nowIso();
  database
    .prepare(
      `INSERT INTO projects (id, concept_id, user_id, name, slug, kind, description, status, version,
         version_name, application_id, workspace_path, brand, metadata, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, '0.1.0', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.conceptId ?? null,
      input.userId ?? null,
      input.name,
      slug,
      input.kind,
      input.description,
      input.status ?? 'APPROVED',
      applicationIdFor(slug),
      workspacePath,
      toJson(input.brand ?? {}),
      toJson(input.metadata ?? {}),
      now,
      now,
    );

  const project = getProject(id) as Project;
  emitEvent({
    type: 'project.created',
    scope: 'workspace',
    projectId: id,
    message: `project created: ${project.name}`,
    data: { slug: project.slug, kind: project.kind },
  });
  log.info('project created', { id, slug, kind: input.kind });
  return project;
}

export function getProject(id: string): Project | null {
  const row = db().prepare<[string], ProjectRow>('SELECT * FROM projects WHERE id = ?').get(id);
  return row ? toProject(row) : null;
}

export function getProjectBySlug(slug: string): Project | null {
  const row = db().prepare<[string], ProjectRow>('SELECT * FROM projects WHERE slug = ?').get(slug);
  return row ? toProject(row) : null;
}

export function listProjects(options: { limit?: number; status?: ProjectStatus } = {}): Project[] {
  const limit = Math.min(options.limit ?? 100, 500);
  if (options.status) {
    return db()
      .prepare<[string, number], ProjectRow>('SELECT * FROM projects WHERE status = ? ORDER BY updated_at DESC LIMIT ?')
      .all(options.status, limit)
      .map(toProject);
  }
  return db()
    .prepare<[number], ProjectRow>('SELECT * FROM projects ORDER BY updated_at DESC LIMIT ?')
    .all(limit)
    .map(toProject);
}

export function updateProject(
  id: string,
  patch: Partial<Pick<Project, 'status' | 'versionName' | 'description' | 'brand' | 'metadata' | 'name'>>,
): Project {
  const current = getProject(id);
  if (!current) throw new Error(`Unknown project ${id}`);
  const merged = {
    status: patch.status ?? current.status,
    versionName: patch.versionName ?? current.versionName,
    description: patch.description ?? current.description,
    name: patch.name ?? current.name,
    brand: patch.brand ? { ...current.brand, ...patch.brand } : current.brand,
    metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
  };
  db()
    .prepare(
      'UPDATE projects SET status = ?, version_name = ?, description = ?, name = ?, brand = ?, metadata = ?, updated_at = ? WHERE id = ?',
    )
    .run(merged.status, merged.versionName, merged.description, merged.name, toJson(merged.brand), toJson(merged.metadata), nowIso(), id);

  if (patch.status && patch.status !== current.status) {
    emitEvent({
      type: 'project.updated',
      scope: 'workspace',
      projectId: id,
      message: `status: ${current.status} → ${patch.status}`,
      data: { from: current.status, to: patch.status },
    });
  }
  return getProject(id) as Project;
}

export function archiveProject(id: string): void {
  db().prepare('UPDATE projects SET status = ?, archived_at = ?, updated_at = ? WHERE id = ?')
    .run('ARCHIVED', nowIso(), nowIso(), id);
}

export function workspaceFor(project: Project | string, area: (typeof WORKSPACE_DIRECTORIES)[number] = 'source'): WorkspaceFs {
  const resolved = typeof project === 'string' ? getProject(project) : project;
  if (!resolved) throw new Error(`Unknown project ${String(project)}`);
  const root = path.join(resolved.workspacePath, area);
  ensureDir(root);
  return new WorkspaceFs(root, resolved.id);
}

export function workspaceRoot(project: Project): string {
  return project.workspacePath;
}

// ---------------------------------------------------------------- versions --

export interface ProjectVersion {
  readonly id: string;
  readonly projectId: string;
  readonly version: number;
  readonly label: string;
  readonly authorType: string;
  readonly authorId: string;
  readonly summary: string;
  readonly diffStats: { files: number; additions: number; deletions: number };
  readonly changes: FileChange[];
  readonly snapshotPath: string;
  readonly createdAt: string;
}

interface VersionRow {
  id: string;
  project_id: string;
  version: number;
  label: string;
  author_type: string;
  author_id: string;
  summary: string;
  diff_stats: string;
  changes: string;
  snapshot_path: string;
  created_at: string;
}

function toVersion(row: VersionRow): ProjectVersion {
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    label: row.label,
    authorType: row.author_type,
    authorId: row.author_id,
    summary: row.summary,
    diffStats: fromJson(row.diff_stats, { files: 0, additions: 0, deletions: 0 }),
    changes: fromJson<FileChange[]>(row.changes, []),
    snapshotPath: row.snapshot_path,
    createdAt: row.created_at,
  };
}

function copyTree(from: string, to: string): void {
  ensureDir(to);
  fs.cpSync(from, to, { recursive: true, force: true, dereference: false });
}

export interface CommitOptions {
  readonly label: string;
  readonly summary: string;
  readonly authorType: 'agent' | 'user' | 'system';
  readonly authorId: string;
  readonly changes: readonly FileChange[];
}

/**
 * Records an immutable snapshot of `source/` and `assets/` plus the change list,
 * which is what makes rollback and the IDE's history panel real rather than
 * advisory.
 */
export function commitVersion(project: Project, options: CommitOptions): ProjectVersion {
  const database = db();
  const nextVersion = project.version + 1;
  const snapshotPath = path.join(project.workspacePath, 'versions', `v${nextVersion}`);
  copyTree(path.join(project.workspacePath, 'source'), path.join(snapshotPath, 'source'));
  copyTree(path.join(project.workspacePath, 'assets'), path.join(snapshotPath, 'assets'));

  const additions = options.changes.filter((c) => c.kind !== 'deleted').length;
  const deletions = options.changes.filter((c) => c.kind === 'deleted').length;
  const id = newId('ver');

  const tx = database.transaction(() => {
    database
      .prepare(
        `INSERT INTO project_versions (id, project_id, version, label, author_type, author_id, summary,
           diff_stats, changes, snapshot_path, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        project.id,
        nextVersion,
        options.label,
        options.authorType,
        options.authorId,
        options.summary,
        toJson({ files: options.changes.length, additions, deletions }),
        toJson(options.changes),
        snapshotPath,
        nowIso(),
      );
    database.prepare('UPDATE projects SET version = ?, updated_at = ? WHERE id = ?').run(nextVersion, nowIso(), project.id);
  });
  tx();

  emitEvent({
    type: 'project.updated',
    scope: 'workspace',
    projectId: project.id,
    message: `version ${nextVersion}: ${options.label}`,
    data: { version: nextVersion, files: options.changes.length },
  });

  return toVersion(
    database.prepare<[string], VersionRow>('SELECT * FROM project_versions WHERE id = ?').get(id) as VersionRow,
  );
}

export function listVersions(projectId: string): ProjectVersion[] {
  return db()
    .prepare<[string], VersionRow>('SELECT * FROM project_versions WHERE project_id = ? ORDER BY version DESC')
    .all(projectId)
    .map(toVersion);
}

export function getVersion(projectId: string, version: number): ProjectVersion | null {
  const row = db()
    .prepare<[string, number], VersionRow>('SELECT * FROM project_versions WHERE project_id = ? AND version = ?')
    .get(projectId, version);
  return row ? toVersion(row) : null;
}

/** Restores `source/` and `assets/` from a snapshot, recording it as a new version. */
export function rollbackTo(project: Project, version: number, actorId: string): ProjectVersion {
  const snapshot = getVersion(project.id, version);
  if (!snapshot) throw new Error(`Project ${project.id} has no version ${version}`);
  if (!fs.existsSync(snapshot.snapshotPath)) {
    throw new Error(`Snapshot for version ${version} is missing from disk at ${snapshot.snapshotPath}`);
  }

  const sourceDir = path.join(project.workspacePath, 'source');
  const assetsDir = path.join(project.workspacePath, 'assets');
  const beforeFiles = new WorkspaceFs(sourceDir, project.id).entries();

  fs.rmSync(sourceDir, { recursive: true, force: true });
  fs.rmSync(assetsDir, { recursive: true, force: true });
  copyTree(path.join(snapshot.snapshotPath, 'source'), sourceDir);
  copyTree(path.join(snapshot.snapshotPath, 'assets'), assetsDir);

  const afterFs = new WorkspaceFs(sourceDir, project.id);
  const afterFiles = new Map(afterFs.entries().map((e) => [e.path, e]));
  const changes: FileChange[] = [];
  for (const before of beforeFiles) {
    const after = afterFiles.get(before.path);
    if (!after) {
      changes.push({ path: before.path, kind: 'deleted', bytesBefore: before.bytes, bytesAfter: 0, hashBefore: before.sha256, hashAfter: null });
    } else if (after.sha256 !== before.sha256) {
      changes.push({ path: before.path, kind: 'modified', bytesBefore: before.bytes, bytesAfter: after.bytes, hashBefore: before.sha256, hashAfter: after.sha256 });
    }
    afterFiles.delete(before.path);
  }
  for (const [, entry] of afterFiles) {
    changes.push({ path: entry.path, kind: 'created', bytesBefore: 0, bytesAfter: entry.bytes, hashBefore: null, hashAfter: entry.sha256 });
  }

  return commitVersion(getProject(project.id) as Project, {
    label: `rollback to v${version}`,
    summary: `Restored the workspace from snapshot v${version} (${snapshot.label}).`,
    authorType: 'user',
    authorId: actorId,
    changes,
  });
}

/** Diff of a single file between a snapshot and the current working tree. */
export function diffAgainstVersion(project: Project, version: number, filePath: string): string {
  const snapshot = getVersion(project.id, version);
  if (!snapshot) throw new Error(`Project ${project.id} has no version ${version}`);
  const snapshotFs = new WorkspaceFs(path.join(snapshot.snapshotPath, 'source'), project.id);
  const currentFs = workspaceFor(project, 'source');
  const before = snapshotFs.exists(filePath) ? snapshotFs.readText(filePath) : '';
  const after = currentFs.exists(filePath) ? currentFs.readText(filePath) : '';
  return unifiedDiff(before, after, filePath);
}
