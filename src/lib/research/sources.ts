import { db, newId, nowIso } from '@/lib/db/client';

/**
 * Source taxonomy.
 *
 * The market scan deliberately samples across *kinds* of evidence rather than a
 * fixed site list: demand signals, complaint signals, supply signals and
 * commercial signals each answer a different question, and an opportunity is
 * only trusted when more than one kind agrees.
 *
 * Sites are reached through the configured search provider using `site:`
 * scoping and then fetched under robots.txt. No private or authenticated
 * endpoint is ever accessed, and no scraping of a site that disallows it.
 */

export type SourceKind =
  | 'search_trend'
  | 'news'
  | 'community'
  | 'forum'
  | 'launch'
  | 'app_store'
  | 'game_store'
  | 'review'
  | 'tech_media'
  | 'research_report'
  | 'developer'
  | 'general';

export interface SourceProfile {
  readonly kind: SourceKind;
  /** Evidence weight, 0..1. Primary user voice ranks above secondary commentary. */
  readonly trust: number;
  readonly label: string;
}

const HOST_PROFILES: ReadonlyArray<[RegExp, SourceProfile]> = [
  [/(^|\.)trends\.google\./i, { kind: 'search_trend', trust: 0.85, label: 'Google Trends' }],
  [/(^|\.)reddit\.com$/i, { kind: 'community', trust: 0.8, label: 'Reddit' }],
  [/(^|\.)news\.ycombinator\.com$/i, { kind: 'community', trust: 0.78, label: 'Hacker News' }],
  [/(^|\.)producthunt\.com$/i, { kind: 'launch', trust: 0.75, label: 'Product Hunt' }],
  [/(^|\.)play\.google\.com$/i, { kind: 'app_store', trust: 0.85, label: 'Google Play' }],
  [/(^|\.)apps\.apple\.com$/i, { kind: 'app_store', trust: 0.85, label: 'App Store' }],
  [/(^|\.)store\.steampowered\.com$/i, { kind: 'game_store', trust: 0.85, label: 'Steam' }],
  [/(^|\.)itch\.io$/i, { kind: 'game_store', trust: 0.7, label: 'itch.io' }],
  [/(^|\.)(g2|capterra|trustpilot|getapp|softwareadvice|alternativeto)\.(com|to)$/i, { kind: 'review', trust: 0.8, label: 'Review marketplace' }],
  [/(^|\.)(stackoverflow|stackexchange|superuser|serverfault)\.com$/i, { kind: 'forum', trust: 0.75, label: 'Stack Exchange' }],
  [/(^|\.)(github|gitlab)\.com$/i, { kind: 'developer', trust: 0.7, label: 'Code host' }],
  [/(^|\.)(techcrunch|theverge|arstechnica|wired|engadget|venturebeat|androidpolice|9to5mac|xda-developers)\.com$/i, { kind: 'tech_media', trust: 0.65, label: 'Technology media' }],
  [/(^|\.)(gamasutra|gamedeveloper|pocketgamer|gamesindustry)\.(com|biz)$/i, { kind: 'tech_media', trust: 0.68, label: 'Games industry media' }],
  [/(^|\.)(statista|gartner|forrester|idc|sensortower|data\.ai|appfigures)\.com$/i, { kind: 'research_report', trust: 0.72, label: 'Market research' }],
  [/(^|\.)(bbc|reuters|apnews|ft|bloomberg|cnbc|nytimes|theguardian)\.(com|co\.uk)$/i, { kind: 'news', trust: 0.7, label: 'News' }],
  [/(^|\.)(discourse|forum|community)\./i, { kind: 'forum', trust: 0.65, label: 'Community forum' }],
];

export function profileForHost(host: string): SourceProfile {
  const clean = host.toLowerCase().replace(/^www\./, '');
  for (const [pattern, profile] of HOST_PROFILES) {
    if (pattern.test(clean)) return profile;
  }
  return { kind: 'general', trust: 0.45, label: clean };
}

export interface QueryPlanEntry {
  readonly query: string;
  readonly kind: SourceKind;
  readonly intent: 'demand' | 'complaint' | 'supply' | 'commercial' | 'emerging';
  readonly freshness: 'day' | 'week' | 'month' | 'year' | 'any';
  readonly site?: string;
}

/**
 * Deterministic base plan. The Research Agent expands it with LLM-generated
 * queries, but the platform always covers these evidence classes so a scan is
 * never one-sided even when the model is terse.
 */
export function baseQueryPlan(topic: string): QueryPlanEntry[] {
  const t = topic.trim();
  return [
    { query: `${t} "is there an app" OR "looking for an app"`, kind: 'community', intent: 'demand', freshness: 'month', site: 'reddit.com' },
    { query: `${t} "i wish there was" OR "why is there no"`, kind: 'community', intent: 'demand', freshness: 'month', site: 'reddit.com' },
    { query: `${t} frustrating OR "doesn't work" OR "too expensive"`, kind: 'review', intent: 'complaint', freshness: 'month' },
    { query: `${t} app negative reviews complaints`, kind: 'app_store', intent: 'complaint', freshness: 'year', site: 'play.google.com' },
    { query: `${t} alternative to`, kind: 'review', intent: 'supply', freshness: 'year' },
    { query: `${t} new launch`, kind: 'launch', intent: 'supply', freshness: 'month', site: 'producthunt.com' },
    { query: `${t} market size growth forecast`, kind: 'research_report', intent: 'commercial', freshness: 'year' },
    { query: `${t} trend 2026 rising interest`, kind: 'search_trend', intent: 'emerging', freshness: 'month' },
    { query: `${t} pricing subscription cost comparison`, kind: 'review', intent: 'commercial', freshness: 'year' },
    { query: `${t} discussion problems workflow`, kind: 'forum', intent: 'complaint', freshness: 'month' },
  ];
}

/** Additional plan used when the run is explicitly hunting for a 3D game gap. */
export function gameQueryPlan(topic: string): QueryPlanEntry[] {
  const t = topic.trim();
  return [
    { query: `${t} mobile game "wish there was" OR "no game that"`, kind: 'community', intent: 'demand', freshness: 'month', site: 'reddit.com' },
    { query: `${t} game reviews "too many ads" OR "pay to win"`, kind: 'app_store', intent: 'complaint', freshness: 'year', site: 'play.google.com' },
    { query: `${t} indie 3D game release`, kind: 'game_store', intent: 'supply', freshness: 'month', site: 'itch.io' },
    { query: `${t} game genre trending players want`, kind: 'game_store', intent: 'emerging', freshness: 'month', site: 'store.steampowered.com' },
    { query: `${t} mobile game monetisation player backlash`, kind: 'tech_media', intent: 'commercial', freshness: 'year' },
  ];
}

// -------------------------------------------------------------- persistence --

export interface SourceRow {
  readonly id: string;
  readonly kind: string;
  readonly name: string;
  readonly host: string;
  readonly base_url: string;
  readonly trust_weight: number;
  readonly robots_policy: string;
  readonly enabled: number;
  readonly last_fetch_at: string | null;
  readonly created_at: string;
}

/** Registers (or returns) the source record for a URL, keeping provenance stable. */
export function upsertSource(url: string): SourceRow {
  const parsed = new URL(url);
  const host = parsed.host.toLowerCase();
  const profile = profileForHost(host);
  const database = db();
  const existing = database
    .prepare<[string, string], SourceRow>('SELECT * FROM research_sources WHERE host = ? AND kind = ?')
    .get(host, profile.kind);
  if (existing) {
    database.prepare('UPDATE research_sources SET last_fetch_at = ? WHERE id = ?').run(nowIso(), existing.id);
    return { ...existing, last_fetch_at: nowIso() };
  }
  const row: SourceRow = {
    id: newId('src'),
    kind: profile.kind,
    name: profile.label,
    host,
    base_url: `${parsed.protocol}//${host}`,
    trust_weight: profile.trust,
    robots_policy: 'respect',
    enabled: 1,
    last_fetch_at: nowIso(),
    created_at: nowIso(),
  };
  database
    .prepare(
      `INSERT INTO research_sources (id, kind, name, host, base_url, trust_weight, robots_policy, enabled, last_fetch_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(row.id, row.kind, row.name, row.host, row.base_url, row.trust_weight, row.robots_policy, row.enabled, row.last_fetch_at, row.created_at);
  return row;
}

export function listSources(limit = 200): SourceRow[] {
  return db()
    .prepare<[number], SourceRow>('SELECT * FROM research_sources ORDER BY last_fetch_at DESC LIMIT ?')
    .all(limit);
}
