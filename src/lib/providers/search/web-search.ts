import { config } from '@/lib/config/env';
import { request } from '../http';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type ProviderStatus,
  type SearchOptions,
  type SearchResponse,
  type SearchResult,
  type WebSearchProvider,
} from '../types';

function buildQuery(query: string, options?: SearchOptions): string {
  return options?.site ? `${query} site:${options.site}` : query;
}

function clampCount(options?: SearchOptions): number {
  return Math.max(1, Math.min(options?.count ?? 10, 20));
}

// ------------------------------------------------------------------- Brave --

interface BraveBody {
  web?: { results?: Array<{ title?: string; url?: string; description?: string; page_age?: string; age?: string }> };
  error?: { detail?: string };
}

export class BraveSearchProvider implements WebSearchProvider {
  readonly name = 'brave';
  private static readonly REQUIRES = ['BRAVE_SEARCH_API_KEY'];

  status(): ProviderStatus {
    const configured = Boolean(config().BRAVE_SEARCH_API_KEY);
    return {
      name: this.name,
      kind: 'search',
      configured,
      detail: configured ? 'Brave Search API' : 'BRAVE_SEARCH_API_KEY is not set; web search is refused.',
      requires: BraveSearchProvider.REQUIRES,
    };
  }

  async search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResponse> {
    const key = config().BRAVE_SEARCH_API_KEY;
    if (!key) throw new ProviderNotConfiguredError(this.name, BraveSearchProvider.REQUIRES);
    const freshnessMap: Record<string, string> = { day: 'pd', week: 'pw', month: 'pm', year: 'py' };
    const params = new URLSearchParams({
      q: buildQuery(query, options),
      count: String(clampCount(options)),
      text_decorations: 'false',
      spellcheck: '1',
    });
    if (options?.freshness && options.freshness !== 'any') {
      const f = freshnessMap[options.freshness];
      if (f) params.set('freshness', f);
    }
    if (options?.country) params.set('country', options.country);
    if (options?.language) params.set('search_lang', options.language);

    const started = Date.now();
    const raw = await request({
      provider: this.name,
      url: `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
      headers: { accept: 'application/json', 'x-subscription-token': key },
      timeoutMs: 25_000,
      maxAttempts: 3,
      signal,
    });
    const parsed = JSON.parse(raw.body.toString('utf8')) as BraveBody;
    const items = parsed.web?.results ?? [];
    const results: SearchResult[] = items
      .filter((r): r is { title: string; url: string; description?: string; page_age?: string } => Boolean(r.url && r.title))
      .map((r, i) => ({
        title: r.title,
        url: r.url,
        snippet: (r.description ?? '').replace(/<[^>]+>/g, ''),
        publishedAt: r.page_age,
        rank: i + 1,
        engine: this.name,
      }));
    return { query, results, provider: this.name, latencyMs: Date.now() - started, units: 1 };
  }
}

// ------------------------------------------------------------------ Tavily --

interface TavilyBody {
  results?: Array<{ title?: string; url?: string; content?: string; published_date?: string }>;
  error?: string;
}

export class TavilySearchProvider implements WebSearchProvider {
  readonly name = 'tavily';
  private static readonly REQUIRES = ['TAVILY_API_KEY'];

  status(): ProviderStatus {
    const configured = Boolean(config().TAVILY_API_KEY);
    return {
      name: this.name,
      kind: 'search',
      configured,
      detail: configured ? 'Tavily Search API' : 'TAVILY_API_KEY is not set; web search is refused.',
      requires: TavilySearchProvider.REQUIRES,
    };
  }

  async search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResponse> {
    const key = config().TAVILY_API_KEY;
    if (!key) throw new ProviderNotConfiguredError(this.name, TavilySearchProvider.REQUIRES);
    const days: Record<string, number> = { day: 1, week: 7, month: 30, year: 365 };
    const body: Record<string, unknown> = {
      api_key: key,
      query: buildQuery(query, options),
      max_results: clampCount(options),
      search_depth: 'basic',
      include_answer: false,
      include_raw_content: false,
    };
    if (options?.freshness && options.freshness !== 'any') body.days = days[options.freshness];

    const started = Date.now();
    const raw = await request({
      provider: this.name,
      url: 'https://api.tavily.com/search',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      timeoutMs: 30_000,
      maxAttempts: 3,
      signal,
    });
    const parsed = JSON.parse(raw.body.toString('utf8')) as TavilyBody;
    if (!parsed.results) throw new ProviderRequestError(this.name, raw.status, parsed.error ?? 'no results field', false);
    const results: SearchResult[] = parsed.results
      .filter((r): r is { title: string; url: string; content?: string; published_date?: string } => Boolean(r.url && r.title))
      .map((r, i) => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? '',
        publishedAt: r.published_date,
        rank: i + 1,
        engine: this.name,
      }));
    return { query, results, provider: this.name, latencyMs: Date.now() - started, units: 1 };
  }
}

// ------------------------------------------------------------------ Serper --

interface SerperBody {
  organic?: Array<{ title?: string; link?: string; snippet?: string; date?: string }>;
  message?: string;
}

export class SerperSearchProvider implements WebSearchProvider {
  readonly name = 'serper';
  private static readonly REQUIRES = ['SERPER_API_KEY'];

  status(): ProviderStatus {
    const configured = Boolean(config().SERPER_API_KEY);
    return {
      name: this.name,
      kind: 'search',
      configured,
      detail: configured ? 'Serper.dev Google Search API' : 'SERPER_API_KEY is not set; web search is refused.',
      requires: SerperSearchProvider.REQUIRES,
    };
  }

  async search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResponse> {
    const key = config().SERPER_API_KEY;
    if (!key) throw new ProviderNotConfiguredError(this.name, SerperSearchProvider.REQUIRES);
    const tbs: Record<string, string> = { day: 'qdr:d', week: 'qdr:w', month: 'qdr:m', year: 'qdr:y' };
    const body: Record<string, unknown> = { q: buildQuery(query, options), num: clampCount(options) };
    if (options?.freshness && options.freshness !== 'any') body.tbs = tbs[options.freshness];
    if (options?.country) body.gl = options.country.toLowerCase();
    if (options?.language) body.hl = options.language;

    const started = Date.now();
    const raw = await request({
      provider: this.name,
      url: 'https://google.serper.dev/search',
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key },
      body: JSON.stringify(body),
      timeoutMs: 25_000,
      maxAttempts: 3,
      signal,
    });
    const parsed = JSON.parse(raw.body.toString('utf8')) as SerperBody;
    const results: SearchResult[] = (parsed.organic ?? [])
      .filter((r): r is { title: string; link: string; snippet?: string; date?: string } => Boolean(r.link && r.title))
      .map((r, i) => ({
        title: r.title,
        url: r.link,
        snippet: r.snippet ?? '',
        publishedAt: r.date,
        rank: i + 1,
        engine: this.name,
      }));
    return { query, results, provider: this.name, latencyMs: Date.now() - started, units: 1 };
  }
}

// ----------------------------------------------------------------- SearXNG --

interface SearxBody {
  results?: Array<{ title?: string; url?: string; content?: string; publishedDate?: string }>;
}

export class SearxngSearchProvider implements WebSearchProvider {
  readonly name = 'searxng';
  private static readonly REQUIRES = ['SEARXNG_BASE_URL'];

  status(): ProviderStatus {
    const configured = Boolean(config().SEARXNG_BASE_URL);
    return {
      name: this.name,
      kind: 'search',
      configured,
      detail: configured
        ? `Self-hosted SearXNG at ${config().SEARXNG_BASE_URL}`
        : 'SEARXNG_BASE_URL is not set; web search is refused.',
      requires: SearxngSearchProvider.REQUIRES,
    };
  }

  async search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResponse> {
    const base = config().SEARXNG_BASE_URL;
    if (!base) throw new ProviderNotConfiguredError(this.name, SearxngSearchProvider.REQUIRES);
    const timeRange: Record<string, string> = { day: 'day', week: 'week', month: 'month', year: 'year' };
    const params = new URLSearchParams({ q: buildQuery(query, options), format: 'json', safesearch: '0' });
    if (options?.freshness && options.freshness !== 'any') {
      const t = timeRange[options.freshness];
      if (t) params.set('time_range', t);
    }
    if (options?.language) params.set('language', options.language);

    const started = Date.now();
    const raw = await request({
      provider: this.name,
      url: `${base.replace(/\/$/, '')}/search?${params.toString()}`,
      headers: { accept: 'application/json' },
      timeoutMs: 30_000,
      maxAttempts: 2,
      signal,
    });
    const parsed = JSON.parse(raw.body.toString('utf8')) as SearxBody;
    const results: SearchResult[] = (parsed.results ?? [])
      .filter((r): r is { title: string; url: string; content?: string; publishedDate?: string } => Boolean(r.url && r.title))
      .slice(0, clampCount(options))
      .map((r, i) => ({
        title: r.title,
        url: r.url,
        snippet: r.content ?? '',
        publishedAt: r.publishedDate,
        rank: i + 1,
        engine: this.name,
      }));
    return { query, results, provider: this.name, latencyMs: Date.now() - started, units: 1 };
  }
}
