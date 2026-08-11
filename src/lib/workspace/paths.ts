import fs from 'node:fs';
import path from 'node:path';

/**
 * Filesystem jail.
 *
 * Every path that originates from an AI agent, an API request or a generated
 * project manifest is resolved through `resolveInside`, which normalises the
 * path, refuses absolute paths and traversal, and verifies (after symlink
 * resolution) that the result is still inside the root. Nothing in the platform
 * touches the filesystem with a caller-supplied path any other way.
 */

export class PathEscapeError extends Error {
  readonly status = 400;
  readonly code = 'PATH_ESCAPE';
  constructor(readonly attempted: string, readonly root: string) {
    super(`Refused path "${attempted}": outside the permitted root`);
    this.name = 'PathEscapeError';
  }
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isSafeRelativePath(relative: string): boolean {
  if (relative.length === 0 || relative.length > 1024) return false;
  if (path.isAbsolute(relative)) return false;
  if (/^[a-zA-Z]:/.test(relative)) return false;
  if (relative.includes('\0')) return false;
  const segments = relative.split(/[\\/]+/);
  if (segments.some((s) => s === '..')) return false;
  if (segments.some((s) => WINDOWS_RESERVED.test(s))) return false;
  if (segments.some((s) => s.startsWith(' ') || s.endsWith(' ') || s.endsWith('.'))) return false;
  return true;
}

/** Resolves `relative` against `root`, guaranteeing the result stays inside it. */
export function resolveInside(root: string, relative: string): string {
  if (!isSafeRelativePath(relative)) throw new PathEscapeError(relative, root);
  const absoluteRoot = path.resolve(root);
  const candidate = path.resolve(absoluteRoot, relative);
  const withSep = absoluteRoot.endsWith(path.sep) ? absoluteRoot : absoluteRoot + path.sep;
  if (candidate !== absoluteRoot && !candidate.startsWith(withSep)) throw new PathEscapeError(relative, root);

  // Defend against symlinks planted inside the root that point outside it.
  const realRoot = safeRealpath(absoluteRoot);
  const realCandidate = safeRealpath(candidate);
  const realWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  if (realCandidate !== realRoot && !realCandidate.startsWith(realWithSep)) throw new PathEscapeError(relative, root);

  return candidate;
}

/** Realpath of the closest existing ancestor, so not-yet-created files work. */
function safeRealpath(target: string): string {
  let current = target;
  for (;;) {
    try {
      const real = fs.realpathSync(current);
      return current === target ? real : path.join(real, path.relative(current, target));
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      current = parent;
    }
  }
}

export function toRelative(root: string, absolute: string): string {
  return path.relative(path.resolve(root), absolute).split(path.sep).join('/');
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export interface WalkOptions {
  readonly maxFiles?: number;
  readonly maxDepth?: number;
  readonly skipDirs?: readonly string[];
}

const DEFAULT_SKIP = ['node_modules', '.git', 'build', 'dist', '.gradle', '.next', 'coverage'];

/** Depth-limited directory walk returning workspace-relative POSIX paths. */
export function walkFiles(root: string, options: WalkOptions = {}): string[] {
  const maxFiles = options.maxFiles ?? 5000;
  const maxDepth = options.maxDepth ?? 12;
  const skip = new Set(options.skipDirs ?? DEFAULT_SKIP);
  const out: string[] = [];

  const visit = (dir: string, depth: number): void => {
    if (depth > maxDepth || out.length >= maxFiles) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= maxFiles) return;
      if (entry.name.startsWith('.') && entry.name !== '.gitignore') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue;
        visit(full, depth + 1);
      } else if (entry.isFile()) {
        out.push(toRelative(root, full));
      }
    }
  };

  visit(path.resolve(root), 0);
  return out;
}

export function directorySize(root: string): number {
  let total = 0;
  const visit = (dir: string): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) {
        try {
          total += fs.statSync(full).size;
        } catch {
          /* file vanished mid-walk */
        }
      }
    }
  };
  visit(path.resolve(root));
  return total;
}
