import crypto from 'node:crypto';
import { config } from '@/lib/config/env';
import { db, nowIso } from '@/lib/db/client';
import { assertSafeUrl, BlockedUrlError } from '@/lib/security/ssrf';
import { isAllowed, robotsFor } from './robots';
import { counter, observe } from '@/lib/observability/metrics';
import { recordUsage } from '@/lib/ai/usage';

/**
 * Polite, safe document fetcher.
 *
 * Guarantees, in order, for every request:
 *   1. SSRF guard on the resolved addresses (and on each redirect hop);
 *   2. robots.txt compliance, including Crawl-delay;
 *   3. per-host serialisation with a configurable minimum interval;
 *   4. conditional revalidation (ETag / Last-Modified) against the L4 HTTP cache;
 *   5. hard caps on response size, redirects and time.
 */

export class FetchRefusedError extends Error {
  readonly code: string;
  constructor(readonly url: string, reason: string, code = 'FETCH_REFUSED') {
    super(`Refused to fetch ${url}: ${reason}`);
    this.name = 'FetchRefusedError';
    this.code = code;
  }
}

export interface FetchedDocument {
  readonly url: string;
  readonly finalUrl: string;
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
  readonly contentHash: string;
  readonly fetchedAt: string;
  readonly fromCache: boolean;
  readonly bytes: number;
  readonly latencyMs: number;
}

// -------------------------------------------------------- per-host scheduler --

interface HostState {
  nextAvailableAt: number;
  chain: Promise<void>;
}

const hosts = new Map<string, HostState>();

function stateFor(host: string): HostState {
  let state = hosts.get(host);
  if (!state) {
    state = { nextAvailableAt: 0, chain: Promise.resolve() };
    hosts.set(host, state);
  }
  return state;
}

/** Serialises access to one host and enforces the minimum interval between hits. */
async function withHostSlot<T>(host: string, delayMs: number, fn: () => Promise<T>): Promise<T> {
  const state = stateFor(host);
  const run = state.chain.then(async () => {
    const wait = state.nextAvailableAt - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    state.nextAvailableAt = Date.now() + delayMs;
  });
  state.chain = run.catch(() => undefined);
  await run;
  return fn();
}

// ------------------------------------------------------------- HTTP L4 cache --

interface HttpCacheRow {
  url_hash: string;
  url: string;
  status: number;
  etag: string | null;
  last_modified: string | null;
  headers: string;
  body: Buffer;
  content_hash: string;
  fetched_at: string;
  expires_at: string;
}

function urlHash(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex');
}

function readHttpCache(url: string): HttpCacheRow | undefined {
  return db().prepare<[string], HttpCacheRow>('SELECT * FROM http_cache WHERE url_hash = ?').get(urlHash(url));
}

function writeHttpCache(entry: {
  url: string;
  status: number;
  etag: string | null;
  lastModified: string | null;
  headers: Record<string, string>;
  body: Buffer;
  contentHash: string;
  ttlSeconds: number;
}): void {
  db()
    .prepare(
      `INSERT INTO http_cache (url_hash, url, status, etag, last_modified, headers, body, content_hash, fetched_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(url_hash) DO UPDATE SET
         status = excluded.status, etag = excluded.etag, last_modified = excluded.last_modified,
         headers = excluded.headers, body = excluded.body, content_hash = excluded.content_hash,
         fetched_at = excluded.fetched_at, expires_at = excluded.expires_at`,
    )
    .run(
      urlHash(entry.url),
      entry.url,
      entry.status,
      entry.etag,
      entry.lastModified,
      JSON.stringify(entry.headers),
      entry.body,
      entry.contentHash,
      nowIso(),
      new Date(Date.now() + entry.ttlSeconds * 1000).toISOString(),
    );
}

export function purgeExpiredHttpCache(): number {
  return db().prepare('DELETE FROM http_cache WHERE expires_at <= ?').run(nowIso()).changes;
}

// ------------------------------------------------------------------- fetch --

const TEXTUAL = /^(?:text\/|application\/(?:xhtml\+xml|xml|json|rss\+xml|atom\+xml|ld\+json))/i;
const MAX_REDIRECTS = 5;

export interface FetchOptions {
  readonly ignoreCache?: boolean;
  readonly ttlSeconds?: number;
  readonly acceptNonTextual?: boolean;
  readonly signal?: AbortSignal;
  readonly factoryRunId?: string;
}

export async function fetchDocument(rawUrl: string, options: FetchOptions = {}): Promise<FetchedDocument> {
  const cfg = config();
  const started = Date.now();
  const { url } = await assertSafeUrl(rawUrl);

  if (cfg.RESEARCH_RESPECT_ROBOTS) {
    const policy = await robotsFor(url);
    if (!isAllowed(policy, url)) {
      counter('research.fetch', { outcome: 'robots_disallowed' });
      throw new FetchRefusedError(url.href, 'robots.txt disallows this path for our user-agent', 'ROBOTS_DISALLOWED');
    }
  }

  const cachedEntry = options.ignoreCache ? undefined : readHttpCache(url.href);
  if (cachedEntry && new Date(cachedEntry.expires_at).getTime() > Date.now()) {
    counter('research.fetch', { outcome: 'cache_fresh' });
    recordUsage({ provider: 'web', kind: 'fetch', operation: 'document', cacheHit: 'exact', savedUsd: 0, factoryRunId: options.factoryRunId });
    return {
      url: url.href,
      finalUrl: cachedEntry.url,
      status: cachedEntry.status,
      contentType: (JSON.parse(cachedEntry.headers) as Record<string, string>)['content-type'] ?? 'text/html',
      body: cachedEntry.body,
      contentHash: cachedEntry.content_hash,
      fetchedAt: cachedEntry.fetched_at,
      fromCache: true,
      bytes: cachedEntry.body.length,
      latencyMs: Date.now() - started,
    };
  }

  const crawlDelay = cfg.RESEARCH_RESPECT_ROBOTS ? (await robotsFor(url)).crawlDelayMs : null;
  const delay = Math.max(cfg.RESEARCH_PER_HOST_DELAY_MS, crawlDelay ?? 0);

  return withHostSlot(url.host, delay, async () => {
    let current = url;
    let redirects = 0;

    for (;;) {
      const headers: Record<string, string> = {
        'user-agent': cfg.RESEARCH_USER_AGENT,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.5',
        'accept-language': 'en;q=0.9,*;q=0.5',
      };
      if (cachedEntry?.etag) headers['if-none-match'] = cachedEntry.etag;
      if (cachedEntry?.last_modified) headers['if-modified-since'] = cachedEntry.last_modified;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('fetch timeout')), cfg.RESEARCH_FETCH_TIMEOUT_MS);
      const onAbort = (): void => controller.abort(options.signal?.reason);
      options.signal?.addEventListener('abort', onAbort, { once: true });

      let response: Response;
      try {
        response = await fetch(current.href, { headers, redirect: 'manual', signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
        counter('research.fetch', { outcome: 'transport_error' });
        throw new FetchRefusedError(current.href, (error as Error).message, 'FETCH_TRANSPORT');
      }
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location');
        if (!location) throw new FetchRefusedError(current.href, 'redirect without a Location header', 'FETCH_BAD_REDIRECT');
        redirects += 1;
        if (redirects > MAX_REDIRECTS) throw new FetchRefusedError(url.href, 'too many redirects', 'FETCH_REDIRECT_LOOP');
        const next = new URL(location, current);
        // Every hop is re-validated: a redirect is a classic SSRF pivot.
        const guard = await assertSafeUrl(next).catch((error: BlockedUrlError) => {
          throw new FetchRefusedError(url.href, `redirect target rejected (${error.reason})`, 'FETCH_REDIRECT_BLOCKED');
        });
        if (cfg.RESEARCH_RESPECT_ROBOTS) {
          const policy = await robotsFor(guard.url);
          if (!isAllowed(policy, guard.url)) {
            throw new FetchRefusedError(guard.url.href, 'robots.txt disallows the redirect target', 'ROBOTS_DISALLOWED');
          }
        }
        current = guard.url;
        continue;
      }

      if (response.status === 304 && cachedEntry) {
        writeHttpCache({
          url: cachedEntry.url,
          status: cachedEntry.status,
          etag: cachedEntry.etag,
          lastModified: cachedEntry.last_modified,
          headers: JSON.parse(cachedEntry.headers) as Record<string, string>,
          body: cachedEntry.body,
          contentHash: cachedEntry.content_hash,
          ttlSeconds: options.ttlSeconds ?? cfg.CACHE_DOCUMENT_TTL_S,
        });
        counter('research.fetch', { outcome: 'revalidated' });
        recordUsage({ provider: 'web', kind: 'fetch', operation: 'document', cacheHit: 'exact', factoryRunId: options.factoryRunId });
        return {
          url: url.href,
          finalUrl: current.href,
          status: cachedEntry.status,
          contentType: 'text/html',
          body: cachedEntry.body,
          contentHash: cachedEntry.content_hash,
          fetchedAt: nowIso(),
          fromCache: true,
          bytes: cachedEntry.body.length,
          latencyMs: Date.now() - started,
        };
      }

      const contentType = response.headers.get('content-type') ?? 'application/octet-stream';
      if (!options.acceptNonTextual && !TEXTUAL.test(contentType)) {
        counter('research.fetch', { outcome: 'unsupported_type' });
        throw new FetchRefusedError(current.href, `unsupported content type "${contentType}"`, 'FETCH_UNSUPPORTED_TYPE');
      }
      const declaredLength = Number.parseInt(response.headers.get('content-length') ?? '', 10);
      if (Number.isFinite(declaredLength) && declaredLength > cfg.RESEARCH_MAX_BYTES) {
        throw new FetchRefusedError(current.href, `response too large (${declaredLength} bytes)`, 'FETCH_TOO_LARGE');
      }

      const body = await readCapped(response, cfg.RESEARCH_MAX_BYTES, current.href);
      if (!response.ok) {
        counter('research.fetch', { outcome: `http_${response.status}` });
        throw new FetchRefusedError(current.href, `HTTP ${response.status}`, `FETCH_HTTP_${response.status}`);
      }

      const contentHash = crypto.createHash('sha256').update(body).digest('hex');
      writeHttpCache({
        url: current.href,
        status: response.status,
        etag: response.headers.get('etag'),
        lastModified: response.headers.get('last-modified'),
        headers: { 'content-type': contentType },
        body,
        contentHash,
        ttlSeconds: options.ttlSeconds ?? cfg.CACHE_DOCUMENT_TTL_S,
      });

      counter('research.fetch', { outcome: 'fetched' });
      observe('research.fetch.latency', Date.now() - started, { host: current.host });
      recordUsage({
        provider: 'web',
        kind: 'fetch',
        operation: 'document',
        units: 1,
        latencyMs: Date.now() - started,
        factoryRunId: options.factoryRunId,
      });

      return {
        url: url.href,
        finalUrl: current.href,
        status: response.status,
        contentType,
        body,
        contentHash,
        fetchedAt: nowIso(),
        fromCache: false,
        bytes: body.length,
        latencyMs: Date.now() - started,
      };
    }
  });
}

async function readCapped(response: Response, maxBytes: number, url: string): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.from(await response.arrayBuffer());
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new FetchRefusedError(url, `response exceeded ${maxBytes} bytes`, 'FETCH_TOO_LARGE');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

export function resetHostScheduler(): void {
  hosts.clear();
}
