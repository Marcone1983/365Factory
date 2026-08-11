import { config } from '@/lib/config/env';
import { request } from '@/lib/providers/http';
import { assertSafeUrl } from '@/lib/security/ssrf';
import { cacheGet, cacheSet, cacheKey } from '@/lib/cache';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('research.robots');

/**
 * robots.txt parsing and enforcement (REP, RFC 9309).
 *
 * Rules are grouped by user-agent, the most specific matching group wins, and
 * path matching implements the `*` wildcard and `$` anchor. Longest matching
 * rule wins; Allow beats Disallow on equal length. Crawl-delay is honoured by
 * the fetcher's per-host scheduler.
 */

interface Rule {
  readonly allow: boolean;
  readonly pattern: string;
  readonly length: number;
}

export interface RobotsPolicy {
  readonly host: string;
  readonly fetched: boolean;
  readonly rules: readonly Rule[];
  readonly crawlDelayMs: number | null;
  readonly sitemaps: readonly string[];
  /** True when robots.txt could not be retrieved; the fetcher then proceeds. */
  readonly unavailable: boolean;
}

const ROBOTS_TTL_SECONDS = 60 * 60 * 12;

function matchesAgent(line: string, agent: string): boolean {
  const value = line.trim().toLowerCase();
  return value === '*' || agent.toLowerCase().includes(value);
}

export function parseRobots(text: string, agent: string, host: string): RobotsPolicy {
  const lines = text.split(/\r?\n/);
  const groups: Array<{ agents: string[]; rules: Rule[]; crawlDelay: number | null }> = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[]; crawlDelay: number | null } | null = null;
  let expectingAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.split('#')[0]?.trim() ?? '';
    if (!line) continue;
    const separator = line.indexOf(':');
    if (separator < 0) continue;
    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'user-agent') {
      if (!current || !expectingAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value);
      expectingAgent = true;
      continue;
    }
    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }
    if (!current) continue;
    expectingAgent = false;
    if (field === 'disallow') {
      if (value === '') continue; // empty Disallow means "allow everything"
      current.rules.push({ allow: false, pattern: value, length: value.length });
    } else if (field === 'allow') {
      if (value === '') continue;
      current.rules.push({ allow: true, pattern: value, length: value.length });
    } else if (field === 'crawl-delay') {
      const seconds = Number.parseFloat(value);
      if (Number.isFinite(seconds) && seconds >= 0) current.crawlDelay = Math.min(seconds, 120) * 1000;
    }
  }

  const specific = groups.filter((g) => g.agents.some((a) => a !== '*' && matchesAgent(a, agent)));
  const wildcard = groups.filter((g) => g.agents.some((a) => a.trim() === '*'));
  const selected = specific.length > 0 ? specific : wildcard;

  return {
    host,
    fetched: true,
    rules: selected.flatMap((g) => g.rules),
    crawlDelayMs: selected.reduce<number | null>((acc, g) => (g.crawlDelay === null ? acc : Math.max(acc ?? 0, g.crawlDelay)), null),
    sitemaps,
    unavailable: false,
  };
}

function patternMatches(pattern: string, pathname: string): boolean {
  const anchored = pattern.endsWith('$');
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const segments = body.split('*');
  let cursor = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] as string;
    if (segment === '') continue;
    const index = pathname.indexOf(segment, cursor);
    if (i === 0 && index !== 0) return false;
    if (index < 0) return false;
    cursor = index + segment.length;
  }
  if (anchored) return cursor === pathname.length;
  return true;
}

export function isAllowed(policy: RobotsPolicy, url: URL): boolean {
  if (policy.unavailable || policy.rules.length === 0) return true;
  const target = `${url.pathname}${url.search}`;
  let best: Rule | null = null;
  for (const rule of policy.rules) {
    if (!patternMatches(rule.pattern, target)) continue;
    if (!best || rule.length > best.length || (rule.length === best.length && rule.allow && !best.allow)) {
      best = rule;
    }
  }
  return best ? best.allow : true;
}

const ALLOW_ALL: Omit<RobotsPolicy, 'host'> = {
  fetched: false,
  rules: [],
  crawlDelayMs: null,
  sitemaps: [],
  unavailable: true,
};

/** Fetches and caches robots.txt for an origin. */
export async function robotsFor(url: URL): Promise<RobotsPolicy> {
  const cfg = config();
  const host = url.host;
  const key = cacheKey('robots', `${url.protocol}//${host}`);
  const hit = cacheGet<RobotsPolicy>(key);
  if (hit) return hit;

  const robotsUrl = `${url.protocol}//${host}/robots.txt`;
  let policy: RobotsPolicy;
  try {
    await assertSafeUrl(robotsUrl);
    const response = await request({
      provider: 'research-robots',
      limiterKey: `host:${host}`,
      url: robotsUrl,
      headers: { 'user-agent': cfg.RESEARCH_USER_AGENT, accept: 'text/plain,*/*' },
      timeoutMs: 10_000,
      maxAttempts: 1,
      acceptStatuses: [404, 401, 403, 410],
    });
    if (response.status >= 400) {
      // Per RFC 9309 an unreachable or absent robots.txt means unrestricted access.
      policy = { ...ALLOW_ALL, host };
    } else {
      policy = parseRobots(response.body.toString('utf8').slice(0, 512_000), cfg.RESEARCH_USER_AGENT, host);
    }
  } catch (error) {
    log.debug('robots.txt unavailable; treating host as unrestricted', { host, error: (error as Error).message });
    policy = { ...ALLOW_ALL, host };
  }

  cacheSet(key, 'robots', policy, ROBOTS_TTL_SECONDS);
  return policy;
}
