import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ensureDir, resolveInside, toRelative, walkFiles, directorySize } from './paths';
import { emitEvent } from '@/lib/observability/events';
import { counter } from '@/lib/observability/metrics';

/**
 * Jailed workspace filesystem.
 *
 * This is the *only* file API exposed to agents and to the IDE. Every path is
 * resolved through the jail, writes are size-capped and atomic, and every
 * mutation is journalled so the IDE, the version history and the live activity
 * stream all see the same events.
 */

/** Source and text files: anything larger is a generation defect, not an asset. */
export const MAX_FILE_BYTES = 4 * 1024 * 1024;
/**
 * Binary assets. A rigged character with a full PBR texture set is legitimately
 * several megabytes of GLB, so binaries get their own, larger ceiling.
 */
export const MAX_BINARY_BYTES = 24 * 1024 * 1024;
export const MAX_WORKSPACE_BYTES = 1536 * 1024 * 1024;

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.webp', '.gif', '.ico', '.bin', '.glb', '.gltf', '.ktx2',
  '.mp3', '.ogg', '.wav', '.zip', '.apk', '.aab', '.jar', '.keystore', '.jks', '.woff', '.woff2',
]);

export type ChangeKind = 'created' | 'modified' | 'deleted';

export interface FileChange {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly hashBefore: string | null;
  readonly hashAfter: string | null;
}

export interface FileEntry {
  readonly path: string;
  readonly bytes: number;
  readonly binary: boolean;
  readonly modifiedAt: string;
  readonly sha256: string;
}

export class WorkspaceQuotaError extends Error {
  readonly code = 'WORKSPACE_QUOTA';
  readonly status = 413;
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceQuotaError';
  }
}

function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export class WorkspaceFs {
  private readonly changes: FileChange[] = [];

  constructor(
    readonly root: string,
    private readonly projectId: string,
  ) {
    ensureDir(root);
  }

  absolute(relative: string): string {
    return resolveInside(this.root, relative);
  }

  exists(relative: string): boolean {
    try {
      return fs.existsSync(this.absolute(relative));
    } catch {
      return false;
    }
  }

  isBinary(relative: string): boolean {
    return BINARY_EXTENSIONS.has(path.extname(relative).toLowerCase());
  }

  readBuffer(relative: string): Buffer {
    return fs.readFileSync(this.absolute(relative));
  }

  readText(relative: string): string {
    return this.readBuffer(relative).toString('utf8');
  }

  stat(relative: string): FileEntry | null {
    const target = this.absolute(relative);
    try {
      const stats = fs.statSync(target);
      if (!stats.isFile()) return null;
      return {
        path: relative,
        bytes: stats.size,
        binary: this.isBinary(relative),
        modifiedAt: stats.mtime.toISOString(),
        sha256: sha256(fs.readFileSync(target)),
      };
    } catch {
      return null;
    }
  }

  list(options: { maxFiles?: number } = {}): string[] {
    return walkFiles(this.root, { maxFiles: options.maxFiles ?? 4000 });
  }

  entries(options: { maxFiles?: number } = {}): FileEntry[] {
    return this.list(options)
      .map((relative) => this.stat(relative))
      .filter((entry): entry is FileEntry => entry !== null);
  }

  write(relative: string, contents: string | Buffer): FileChange {
    const data = Buffer.isBuffer(contents) ? contents : Buffer.from(contents, 'utf8');
    const limit = this.isBinary(relative) ? MAX_BINARY_BYTES : MAX_FILE_BYTES;
    if (data.length > limit) {
      throw new WorkspaceQuotaError(`file ${relative} is ${data.length} bytes, over the ${limit} byte limit for this file type`);
    }
    const target = this.absolute(relative);
    const existed = fs.existsSync(target);
    const before = existed ? fs.readFileSync(target) : null;

    if (!existed && directorySize(this.root) + data.length > MAX_WORKSPACE_BYTES) {
      throw new WorkspaceQuotaError(`workspace for project ${this.projectId} would exceed ${MAX_WORKSPACE_BYTES} bytes`);
    }

    ensureDir(path.dirname(target));
    const tmp = `${target}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o640 });
    fs.renameSync(tmp, target);

    const change: FileChange = {
      path: relative,
      kind: existed ? 'modified' : 'created',
      bytesBefore: before?.length ?? 0,
      bytesAfter: data.length,
      hashBefore: before ? sha256(before) : null,
      hashAfter: sha256(data),
    };
    if (change.hashBefore !== change.hashAfter) {
      this.changes.push(change);
      counter('workspace.write', { kind: change.kind });
      emitEvent({
        type: 'file.changed',
        scope: 'workspace',
        projectId: this.projectId,
        message: `${change.kind}: ${relative}`,
        data: { path: relative, kind: change.kind, bytes: data.length },
      });
    }
    return change;
  }

  delete(relative: string): FileChange | null {
    const target = this.absolute(relative);
    if (!fs.existsSync(target)) return null;
    const before = fs.readFileSync(target);
    fs.rmSync(target, { force: true });
    const change: FileChange = {
      path: relative,
      kind: 'deleted',
      bytesBefore: before.length,
      bytesAfter: 0,
      hashBefore: sha256(before),
      hashAfter: null,
    };
    this.changes.push(change);
    emitEvent({
      type: 'file.changed',
      scope: 'workspace',
      projectId: this.projectId,
      message: `deleted: ${relative}`,
      data: { path: relative, kind: 'deleted' },
    });
    return change;
  }

  move(from: string, to: string): void {
    const source = this.absolute(from);
    const target = this.absolute(to);
    ensureDir(path.dirname(target));
    const data = fs.readFileSync(source);
    fs.renameSync(source, target);
    this.changes.push({
      path: from,
      kind: 'deleted',
      bytesBefore: data.length,
      bytesAfter: 0,
      hashBefore: sha256(data),
      hashAfter: null,
    });
    this.changes.push({
      path: to,
      kind: 'created',
      bytesBefore: 0,
      bytesAfter: data.length,
      hashBefore: null,
      hashAfter: sha256(data),
    });
  }

  mkdir(relative: string): void {
    ensureDir(this.absolute(relative));
  }

  removeDirectory(relative: string): void {
    fs.rmSync(this.absolute(relative), { recursive: true, force: true });
  }

  /** Mutations recorded since construction (or since the last `takeChanges`). */
  takeChanges(): FileChange[] {
    return this.changes.splice(0, this.changes.length);
  }

  peekChanges(): readonly FileChange[] {
    return this.changes;
  }

  totalBytes(): number {
    return directorySize(this.root);
  }

  relative(absolutePath: string): string {
    return toRelative(this.root, absolutePath);
  }
}

/** Unified-diff generation used by the IDE's review panel and version history. */
export function unifiedDiff(before: string, after: string, filePath: string, contextLines = 3): string {
  const a = before.split('\n');
  const b = after.split('\n');
  const lcs = longestCommonSubsequence(a, b);

  const hunks: string[] = [];
  let ai = 0;
  let bi = 0;
  let li = 0;
  const ops: Array<{ type: ' ' | '-' | '+'; text: string }> = [];

  while (ai < a.length || bi < b.length) {
    const common = lcs[li];
    if (common !== undefined && a[ai] === common && b[bi] === common) {
      ops.push({ type: ' ', text: common });
      ai += 1;
      bi += 1;
      li += 1;
      continue;
    }
    if (ai < a.length && (common === undefined || a[ai] !== common)) {
      ops.push({ type: '-', text: a[ai] as string });
      ai += 1;
      continue;
    }
    if (bi < b.length) {
      ops.push({ type: '+', text: b[bi] as string });
      bi += 1;
    }
  }

  let cursorA = 1;
  let cursorB = 1;
  let index = 0;
  while (index < ops.length) {
    if ((ops[index] as { type: string }).type === ' ') {
      cursorA += 1;
      cursorB += 1;
      index += 1;
      continue;
    }
    const start = Math.max(0, index - contextLines);
    let end = index;
    while (end < ops.length) {
      const op = ops[end] as { type: string };
      if (op.type !== ' ') {
        end += 1;
        continue;
      }
      let lookahead = end;
      let quiet = 0;
      while (lookahead < ops.length && (ops[lookahead] as { type: string }).type === ' ' && quiet < contextLines * 2) {
        lookahead += 1;
        quiet += 1;
      }
      if (quiet >= contextLines * 2 || lookahead >= ops.length) break;
      end = lookahead;
    }
    const slice = ops.slice(start, Math.min(ops.length, end + contextLines));
    const removed = slice.filter((o) => o.type !== '+').length;
    const added = slice.filter((o) => o.type !== '-').length;
    const startA = cursorA - (index - start);
    const startB = cursorB - (index - start);
    hunks.push(`@@ -${startA},${removed} +${startB},${added} @@`);
    for (const op of slice) hunks.push(`${op.type}${op.text}`);
    for (const op of ops.slice(index, Math.min(ops.length, end + contextLines))) {
      if (op.type !== '+') cursorA += 1;
      if (op.type !== '-') cursorB += 1;
    }
    index = Math.min(ops.length, end + contextLines);
  }

  if (hunks.length === 0) return '';
  return [`--- a/${filePath}`, `+++ b/${filePath}`, ...hunks].join('\n');
}

function longestCommonSubsequence(a: readonly string[], b: readonly string[]): string[] {
  // Bounded to keep diffing predictable on very large generated files.
  const limit = 4000;
  if (a.length > limit || b.length > limit) return [];
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      (table[i] as number[])[j] =
        a[i] === b[j]
          ? ((table[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((table[i + 1] as number[])[j] as number, (table[i] as number[])[j + 1] as number);
    }
  }
  const out: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push(a[i] as string);
      i += 1;
      j += 1;
    } else if (((table[i + 1] as number[])[j] as number) >= ((table[i] as number[])[j + 1] as number)) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return out;
}
