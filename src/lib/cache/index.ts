import crypto from 'node:crypto';
import { config } from '@/lib/config/env';
import { db, newId, nowIso, toJson } from '@/lib/db/client';
import { LruCache } from './memory';
import { attachEmbedding, cosineSimilarity, embedText, getEmbedding } from '@/lib/knowledge/embeddings';
import { getEmbeddingProvider } from '@/lib/providers/registry';
import { createLogger } from '@/lib/observability/logger';
import { counter, track } from '@/lib/observability/metrics';
import { emitEvent } from '@/lib/observability/events';

const log = createLogger('cache');

/**
 * Multi-level cache.
 *
 *   L1  in-process LRU                (this module)
 *   L2  SQLite persistent store       (this module)
 *   L3  semantic similarity lookup    (this module, backed by the embedding store)
 *   L4  HTTP conditional cache        (cache/http.ts)
 *   L5  research result cache         (namespace 'search' / 'document')
 *   L6  LLM response cache            (namespace 'llm')
 *   L7  embedding cache               (knowledge/embeddings.ts)
 *   L8  asset metadata cache          (namespace 'asset')
 *
 * A lookup walks L1 → L2 → L3 and only then performs the real work, and
 * identical concurrent lookups are coalesced into a single computation.
 */

export type CacheSource = 'l1' | 'l2' | 'semantic' | 'coalesced' | 'computed';

export interface CacheResult<T> {
  readonly value: T;
  readonly source: CacheSource;
  /** Similarity score when the value came from the semantic layer. */
  readonly similarity?: number;
  /** Estimated cost avoided by not recomputing. */
  readonly savedUsd: number;
}

export interface CacheOptions {
  readonly namespace: string;
  readonly ttlSeconds?: number;
  /**
   * Text used for the semantic layer. When present, an entry whose semantic text
   * is close enough to this one satisfies the lookup.
   */
  readonly semanticText?: string;
  readonly semanticThreshold?: number;
  /** Estimated cost of computing the value; used to report cache savings. */
  readonly estimatedCostUsd?: number;
  readonly bypass?: boolean;
}

interface CacheRow {
  key: string;
  namespace: string;
  value: Buffer;
  is_json: number;
  embedding_id: string | null;
  meta: string;
  expires_at: string;
}

const l1 = new LruCache<unknown>(config().CACHE_L1_MAX_ENTRIES);
const inFlight = new Map<string, Promise<unknown>>();

export function cacheKey(namespace: string, parts: unknown): string {
  const canonical = typeof parts === 'string' ? parts : stableStringify(parts);
  return `${namespace}:${crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 40)}`;
}

/** Deterministic JSON with sorted keys so equivalent objects hash identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`;
}

function readRow(key: string): CacheRow | undefined {
  return db()
    .prepare<[string, string], CacheRow>('SELECT * FROM cache_entries WHERE key = ? AND expires_at > ?')
    .get(key, nowIso());
}

function decode<T>(row: CacheRow): T {
  return row.is_json === 1 ? (JSON.parse(row.value.toString('utf8')) as T) : (row.value as unknown as T);
}

function touch(key: string): void {
  db().prepare('UPDATE cache_entries SET hits = hits + 1, last_hit_at = ? WHERE key = ?').run(nowIso(), key);
}

export function cacheGet<T>(key: string): T | undefined {
  const hot = l1.get(key);
  if (hot !== undefined) {
    track('cache.lookup', 1, { level: 'l1', outcome: 'hit' });
    return hot as T;
  }
  const row = readRow(key);
  if (!row) return undefined;
  touch(key);
  const value = decode<T>(row);
  const ttl = Math.max(1, Math.floor((new Date(row.expires_at).getTime() - Date.now()) / 1000));
  l1.set(key, value, ttl, row.value.length);
  track('cache.lookup', 1, { level: 'l2', outcome: 'hit' });
  return value;
}

export function cacheSet<T>(key: string, namespace: string, value: T, ttlSeconds: number, embeddingId?: string, meta?: Record<string, unknown>): void {
  const serialised = Buffer.from(JSON.stringify(value ?? null), 'utf8');
  const expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
  db()
    .prepare(
      `INSERT INTO cache_entries (key, namespace, value, is_json, size_bytes, hits, embedding_id, meta, created_at, expires_at)
       VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET
         value = excluded.value, size_bytes = excluded.size_bytes, embedding_id = excluded.embedding_id,
         meta = excluded.meta, expires_at = excluded.expires_at`,
    )
    .run(key, namespace, serialised, serialised.length, embeddingId ?? null, toJson(meta ?? {}), nowIso(), expiresAt);
  l1.set(key, value, ttlSeconds, serialised.length);
}

export function cacheDelete(key: string): void {
  l1.delete(key);
  db().prepare('DELETE FROM cache_entries WHERE key = ?').run(key);
}

export function cacheInvalidateNamespace(namespace: string): number {
  l1.clear();
  return db().prepare('DELETE FROM cache_entries WHERE namespace = ?').run(namespace).changes;
}

export function purgeExpiredCache(): number {
  return db().prepare('DELETE FROM cache_entries WHERE expires_at <= ?').run(nowIso()).changes;
}

interface SemanticHit<T> {
  readonly value: T;
  readonly similarity: number;
  readonly key: string;
}

/**
 * L3: finds a cached entry in the same namespace whose semantic text is close
 * enough to the query. This is what collapses "best market gaps today" and
 * "top market gaps for today" into a single research run.
 */
async function semanticLookup<T>(namespace: string, text: string, threshold: number): Promise<SemanticHit<T> | null> {
  const rows = db()
    .prepare<[string, string], CacheRow>(
      'SELECT * FROM cache_entries WHERE namespace = ? AND expires_at > ? AND embedding_id IS NOT NULL',
    )
    .all(namespace, nowIso());
  if (rows.length === 0) return null;

  const query = await embedText(text, 'cache');
  let best: SemanticHit<T> | null = null;
  for (const row of rows) {
    if (!row.embedding_id) continue;
    const stored = getEmbedding(row.embedding_id);
    if (!stored || stored.dims !== query.length) continue;
    const score = cosineSimilarity(query, stored.vector, undefined, stored.norm);
    if (score >= threshold && (!best || score > best.similarity)) {
      best = { value: decode<T>(row), similarity: score, key: row.key };
    }
  }
  return best;
}

/**
 * The single entry point every expensive operation goes through.
 */
export async function cached<T>(
  keyParts: unknown,
  options: CacheOptions,
  compute: () => Promise<T>,
): Promise<CacheResult<T>> {
  const cfg = config();
  const ttl = options.ttlSeconds ?? cfg.CACHE_DEFAULT_TTL_S;
  const key = cacheKey(options.namespace, keyParts);
  const saved = options.estimatedCostUsd ?? 0;

  if (!options.bypass) {
    const exact = cacheGet<T>(key);
    if (exact !== undefined) {
      counter('cache.hit', { namespace: options.namespace, level: 'exact' });
      emitEvent({
        type: 'cache.hit',
        scope: `cache.${options.namespace}`,
        message: `exact cache hit (${options.namespace})`,
        data: { namespace: options.namespace, level: 'exact', savedUsd: saved },
      });
      return { value: exact, source: 'l1', savedUsd: saved };
    }

    const pending = inFlight.get(key);
    if (pending) {
      counter('cache.hit', { namespace: options.namespace, level: 'coalesced' });
      return { value: (await pending) as T, source: 'coalesced', savedUsd: saved };
    }

    if (cfg.CACHE_SEMANTIC_ENABLED && options.semanticText) {
      try {
        const threshold = options.semanticThreshold ?? cfg.CACHE_SEMANTIC_THRESHOLD;
        const hit = await semanticLookup<T>(options.namespace, options.semanticText, threshold);
        if (hit) {
          counter('cache.hit', { namespace: options.namespace, level: 'semantic' });
          emitEvent({
            type: 'cache.hit',
            scope: `cache.${options.namespace}`,
            message: `semantic cache hit (${hit.similarity.toFixed(3)})`,
            data: { namespace: options.namespace, level: 'semantic', similarity: hit.similarity, savedUsd: saved },
          });
          return { value: hit.value, source: 'semantic', similarity: hit.similarity, savedUsd: saved };
        }
      } catch (error) {
        log.warn('semantic cache lookup failed; continuing with a fresh computation', { error, namespace: options.namespace });
      }
    }
  }

  const promise = (async (): Promise<T> => {
    const value = await compute();
    let embeddingId: string | undefined;
    if (cfg.CACHE_SEMANTIC_ENABLED && options.semanticText) {
      try {
        const vector = await embedText(options.semanticText, 'cache');
        embeddingId = attachEmbedding('cache', key, options.semanticText, vector, getEmbeddingProvider().name);
      } catch (error) {
        log.warn('failed to attach semantic index to cache entry', { error, namespace: options.namespace });
      }
    }
    cacheSet(key, options.namespace, value, ttl, embeddingId, { semanticText: options.semanticText?.slice(0, 240) });
    return value;
  })();

  inFlight.set(key, promise);
  try {
    const value = await promise;
    counter('cache.miss', { namespace: options.namespace });
    return { value, source: 'computed', savedUsd: 0 };
  } finally {
    inFlight.delete(key);
  }
}

export interface CacheStats {
  readonly l1Entries: number;
  readonly l1Bytes: number;
  readonly l2Entries: number;
  readonly l2Bytes: number;
  readonly totalHits: number;
  readonly namespaces: Array<{ namespace: string; entries: number; hits: number; bytes: number }>;
}

export function cacheStats(): CacheStats {
  const rows = db()
    .prepare<[], { namespace: string; entries: number; hits: number; bytes: number }>(
      `SELECT namespace, COUNT(*) AS entries, COALESCE(SUM(hits),0) AS hits, COALESCE(SUM(size_bytes),0) AS bytes
       FROM cache_entries GROUP BY namespace ORDER BY entries DESC`,
    )
    .all();
  return {
    l1Entries: l1.size,
    l1Bytes: l1.approximateBytes,
    l2Entries: rows.reduce((n, r) => n + r.entries, 0),
    l2Bytes: rows.reduce((n, r) => n + r.bytes, 0),
    totalHits: rows.reduce((n, r) => n + r.hits, 0),
    namespaces: rows,
  };
}

export function clearMemoryCache(): void {
  l1.clear();
  inFlight.clear();
}

export function newCacheEntryId(): string {
  return newId('cch');
}
