import crypto from 'node:crypto';
import { db, fromJson, newId, nowIso, toJson } from '@/lib/db/client';
import { attachEmbedding, embedTexts, searchSimilar } from '@/lib/knowledge/embeddings';
import { getEmbeddingProvider } from '@/lib/providers/registry';
import { upsertSource } from './sources';
import type { Analysis } from './analyze';
import type { ExtractedDocument } from './extract';

/**
 * Research document store with full provenance.
 *
 * Every stored document keeps the URL it came from, when it was retrieved, when
 * it was parsed, the hash of the exact bytes that were parsed, and a confidence
 * derived from the source class and extraction quality. Nothing downstream is
 * allowed to cite a document that is not in this table.
 */

export interface ResearchDocumentRow {
  readonly id: string;
  readonly source_id: string | null;
  readonly factory_run_id: string | null;
  readonly url: string;
  readonly canonical_url: string;
  readonly url_hash: string;
  readonly content_hash: string;
  readonly title: string;
  readonly excerpt: string;
  readonly content: string;
  readonly language: string;
  readonly category: string;
  readonly keywords: string;
  readonly entities: string;
  readonly sentiment: number;
  readonly word_count: number;
  readonly http_status: number;
  readonly confidence: number;
  readonly published_at: string | null;
  readonly fetched_at: string;
  readonly extraction_at: string;
  readonly created_at: string;
}

export interface ResearchDocument {
  readonly id: string;
  readonly url: string;
  readonly canonicalUrl: string;
  readonly title: string;
  readonly excerpt: string;
  readonly content: string;
  readonly language: string;
  readonly category: string;
  readonly keywords: string[];
  readonly entities: string[];
  readonly sentiment: number;
  readonly wordCount: number;
  readonly confidence: number;
  readonly publishedAt: string | null;
  readonly fetchedAt: string;
  readonly contentHash: string;
  readonly sourceId: string | null;
}

export function toDocument(row: ResearchDocumentRow): ResearchDocument {
  return {
    id: row.id,
    url: row.url,
    canonicalUrl: row.canonical_url,
    title: row.title,
    excerpt: row.excerpt,
    content: row.content,
    language: row.language,
    category: row.category,
    keywords: fromJson<string[]>(row.keywords, []),
    entities: fromJson<string[]>(row.entities, []),
    sentiment: row.sentiment,
    wordCount: row.word_count,
    confidence: row.confidence,
    publishedAt: row.published_at,
    fetchedAt: row.fetched_at,
    contentHash: row.content_hash,
    sourceId: row.source_id,
  };
}

function hash(value: string): string {
  return crypto.createHash('sha256').update(value).digest('hex');
}

/** Canonical form used for identity: drops tracking params and fragments. */
export function canonicalise(rawUrl: string, declaredCanonical?: string | null): string {
  const base = (() => {
    try {
      return new URL(declaredCanonical ?? rawUrl, rawUrl);
    } catch {
      return new URL(rawUrl);
    }
  })();
  base.hash = '';
  const drop = /^(utm_|fbclid|gclid|mc_|ref|ref_src|igshid|si|spm|_ga)/i;
  for (const key of [...base.searchParams.keys()]) {
    if (drop.test(key)) base.searchParams.delete(key);
  }
  base.searchParams.sort();
  if (base.pathname.length > 1 && base.pathname.endsWith('/')) base.pathname = base.pathname.slice(0, -1);
  base.host = base.host.toLowerCase().replace(/^www\./, '');
  return base.href;
}

export interface SaveDocumentInput {
  readonly url: string;
  readonly finalUrl: string;
  readonly httpStatus: number;
  readonly fetchedAt: string;
  readonly contentHash: string;
  readonly extracted: ExtractedDocument;
  readonly analysis: Analysis;
  readonly sourceTrust: number;
  readonly category: string;
  readonly factoryRunId?: string;
}

export type SaveOutcome = 'inserted' | 'duplicate_url' | 'duplicate_content';

export interface SaveResult {
  readonly outcome: SaveOutcome;
  readonly document: ResearchDocument;
}

/**
 * Confidence combines source trust with extraction quality. A three-paragraph
 * page from a review marketplace is worth more than a 40-word stub from an
 * unknown host, and downstream scoring uses this directly.
 */
export function documentConfidence(sourceTrust: number, extracted: ExtractedDocument): number {
  const lengthFactor = Math.min(1, extracted.wordCount / 400);
  const titleFactor = extracted.title.length > 8 ? 1 : 0.7;
  const dateFactor = extracted.publishedAt ? 1 : 0.9;
  return Math.max(0.05, Math.min(1, sourceTrust * (0.45 + 0.55 * lengthFactor) * titleFactor * dateFactor));
}

export function saveDocument(input: SaveDocumentInput): SaveResult {
  const database = db();
  const canonical = canonicalise(input.finalUrl, input.extracted.canonicalUrl);
  const urlHash = hash(canonical);

  const existingByUrl = database
    .prepare<[string], ResearchDocumentRow>('SELECT * FROM research_documents WHERE url_hash = ?')
    .get(urlHash);
  if (existingByUrl) {
    if (existingByUrl.content_hash === input.contentHash) {
      return { outcome: 'duplicate_url', document: toDocument(existingByUrl) };
    }
    // Same address, changed content: refresh in place and keep one identity.
    database
      .prepare(
        `UPDATE research_documents SET content_hash = ?, title = ?, excerpt = ?, content = ?, language = ?,
           keywords = ?, entities = ?, sentiment = ?, word_count = ?, http_status = ?, confidence = ?,
           published_at = ?, fetched_at = ?, extraction_at = ? WHERE id = ?`,
      )
      .run(
        input.contentHash,
        input.extracted.title,
        input.extracted.excerpt,
        input.extracted.content,
        input.analysis.language,
        toJson(input.analysis.keywords),
        toJson(input.analysis.entities),
        input.analysis.sentiment,
        input.extracted.wordCount,
        input.httpStatus,
        documentConfidence(input.sourceTrust, input.extracted),
        input.extracted.publishedAt,
        input.fetchedAt,
        nowIso(),
        existingByUrl.id,
      );
    const refreshed = database
      .prepare<[string], ResearchDocumentRow>('SELECT * FROM research_documents WHERE id = ?')
      .get(existingByUrl.id) as ResearchDocumentRow;
    return { outcome: 'inserted', document: toDocument(refreshed) };
  }

  const existingByContent = database
    .prepare<[string], ResearchDocumentRow>('SELECT * FROM research_documents WHERE content_hash = ? LIMIT 1')
    .get(input.contentHash);
  if (existingByContent) {
    return { outcome: 'duplicate_content', document: toDocument(existingByContent) };
  }

  const source = upsertSource(input.finalUrl);
  const row: ResearchDocumentRow = {
    id: newId('doc'),
    source_id: source.id,
    factory_run_id: input.factoryRunId ?? null,
    url: input.url,
    canonical_url: canonical,
    url_hash: urlHash,
    content_hash: input.contentHash,
    title: input.extracted.title,
    excerpt: input.extracted.excerpt,
    content: input.extracted.content,
    language: input.analysis.language,
    category: input.category,
    keywords: toJson(input.analysis.keywords),
    entities: toJson(input.analysis.entities),
    sentiment: input.analysis.sentiment,
    word_count: input.extracted.wordCount,
    http_status: input.httpStatus,
    confidence: documentConfidence(input.sourceTrust, input.extracted),
    published_at: input.extracted.publishedAt,
    fetched_at: input.fetchedAt,
    extraction_at: nowIso(),
    created_at: nowIso(),
  };

  database
    .prepare(
      `INSERT INTO research_documents
        (id, source_id, factory_run_id, url, canonical_url, url_hash, content_hash, title, excerpt, content,
         language, category, keywords, entities, sentiment, word_count, http_status, confidence,
         published_at, fetched_at, extraction_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id, row.source_id, row.factory_run_id, row.url, row.canonical_url, row.url_hash, row.content_hash,
      row.title, row.excerpt, row.content, row.language, row.category, row.keywords, row.entities,
      row.sentiment, row.word_count, row.http_status, row.confidence, row.published_at, row.fetched_at,
      row.extraction_at, row.created_at,
    );

  return { outcome: 'inserted', document: toDocument(row) };
}

/** Embeds and indexes documents so near-duplicates and clusters can be found. */
export async function indexDocuments(documents: readonly ResearchDocument[], factoryRunId?: string): Promise<void> {
  if (documents.length === 0) return;
  const texts = documents.map((d) => `${d.title}\n${d.excerpt}\n${d.content.slice(0, 2000)}`);
  const vectors = await embedTexts(texts, { ownerType: 'document', factoryRunId });
  const model = getEmbeddingProvider().name;
  const database = db();
  const tx = database.transaction(() => {
    documents.forEach((doc, i) => {
      const existing = database
        .prepare<[string, string], { id: string }>('SELECT id FROM embeddings WHERE owner_type = ? AND owner_id = ?')
        .get('document', doc.id);
      if (existing) return;
      attachEmbedding('document', doc.id, texts[i] as string, vectors[i] as Float32Array, model);
    });
  });
  tx();
}

/** Near-duplicate detection over the embedding index (semantic dedup). */
export async function findNearDuplicates(document: ResearchDocument, threshold = 0.97): Promise<string[]> {
  const [vector] = await embedTexts([`${document.title}\n${document.excerpt}`], { ownerType: 'document' });
  if (!vector) return [];
  return searchSimilar('document', vector, { limit: 5, threshold })
    .filter((hit) => hit.ownerId !== document.id)
    .map((hit) => hit.ownerId);
}

export function getDocument(id: string): ResearchDocument | null {
  const row = db().prepare<[string], ResearchDocumentRow>('SELECT * FROM research_documents WHERE id = ?').get(id);
  return row ? toDocument(row) : null;
}

export function listDocuments(options: { limit?: number; factoryRunId?: string; since?: string } = {}): ResearchDocument[] {
  const limit = Math.min(options.limit ?? 100, 1000);
  if (options.factoryRunId) {
    return db()
      .prepare<[string, number], ResearchDocumentRow>(
        'SELECT * FROM research_documents WHERE factory_run_id = ? ORDER BY fetched_at DESC LIMIT ?',
      )
      .all(options.factoryRunId, limit)
      .map(toDocument);
  }
  if (options.since) {
    return db()
      .prepare<[string, number], ResearchDocumentRow>(
        'SELECT * FROM research_documents WHERE fetched_at >= ? ORDER BY fetched_at DESC LIMIT ?',
      )
      .all(options.since, limit)
      .map(toDocument);
  }
  return db()
    .prepare<[number], ResearchDocumentRow>('SELECT * FROM research_documents ORDER BY fetched_at DESC LIMIT ?')
    .all(limit)
    .map(toDocument);
}

/** Full-text search across stored research, used by the chat and gap agents. */
export function searchDocuments(query: string, limit = 20): ResearchDocument[] {
  const sanitised = query
    .replace(/["']/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 2)
    .slice(0, 12)
    .map((t) => `"${t}"`)
    .join(' OR ');
  if (!sanitised) return [];
  try {
    return db()
      .prepare<[string, number], ResearchDocumentRow>(
        `SELECT d.* FROM research_documents_fts f
         JOIN research_documents d ON d.rowid = f.rowid
         WHERE research_documents_fts MATCH ?
         ORDER BY rank LIMIT ?`,
      )
      .all(sanitised, Math.min(limit, 100))
      .map(toDocument);
  } catch {
    return [];
  }
}

export function documentCount(): number {
  return db().prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM research_documents').get()?.n ?? 0;
}
