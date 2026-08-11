import path from 'node:path';
import crypto from 'node:crypto';
import { db, nowIso, toJson, fromJson, newId } from '@/lib/db/client';
import { workspaceFor, type Project } from '@/lib/workspace/project';
import { embedTexts, searchSimilar, attachEmbedding, deleteEmbeddingsFor } from '@/lib/knowledge/embeddings';
import { getEmbeddingProvider } from '@/lib/providers/registry';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('ide.index');

/**
 * Incremental codebase index.
 *
 * Extracts exported symbols, imports and a short structural summary from every
 * source file so the coding agent can be given *relevant* context instead of the
 * whole repository. Indexing is incremental: a file is re-parsed only when its
 * content hash changes, which keeps re-indexing after an edit close to free.
 *
 * Symbol extraction is lexical rather than a full TypeScript parse. That is a
 * deliberate trade-off: it costs microseconds per file, needs no compiler
 * instance, and the coding agent only needs to know what exists and where —
 * type resolution is the compiler's job during the verify step.
 */

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'const' | 'enum' | 'component';

export interface SymbolInfo {
  readonly kind: SymbolKind;
  readonly name: string;
  readonly line: number;
  readonly exported: boolean;
  readonly signature: string;
}

export interface IndexedFile {
  readonly path: string;
  readonly language: string;
  readonly size: number;
  readonly hash: string;
  readonly symbols: SymbolInfo[];
  readonly imports: string[];
  readonly summary: string;
}

const LANGUAGES: Readonly<Record<string, string>> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.mjs': 'javascript',
  '.json': 'json',
  '.html': 'html',
  '.css': 'css',
  '.md': 'markdown',
  '.xml': 'xml',
  '.kts': 'kotlin',
  '.java': 'java',
};

const SYMBOL_PATTERNS: ReadonlyArray<{ kind: SymbolKind; pattern: RegExp }> = [
  { kind: 'function', pattern: /^(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(\([^)]*\))?/gm },
  { kind: 'class', pattern: /^(export\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)([^{]*)/gm },
  { kind: 'interface', pattern: /^(export\s+)?interface\s+([A-Za-z_$][\w$]*)([^{]*)/gm },
  { kind: 'type', pattern: /^(export\s+)?type\s+([A-Za-z_$][\w$]*)\s*(=[^;\n]{0,120})?/gm },
  { kind: 'enum', pattern: /^(export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)()/gm },
  { kind: 'const', pattern: /^(export\s+)?(?:const|let)\s+([A-Za-z_$][\w$]*)\s*(:[^=\n]{0,80})?\s*=/gm },
];

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)\s+(?:[\s\S]*?from\s+)?['"]([^'"]+)['"]/g;

export function extractSymbols(source: string): SymbolInfo[] {
  const lineStarts: number[] = [0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') lineStarts.push(i + 1);
  }
  const lineOf = (index: number): number => {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if ((lineStarts[mid] as number) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };

  const symbols: SymbolInfo[] = [];
  const seen = new Set<string>();
  for (const { kind, pattern } of SYMBOL_PATTERNS) {
    pattern.lastIndex = 0;
    let match = pattern.exec(source);
    while (match) {
      const name = match[2];
      if (name && !seen.has(`${kind}:${name}`)) {
        seen.add(`${kind}:${name}`);
        symbols.push({
          kind,
          name,
          line: lineOf(match.index),
          exported: Boolean(match[1]),
          signature: `${match[0]}`.trim().slice(0, 200).replace(/\s+/g, ' '),
        });
      }
      match = pattern.exec(source);
    }
  }
  return symbols.sort((a, b) => a.line - b.line);
}

export function extractImports(source: string): string[] {
  const imports = new Set<string>();
  IMPORT_PATTERN.lastIndex = 0;
  let match = IMPORT_PATTERN.exec(source);
  while (match) {
    if (match[1]) imports.add(match[1]);
    match = IMPORT_PATTERN.exec(source);
  }
  return [...imports];
}

function summarise(relative: string, source: string, symbols: readonly SymbolInfo[]): string {
  const docComment = /\/\*\*([\s\S]{0,600}?)\*\//.exec(source)?.[1];
  const doc = docComment
    ? docComment
        .split('\n')
        .map((line) => line.replace(/^\s*\*\s?/, '').trim())
        .filter(Boolean)
        .slice(0, 4)
        .join(' ')
    : '';
  const exported = symbols.filter((s) => s.exported).map((s) => `${s.kind} ${s.name}`);
  return `${relative}: ${doc || 'no module documentation'}${exported.length ? ` | exports: ${exported.slice(0, 14).join(', ')}` : ''}`.slice(0, 700);
}

export interface IndexResult {
  readonly indexed: number;
  readonly unchanged: number;
  readonly removed: number;
  readonly files: readonly IndexedFile[];
  readonly durationMs: number;
}

const INDEXABLE = new Set(['.ts', '.tsx', '.js', '.mjs', '.json', '.html', '.css', '.md']);

export async function indexProject(project: Project, options: { embed?: boolean } = {}): Promise<IndexResult> {
  const started = Date.now();
  const workspace = workspaceFor(project, 'source');
  const database = db();

  const existing = new Map(
    database
      .prepare<[string], { path: string; hash: string }>('SELECT path, hash FROM project_file_index WHERE project_id = ?')
      .all(project.id)
      .map((row) => [row.path, row.hash]),
  );

  const files: IndexedFile[] = [];
  const present = new Set<string>();
  let unchanged = 0;
  const changed: IndexedFile[] = [];

  for (const relative of workspace.list({ maxFiles: 3000 })) {
    const extension = path.extname(relative).toLowerCase();
    if (!INDEXABLE.has(extension)) continue;
    present.add(relative);

    const buffer = workspace.readBuffer(relative);
    if (buffer.length > 1_500_000) continue;
    const hash = crypto.createHash('sha256').update(buffer).digest('hex');
    const source = buffer.toString('utf8');
    const symbols = extractSymbols(source);
    const entry: IndexedFile = {
      path: relative,
      language: LANGUAGES[extension] ?? 'text',
      size: buffer.length,
      hash,
      symbols,
      imports: extractImports(source),
      summary: summarise(relative, source, symbols),
    };
    files.push(entry);

    if (existing.get(relative) === hash) {
      unchanged += 1;
      continue;
    }
    changed.push(entry);
  }

  const upsert = database.prepare(
    `INSERT INTO project_file_index (id, project_id, path, language, size, hash, symbols, imports, summary, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, path) DO UPDATE SET
       language = excluded.language, size = excluded.size, hash = excluded.hash,
       symbols = excluded.symbols, imports = excluded.imports, summary = excluded.summary, updated_at = excluded.updated_at`,
  );
  const removeStatement = database.prepare('DELETE FROM project_file_index WHERE project_id = ? AND path = ?');

  let removed = 0;
  const tx = database.transaction(() => {
    for (const entry of changed) {
      upsert.run(newId('idx'), project.id, entry.path, entry.language, entry.size, entry.hash, toJson(entry.symbols), toJson(entry.imports), entry.summary, nowIso());
    }
    for (const [existingPath] of existing) {
      if (!present.has(existingPath)) {
        removeStatement.run(project.id, existingPath);
        removed += 1;
      }
    }
  });
  tx();

  if (options.embed !== false && changed.length > 0) {
    const model = getEmbeddingProvider().name;
    const vectors = await embedTexts(changed.map((f) => f.summary), { ownerType: 'code', projectId: project.id });
    changed.forEach((entry, i) => {
      deleteEmbeddingsFor('code', `${project.id}:${entry.path}`);
      attachEmbedding('code', `${project.id}:${entry.path}`, entry.summary, vectors[i] as Float32Array, model);
    });
  }

  log.debug('project indexed', { projectId: project.id, indexed: changed.length, unchanged, removed });
  return { indexed: changed.length, unchanged, removed, files, durationMs: Date.now() - started };
}

export interface IndexedFileRow {
  path: string;
  language: string;
  size: number;
  hash: string;
  symbols: string;
  imports: string;
  summary: string;
  updated_at: string;
}

export function listIndexedFiles(projectId: string): IndexedFile[] {
  return db()
    .prepare<[string], IndexedFileRow>('SELECT * FROM project_file_index WHERE project_id = ? ORDER BY path')
    .all(projectId)
    .map((row) => ({
      path: row.path,
      language: row.language,
      size: row.size,
      hash: row.hash,
      symbols: fromJson<SymbolInfo[]>(row.symbols, []),
      imports: fromJson<string[]>(row.imports, []),
      summary: row.summary,
    }));
}

export interface SymbolHit {
  readonly path: string;
  readonly symbol: SymbolInfo;
}

export function findSymbol(projectId: string, name: string): SymbolHit[] {
  const needle = name.toLowerCase();
  return listIndexedFiles(projectId).flatMap((file) =>
    file.symbols.filter((s) => s.name.toLowerCase().includes(needle)).map((symbol) => ({ path: file.path, symbol })),
  );
}

export interface DependencyEdge {
  readonly from: string;
  readonly to: string;
  readonly external: boolean;
}

/** Resolves relative imports into workspace paths to form the dependency graph. */
export function dependencyGraph(projectId: string): DependencyEdge[] {
  const files = listIndexedFiles(projectId);
  const known = new Set(files.map((f) => f.path));
  const edges: DependencyEdge[] = [];

  for (const file of files) {
    for (const specifier of file.imports) {
      if (!specifier.startsWith('.')) {
        edges.push({ from: file.path, to: specifier, external: true });
        continue;
      }
      const base = path.posix.join(path.posix.dirname(file.path), specifier);
      const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}.js`];
      const resolved = candidates.find((c) => known.has(c));
      edges.push({ from: file.path, to: resolved ?? specifier, external: !resolved });
    }
  }
  return edges;
}

export interface RelevantFile {
  readonly path: string;
  readonly score: number;
  readonly reason: string;
}

/**
 * Ranks files for a task using three signals: semantic similarity of the file
 * summary to the task, lexical overlap of identifiers, and proximity in the
 * import graph to already-selected files.
 */
export async function selectRelevantFiles(
  project: Project,
  task: string,
  options: { limit?: number; seeds?: readonly string[] } = {},
): Promise<RelevantFile[]> {
  const limit = options.limit ?? 12;
  const files = listIndexedFiles(project.id);
  if (files.length === 0) return [];

  const scores = new Map<string, { score: number; reasons: string[] }>();
  const bump = (filePath: string, amount: number, reason: string): void => {
    const entry = scores.get(filePath) ?? { score: 0, reasons: [] };
    entry.score += amount;
    if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
    scores.set(filePath, entry);
  };

  const [queryVector] = await embedTexts([task], { ownerType: 'code', projectId: project.id });
  if (queryVector) {
    const hits = searchSimilar('code', queryVector, { limit: limit * 3, threshold: 0.25 });
    for (const hit of hits) {
      const filePath = hit.ownerId.slice(project.id.length + 1);
      bump(filePath, hit.score * 2.2, `semantic match ${(hit.score * 100).toFixed(0)}%`);
    }
  }

  const terms = (task.toLowerCase().match(/[a-z_$][\w$]{2,}/g) ?? []).slice(0, 40);
  for (const file of files) {
    const haystack = `${file.path} ${file.summary} ${file.symbols.map((s) => s.name).join(' ')}`.toLowerCase();
    const matches = terms.filter((term) => haystack.includes(term)).length;
    if (matches > 0) bump(file.path, Math.min(2, matches * 0.32), `${matches} identifier matches`);
  }

  for (const seed of options.seeds ?? []) bump(seed, 3, 'explicitly requested');

  const edges = dependencyGraph(project.id);
  const selected = new Set([...scores.entries()].filter(([, v]) => v.score > 0.5).map(([k]) => k));
  for (const edge of edges) {
    if (edge.external) continue;
    if (selected.has(edge.from)) bump(edge.to, 0.5, `imported by ${edge.from}`);
    if (selected.has(edge.to)) bump(edge.from, 0.35, `imports ${edge.to}`);
  }

  return [...scores.entries()]
    .map(([filePath, value]) => ({ path: filePath, score: Number(value.score.toFixed(3)), reason: value.reasons.slice(0, 3).join('; ') }))
    .filter((entry) => files.some((f) => f.path === entry.path))
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}
