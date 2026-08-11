import crypto from 'node:crypto';
import { db, fromJson, newId, nowIso } from '@/lib/db/client';
import { attachEmbedding, deleteEmbeddingsFor, embedTexts, searchSimilar } from './embeddings';
import { getEmbeddingProvider } from '@/lib/providers/registry';
import { createLogger } from '@/lib/observability/logger';
import { counter } from '@/lib/observability/metrics';

const log = createLogger('knowledge.error-memory');

/**
 * Error memory.
 *
 * Every failure the factory encounters — a TypeScript error, a Gradle failure, a
 * runtime exception in a generated game, a validation rejection — is stored with
 * a normalised signature. When the same failure recurs, the platform already
 * knows the change that resolved it last time and supplies that to the repair
 * step instead of improvising from scratch.
 *
 * Two lookups run together: exact signature match (fast, precise) and semantic
 * similarity over the message text (catches the same defect worded differently).
 * A memory is only marked resolved once a build or test run has actually passed
 * after the fix, so the archive contains verified remedies rather than guesses.
 */

export type ErrorCategory =
  | 'typescript'
  | 'bundler'
  | 'gradle'
  | 'runtime'
  | 'test'
  | 'asset'
  | 'security'
  | 'performance'
  | 'contract'
  | 'provider'
  | 'other';

export type ErrorPhase = 'generation' | 'build' | 'test' | 'preview' | 'package' | 'research';

export interface ErrorMemory {
  readonly id: string;
  readonly signature: string;
  readonly category: ErrorCategory;
  readonly phase: ErrorPhase;
  readonly message: string;
  readonly detail: string;
  readonly filePath: string | null;
  readonly occurrences: number;
  readonly resolved: boolean;
  readonly fixSummary: string;
  readonly fixDiff: string;
  readonly fixRationale: string;
  readonly verifiedBy: string;
  readonly verifiedAt: string | null;
  readonly reuseCount: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

interface ErrorMemoryRow {
  id: string;
  signature: string;
  category: string;
  phase: string;
  message: string;
  detail: string;
  file_path: string | null;
  project_id: string | null;
  occurrences: number;
  resolved: number;
  fix_summary: string;
  fix_diff: string;
  fix_rationale: string;
  verified_by: string;
  verified_at: string | null;
  reuse_count: number;
  embedding_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
}

function toMemory(row: ErrorMemoryRow): ErrorMemory {
  return {
    id: row.id,
    signature: row.signature,
    category: row.category as ErrorCategory,
    phase: row.phase as ErrorPhase,
    message: row.message,
    detail: row.detail,
    filePath: row.file_path,
    occurrences: row.occurrences,
    resolved: row.resolved === 1,
    fixSummary: row.fix_summary,
    fixDiff: row.fix_diff,
    fixRationale: row.fix_rationale,
    verifiedBy: row.verified_by,
    verifiedAt: row.verified_at,
    reuseCount: row.reuse_count,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

/**
 * Normalises an error into a stable signature.
 *
 * Absolute paths, line and column numbers, hashes, hex addresses, quoted
 * identifiers and numeric literals are all collapsed, because the *shape* of the
 * error is what recurs — "Property X does not exist on type Y" is the same
 * lesson whichever X and Y triggered it this time.
 */
export function errorSignature(category: ErrorCategory, message: string, filePath?: string): string {
  const normalised = message
    .replace(/\r/g, '')
    .split('\n')
    .slice(0, 3)
    .join(' ')
    .replace(/[A-Za-z]:\\[^\s:]+|\/[\w./@-]{6,}/g, '<path>')
    .replace(/\(\d+,\s*\d+\)|:\d+:\d+|line \d+/gi, '<pos>')
    .replace(/\b[0-9a-f]{8,}\b/gi, '<hash>')
    .replace(/'[^']{1,80}'|"[^"]{1,80}"|`[^`]{1,80}`/g, '<ident>')
    .replace(/\b\d+(\.\d+)?\b/g, '<n>')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, 300);

  const extension = filePath ? (filePath.match(/\.[a-z0-9]+$/i)?.[0] ?? '') : '';
  return `${category}:${extension}:${crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 24)}`;
}

export interface RecordFailureInput {
  readonly category: ErrorCategory;
  readonly phase: ErrorPhase;
  readonly message: string;
  readonly detail?: string;
  readonly filePath?: string;
  readonly projectId?: string;
}

/** Records (or increments) a failure. Returns the memory, fix included if known. */
export async function recordFailure(input: RecordFailureInput): Promise<ErrorMemory> {
  const signature = errorSignature(input.category, input.message, input.filePath);
  const database = db();
  const existing = database.prepare<[string], ErrorMemoryRow>('SELECT * FROM error_memories WHERE signature = ?').get(signature);

  if (existing) {
    database
      .prepare('UPDATE error_memories SET occurrences = occurrences + 1, last_seen_at = ?, detail = ? WHERE id = ?')
      .run(nowIso(), (input.detail ?? existing.detail).slice(0, 8000), existing.id);
    counter('error_memory.recurrence', { category: input.category, resolved: String(existing.resolved === 1) });
    if (existing.resolved === 1) {
      log.info('a previously resolved failure recurred; the stored remedy will be offered first', {
        signature,
        occurrences: existing.occurrences + 1,
      });
    }
    const refreshed = database.prepare<[string], ErrorMemoryRow>('SELECT * FROM error_memories WHERE id = ?').get(existing.id) as ErrorMemoryRow;
    return toMemory(refreshed);
  }

  const id = newId('errm');
  const now = nowIso();
  database
    .prepare(
      `INSERT INTO error_memories (id, signature, category, phase, message, detail, file_path, project_id,
         occurrences, resolved, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)`,
    )
    .run(id, signature, input.category, input.phase, input.message.slice(0, 4000), (input.detail ?? '').slice(0, 8000), input.filePath ?? null, input.projectId ?? null, now, now);

  // Index the message so semantically similar failures are recalled later.
  try {
    const text = `${input.category} ${input.phase}: ${input.message}`.slice(0, 2000);
    const [vector] = await embedTexts([text], { ownerType: 'error', projectId: input.projectId });
    if (vector) {
      const embeddingId = attachEmbedding('error', id, text, vector, getEmbeddingProvider().name);
      database.prepare('UPDATE error_memories SET embedding_id = ? WHERE id = ?').run(embeddingId, id);
    }
  } catch (error) {
    log.warn('failed to index an error memory; exact-signature recall still applies', { error: (error as Error).message });
  }

  counter('error_memory.new', { category: input.category });
  const row = database.prepare<[string], ErrorMemoryRow>('SELECT * FROM error_memories WHERE id = ?').get(id) as ErrorMemoryRow;
  return toMemory(row);
}

export interface RecordFixInput {
  readonly signature: string;
  readonly summary: string;
  readonly diff: string;
  readonly rationale: string;
  /** What proved the fix: "typecheck", "build", "runtime", "tests". */
  readonly verifiedBy: string;
}

/** Attaches a *verified* remedy to a memory. Never call this before it passed. */
export function recordFix(input: RecordFixInput): void {
  const changes = db()
    .prepare(
      `UPDATE error_memories SET resolved = 1, fix_summary = ?, fix_diff = ?, fix_rationale = ?,
         verified_by = ?, verified_at = ? WHERE signature = ?`,
    )
    .run(input.summary.slice(0, 2000), input.diff.slice(0, 20_000), input.rationale.slice(0, 4000), input.verifiedBy, nowIso(), input.signature).changes;
  if (changes > 0) {
    counter('error_memory.resolved', { verifiedBy: input.verifiedBy });
    log.info('remedy recorded', { signature: input.signature, verifiedBy: input.verifiedBy });
  }
}

export interface RecalledMemory extends ErrorMemory {
  /** 1 for an exact signature match, otherwise the semantic similarity. */
  readonly relevance: number;
  readonly matchedBy: 'signature' | 'semantic';
}

/**
 * Recalls prior knowledge about a failure: the exact match first, then similar
 * resolved failures. Only memories with a verified fix are worth injecting into
 * a repair prompt, so those are ranked first.
 */
export async function recallSimilar(
  input: { category: ErrorCategory; message: string; filePath?: string; limit?: number },
): Promise<RecalledMemory[]> {
  const limit = input.limit ?? 5;
  const database = db();
  const out = new Map<string, RecalledMemory>();

  const signature = errorSignature(input.category, input.message, input.filePath);
  const exact = database.prepare<[string], ErrorMemoryRow>('SELECT * FROM error_memories WHERE signature = ?').get(signature);
  if (exact) out.set(exact.id, { ...toMemory(exact), relevance: 1, matchedBy: 'signature' });

  try {
    const text = `${input.category}: ${input.message}`.slice(0, 2000);
    const [vector] = await embedTexts([text], { ownerType: 'error' });
    if (vector) {
      const hits = searchSimilar('error', vector, { limit: limit * 3, threshold: 0.6 });
      for (const hit of hits) {
        if (out.has(hit.ownerId)) continue;
        const row = database.prepare<[string], ErrorMemoryRow>('SELECT * FROM error_memories WHERE id = ?').get(hit.ownerId);
        if (row) out.set(row.id, { ...toMemory(row), relevance: hit.score, matchedBy: 'semantic' });
      }
    }
  } catch (error) {
    log.debug('semantic recall unavailable; falling back to signature match', { error: (error as Error).message });
  }

  const ranked = [...out.values()]
    .sort((a, b) => Number(b.resolved) - Number(a.resolved) || b.relevance - a.relevance)
    .slice(0, limit);

  if (ranked.length > 0) {
    const ids = ranked.map((m) => m.id);
    const placeholders = ids.map(() => '?').join(',');
    database.prepare(`UPDATE error_memories SET reuse_count = reuse_count + 1 WHERE id IN (${placeholders})`).run(...ids);
  }
  return ranked;
}

/**
 * Renders recalled memories as a prompt section. Explicitly instructs the model
 * that a known-good remedy is preferred and that weakening the code is not an
 * acceptable alternative.
 */
export function renderMemoriesForPrompt(memories: readonly RecalledMemory[]): string {
  const useful = memories.filter((m) => m.resolved && m.fixSummary);
  if (useful.length === 0) {
    const seen = memories.filter((m) => !m.resolved);
    if (seen.length === 0) return '';
    return (
      'PRIOR FAILURES WITH NO KNOWN REMEDY (do not repeat the approaches that failed before):\n' +
      seen.map((m) => `- [seen ${m.occurrences}x] ${m.message.slice(0, 200)}`).join('\n')
    );
  }
  return (
    'VERIFIED REMEDIES FROM PRIOR RUNS — prefer these; they were proven by an actual passing run:\n' +
    useful
      .map(
        (m, i) =>
          `${i + 1}. failure: ${m.message.slice(0, 220)}\n` +
          `   remedy (verified by ${m.verifiedBy}): ${m.fixSummary}\n` +
          `   why: ${m.fixRationale.slice(0, 300)}` +
          (m.fixDiff ? `\n   change applied:\n${indent(m.fixDiff.slice(0, 1200))}` : ''),
      )
      .join('\n')
  );
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `     ${line}`)
    .join('\n');
}

export interface ErrorMemoryStats {
  readonly total: number;
  readonly resolved: number;
  readonly recurrences: number;
  readonly reuse: number;
  readonly byCategory: Array<{ category: string; total: number; resolved: number }>;
}

export function errorMemoryStats(): ErrorMemoryStats {
  const database = db();
  const totals = database
    .prepare<[], { total: number; resolved: number; recurrences: number; reuse: number }>(
      `SELECT COUNT(*) AS total,
              SUM(resolved) AS resolved,
              SUM(occurrences - 1) AS recurrences,
              SUM(reuse_count) AS reuse
       FROM error_memories`,
    )
    .get();
  const byCategory = database
    .prepare<[], { category: string; total: number; resolved: number }>(
      'SELECT category, COUNT(*) AS total, SUM(resolved) AS resolved FROM error_memories GROUP BY category ORDER BY total DESC',
    )
    .all();
  return {
    total: totals?.total ?? 0,
    resolved: totals?.resolved ?? 0,
    recurrences: totals?.recurrences ?? 0,
    reuse: totals?.reuse ?? 0,
    byCategory,
  };
}

export function listErrorMemories(limit = 50, onlyResolved = false): ErrorMemory[] {
  const clause = onlyResolved ? 'WHERE resolved = 1' : '';
  return db()
    .prepare<[number], ErrorMemoryRow>(`SELECT * FROM error_memories ${clause} ORDER BY last_seen_at DESC LIMIT ?`)
    .all(Math.min(limit, 500))
    .map(toMemory);
}

export function forgetErrorMemory(id: string): void {
  deleteEmbeddingsFor('error', id);
  db().prepare('DELETE FROM error_memories WHERE id = ?').run(id);
}

void fromJson;
