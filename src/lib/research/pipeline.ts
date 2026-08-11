import { config } from '@/lib/config/env';
import { getSearchProvider } from '@/lib/providers/registry';
import { unitCost } from '@/lib/providers/pricing';
import { cached } from '@/lib/cache';
import { recordUsage } from '@/lib/ai/usage';
import { mapPool } from '@/lib/util/pool';
import { createLogger } from '@/lib/observability/logger';
import { emitEvent } from '@/lib/observability/events';
import { counter } from '@/lib/observability/metrics';
import { fetchDocument, FetchRefusedError } from './fetcher';
import { extractDocument, extractJsonDocument } from './extract';
import { analyze } from './analyze';
import { profileForHost, type QueryPlanEntry } from './sources';
import { canonicalise, indexDocuments, saveDocument, type ResearchDocument } from './store';
import type { SearchResponse } from '@/lib/providers/types';

const log = createLogger('research.pipeline');

export interface ResearchRequest {
  readonly queries: readonly QueryPlanEntry[];
  readonly maxDocuments?: number;
  readonly factoryRunId?: string;
  readonly signal?: AbortSignal;
  readonly resultsPerQuery?: number;
  readonly minWordCount?: number;
}

export interface ExecutedQuery {
  readonly query: string;
  readonly intent: string;
  readonly provider: string;
  readonly resultCount: number;
  readonly cacheSource: string;
}

export interface FetchFailure {
  readonly url: string;
  readonly code: string;
  readonly reason: string;
}

export interface ResearchOutcome {
  readonly documents: readonly ResearchDocument[];
  readonly queries: readonly ExecutedQuery[];
  readonly candidateUrls: number;
  readonly fetched: number;
  readonly duplicates: number;
  readonly failures: readonly FetchFailure[];
  readonly searchProvider: string;
}

/** Executes one search query through the cache. */
async function runQuery(entry: QueryPlanEntry, count: number, signal?: AbortSignal, factoryRunId?: string): Promise<{ response: SearchResponse; cacheSource: string }> {
  const cfg = config();
  const provider = getSearchProvider();
  const status = provider.status();
  if (!status.configured) {
    throw new Error(
      `Web research is unavailable: ${status.detail} Set ${status.requires.join(' or ')} to enable market scanning.`,
    );
  }

  const result = await cached<SearchResponse>(
    { provider: provider.name, query: entry.query, site: entry.site ?? '', freshness: entry.freshness, count },
    {
      namespace: 'search',
      ttlSeconds: cfg.CACHE_SEARCH_TTL_S,
      semanticText: `${entry.intent}:${entry.query}`,
      estimatedCostUsd: unitCost(`search:${provider.name}`, 1).costUsd,
    },
    async () => {
      const response = await provider.search(
        entry.query,
        { count, freshness: entry.freshness, site: entry.site },
        signal,
      );
      recordUsage({
        provider: provider.name,
        kind: 'search',
        operation: 'web_search',
        units: response.units,
        costUsd: unitCost(`search:${provider.name}`, response.units).costUsd,
        latencyMs: response.latencyMs,
        factoryRunId,
      });
      return response;
    },
  );

  if (result.source !== 'computed') {
    recordUsage({
      provider: provider.name,
      kind: 'search',
      operation: 'web_search',
      cacheHit: result.source === 'semantic' ? 'semantic' : 'exact',
      savedUsd: result.savedUsd,
      factoryRunId,
    });
  }
  return { response: result.value, cacheSource: result.source };
}

/**
 * Full research pass: search → candidate selection → polite fetch → extraction →
 * lexical analysis → dedup → persistence → semantic indexing.
 */
export async function runResearch(requestInput: ResearchRequest): Promise<ResearchOutcome> {
  const cfg = config();
  const maxDocuments = Math.min(requestInput.maxDocuments ?? cfg.RESEARCH_MAX_DOCS_PER_RUN, 500);
  const resultsPerQuery = requestInput.resultsPerQuery ?? 10;
  const minWordCount = requestInput.minWordCount ?? 80;
  const provider = getSearchProvider();

  const executed: ExecutedQuery[] = [];
  const candidates = new Map<string, { url: string; intent: string; rank: number; title: string }>();

  for (const entry of requestInput.queries) {
    if (requestInput.signal?.aborted) break;
    try {
      const { response, cacheSource } = await runQuery(entry, resultsPerQuery, requestInput.signal, requestInput.factoryRunId);
      executed.push({
        query: entry.query,
        intent: entry.intent,
        provider: response.provider,
        resultCount: response.results.length,
        cacheSource,
      });
      emitEvent({
        type: 'research.query',
        scope: 'research',
        runId: requestInput.factoryRunId,
        message: `search: ${entry.query}`,
        data: { intent: entry.intent, results: response.results.length, cache: cacheSource },
      });
      for (const result of response.results) {
        const canonical = canonicalise(result.url);
        if (!candidates.has(canonical)) {
          candidates.set(canonical, { url: result.url, intent: entry.intent, rank: result.rank, title: result.title });
        }
      }
    } catch (error) {
      log.warn('search query failed', { query: entry.query, error: (error as Error).message });
      if (executed.length === 0 && requestInput.queries.indexOf(entry) === requestInput.queries.length - 1) throw error;
    }
  }

  if (executed.length === 0 && requestInput.queries.length > 0) {
    throw new Error(
      `No search query succeeded. Check the ${provider.name} provider configuration and connectivity; ` +
        'the platform will not invent market data.',
    );
  }

  // Prefer higher-trust sources, then better search rank.
  const ordered = [...candidates.values()]
    .map((c) => {
      let host = '';
      try {
        host = new URL(c.url).host;
      } catch {
        host = '';
      }
      return { ...c, profile: profileForHost(host) };
    })
    .sort((a, b) => b.profile.trust - a.profile.trust || a.rank - b.rank)
    .slice(0, maxDocuments);

  const failures: FetchFailure[] = [];
  const saved: ResearchDocument[] = [];
  let duplicates = 0;

  const results = await mapPool(ordered, cfg.RESEARCH_MAX_CONCURRENCY, async (candidate) => {
    if (requestInput.signal?.aborted) return null;
    const fetchedDoc = await fetchDocument(candidate.url, {
      signal: requestInput.signal,
      factoryRunId: requestInput.factoryRunId,
    });

    const isJson = /json/i.test(fetchedDoc.contentType);
    const text = fetchedDoc.body.toString('utf8');
    const extracted = isJson
      ? extractJsonDocument(safeParseJson(text), fetchedDoc.finalUrl)
      : extractDocument(text, fetchedDoc.finalUrl);
    if (extracted.wordCount < minWordCount) {
      throw new FetchRefusedError(candidate.url, `extracted body too short (${extracted.wordCount} words)`, 'EXTRACTION_THIN');
    }

    const analysis = analyze(`${extracted.title}\n${extracted.content}`);
    const result = saveDocument({
      url: candidate.url,
      finalUrl: fetchedDoc.finalUrl,
      httpStatus: fetchedDoc.status,
      fetchedAt: fetchedDoc.fetchedAt,
      contentHash: fetchedDoc.contentHash,
      extracted,
      analysis,
      sourceTrust: candidate.profile.trust,
      category: candidate.profile.kind,
      factoryRunId: requestInput.factoryRunId,
    });

    emitEvent({
      type: 'research.document',
      scope: 'research',
      runId: requestInput.factoryRunId,
      message: `${result.outcome === 'inserted' ? 'stored' : 'duplicate'}: ${extracted.title.slice(0, 90) || candidate.url}`,
      data: {
        url: result.document.url,
        source: candidate.profile.label,
        words: extracted.wordCount,
        sentiment: Number(analysis.sentiment.toFixed(3)),
        outcome: result.outcome,
      },
    });
    return result;
  });

  for (let i = 0; i < results.length; i += 1) {
    const outcome = results[i];
    if (!outcome) continue;
    if (outcome.status === 'fulfilled') {
      if (!outcome.value) continue;
      if (outcome.value.outcome === 'inserted') saved.push(outcome.value.document);
      else duplicates += 1;
    } else {
      const error = outcome.reason as FetchRefusedError;
      const candidate = ordered[i];
      failures.push({
        url: candidate?.url ?? 'unknown',
        code: error?.code ?? 'FETCH_FAILED',
        reason: error?.message ?? String(outcome.reason),
      });
    }
  }

  counter('research.documents', { outcome: 'stored' }, saved.length);
  counter('research.documents', { outcome: 'duplicate' }, duplicates);
  counter('research.documents', { outcome: 'failed' }, failures.length);

  await indexDocuments(saved, requestInput.factoryRunId);

  return {
    documents: saved,
    queries: executed,
    candidateUrls: candidates.size,
    fetched: saved.length + duplicates,
    duplicates,
    failures,
    searchProvider: provider.name,
  };
}

function safeParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text.slice(0, 20_000) };
  }
}
