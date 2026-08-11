import { db, newId, nowIso } from '@/lib/db/client';
import { getEmbeddingProvider } from '@/lib/providers/registry';
import { textHash } from '@/lib/providers/embedding/local';
import { recordUsage } from '@/lib/ai/usage';
import { tokenCost } from '@/lib/providers/pricing';
import { track } from '@/lib/observability/metrics';

/**
 * Embedding store.
 *
 * Vectors are persisted as little-endian Float32 blobs alongside their L2 norm.
 * Identical text under the same model is embedded exactly once (L7 embedding
 * cache), which is the single largest saving in the research pipeline because
 * the same headlines recur across sources every day.
 */

export interface StoredEmbedding {
  readonly id: string;
  readonly ownerType: string;
  readonly ownerId: string;
  readonly model: string;
  readonly dims: number;
  readonly vector: Float32Array;
  readonly norm: number;
}

interface EmbeddingRow {
  id: string;
  owner_type: string;
  owner_id: string;
  model: string;
  dims: number;
  vector: Buffer;
  norm: number;
}

function toBuffer(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

function toVector(buffer: Buffer, dims: number): Float32Array {
  const out = new Float32Array(dims);
  for (let i = 0; i < dims; i += 1) out[i] = buffer.readFloatLE(i * 4);
  return out;
}

function l2norm(vector: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += (vector[i] as number) ** 2;
  return Math.sqrt(sum);
}

export function cosineSimilarity(a: Float32Array, b: Float32Array, normA?: number, normB?: number): number {
  const len = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < len; i += 1) dot += (a[i] as number) * (b[i] as number);
  const na = normA ?? l2norm(a);
  const nb = normB ?? l2norm(b);
  if (na === 0 || nb === 0) return 0;
  return dot / (na * nb);
}

/** Embeds `texts`, reusing any vector already stored for the same text+model. */
export async function embedTexts(
  texts: readonly string[],
  context: { ownerType: string; projectId?: string; factoryRunId?: string } = { ownerType: 'adhoc' },
): Promise<Float32Array[]> {
  if (texts.length === 0) return [];
  const provider = getEmbeddingProvider();
  const database = db();
  const model = provider.name === 'openai' ? 'openai' : provider.name;

  const hashes = texts.map((t) => textHash(t));
  const existing = new Map<string, Float32Array>();
  const select = database.prepare<[string, string], EmbeddingRow>(
    'SELECT * FROM embeddings WHERE text_hash = ? AND model = ? LIMIT 1',
  );
  for (const hash of new Set(hashes)) {
    const row = select.get(hash, model);
    if (row) existing.set(hash, toVector(row.vector, row.dims));
  }

  const missingIndexes = hashes
    .map((h, i) => (existing.has(h) ? -1 : i))
    .filter((i) => i >= 0);
  const uniqueMissing = new Map<string, number>();
  for (const index of missingIndexes) {
    const hash = hashes[index] as string;
    if (!uniqueMissing.has(hash)) uniqueMissing.set(hash, index);
  }

  track('cache.embedding', existing.size, { outcome: 'hit' });
  track('cache.embedding', uniqueMissing.size, { outcome: 'miss' });

  if (uniqueMissing.size > 0) {
    const toEmbed = [...uniqueMissing.values()].map((i) => texts[i] as string);
    const started = Date.now();
    const result = await provider.embed(toEmbed);
    const cost = tokenCost(provider.name === 'openai' ? 'text-embedding-3-small' : provider.name, result.tokens, 0);

    const insert = database.prepare(
      `INSERT INTO embeddings (id, owner_type, owner_id, model, dims, vector, norm, text_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const tx = database.transaction(() => {
      let cursor = 0;
      for (const [hash] of uniqueMissing) {
        const vector = result.vectors[cursor] as Float32Array;
        cursor += 1;
        insert.run(newId('emb'), context.ownerType, '', model, result.dims, toBuffer(vector), l2norm(vector), hash, nowIso());
        existing.set(hash, vector);
      }
    });
    tx();

    recordUsage({
      provider: provider.name,
      kind: 'embedding',
      model: result.model,
      operation: 'embed',
      tokensIn: result.tokens,
      units: toEmbed.length,
      costUsd: cost.costUsd,
      latencyMs: Date.now() - started,
      projectId: context.projectId,
      factoryRunId: context.factoryRunId,
    });
  }

  return hashes.map((h) => existing.get(h) as Float32Array);
}

export async function embedText(text: string, ownerType = 'adhoc'): Promise<Float32Array> {
  const [vector] = await embedTexts([text], { ownerType });
  return vector as Float32Array;
}

/** Persists a vector attached to a domain object so it can be searched later. */
export function attachEmbedding(ownerType: string, ownerId: string, text: string, vector: Float32Array, model: string): string {
  const id = newId('emb');
  db()
    .prepare(
      `INSERT INTO embeddings (id, owner_type, owner_id, model, dims, vector, norm, text_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(id, ownerType, ownerId, model, vector.length, toBuffer(vector), l2norm(vector), textHash(text), nowIso());
  return id;
}

export interface SimilarityHit {
  readonly id: string;
  readonly ownerId: string;
  readonly score: number;
}

/**
 * Brute-force cosine search over one owner type. SQLite holds the vectors and
 * the candidate sets here are in the thousands, where a linear scan is faster
 * than an approximate index and keeps recall at 100%.
 */
export function searchSimilar(
  ownerType: string,
  query: Float32Array,
  options: { limit?: number; threshold?: number; ownerIds?: readonly string[] } = {},
): SimilarityHit[] {
  const limit = options.limit ?? 10;
  const threshold = options.threshold ?? 0;
  const rows = db()
    .prepare<[string], EmbeddingRow>('SELECT * FROM embeddings WHERE owner_type = ?')
    .all(ownerType);
  const queryNorm = l2norm(query);
  const allowed = options.ownerIds ? new Set(options.ownerIds) : null;

  const hits: SimilarityHit[] = [];
  for (const row of rows) {
    if (allowed && !allowed.has(row.owner_id)) continue;
    const vector = toVector(row.vector, row.dims);
    const score = cosineSimilarity(query, vector, queryNorm, row.norm);
    if (score >= threshold) hits.push({ id: row.id, ownerId: row.owner_id, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, limit);
}

export function getEmbedding(id: string): StoredEmbedding | null {
  const row = db().prepare<[string], EmbeddingRow>('SELECT * FROM embeddings WHERE id = ?').get(id);
  if (!row) return null;
  return {
    id: row.id,
    ownerType: row.owner_type,
    ownerId: row.owner_id,
    model: row.model,
    dims: row.dims,
    vector: toVector(row.vector, row.dims),
    norm: row.norm,
  };
}

export function deleteEmbeddingsFor(ownerType: string, ownerId: string): void {
  db().prepare('DELETE FROM embeddings WHERE owner_type = ? AND owner_id = ?').run(ownerType, ownerId);
}
