import { z } from 'zod';
import { db, fromJson, newId, nowIso, toJson } from '@/lib/db/client';
import { embedTexts, cosineSimilarity } from '@/lib/knowledge/embeddings';
import { completeJson } from '@/lib/ai/router';
import { createLogger } from '@/lib/observability/logger';
import { getDocument } from '@/lib/research/store';
import type { MarketSignal } from './signals';

const log = createLogger('market.trends');

/**
 * Trend detection.
 *
 * Signals are clustered by semantic similarity using leader clustering: each
 * signal joins the first existing cluster whose centroid it is close enough to,
 * otherwise it starts a new one. Centroids are updated incrementally. This is
 * O(n·k) rather than O(n²), stable under insertion order after the sort below,
 * and needs no tuning beyond a single similarity threshold.
 *
 * Momentum compares the weight of evidence in the recent half of the observation
 * window against the older half, so a trend that is merely large but static
 * scores near zero while an accelerating one scores near +1.
 */

const DEFAULT_THRESHOLD = 0.68;

export interface SignalCluster {
  readonly id: string;
  readonly signals: readonly MarketSignal[];
  readonly keywords: readonly string[];
  readonly momentum: number;
  readonly volume: number;
  readonly meanSentiment: number;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

interface MutableCluster {
  centroid: Float32Array;
  count: number;
  signals: MarketSignal[];
}

function addToCentroid(centroid: Float32Array, vector: Float32Array, count: number): void {
  for (let i = 0; i < centroid.length; i += 1) {
    centroid[i] = ((centroid[i] as number) * count + (vector[i] as number)) / (count + 1);
  }
}

function evidenceTimestamp(signal: MarketSignal): number {
  const document = getDocument(signal.documentId);
  const published = document?.publishedAt ? Date.parse(document.publishedAt) : Number.NaN;
  if (Number.isFinite(published)) return published;
  const fetched = document?.fetchedAt ? Date.parse(document.fetchedAt) : Number.NaN;
  return Number.isFinite(fetched) ? fetched : Date.now();
}

/** Recency-weighted momentum in -1..1. */
export function computeMomentum(timestamps: readonly number[], weights: readonly number[], windowDays = 90): number {
  if (timestamps.length < 2) return 0;
  const now = Date.now();
  const windowMs = windowDays * 86_400_000;
  const midpoint = now - windowMs / 2;
  let recent = 0;
  let older = 0;
  timestamps.forEach((ts, i) => {
    const weight = weights[i] ?? 1;
    const age = now - ts;
    if (age > windowMs) {
      older += weight * 0.5;
      return;
    }
    if (ts >= midpoint) recent += weight;
    else older += weight;
  });
  const total = recent + older;
  if (total === 0) return 0;
  return Math.max(-1, Math.min(1, (recent - older) / total));
}

export async function clusterSignals(
  signals: readonly MarketSignal[],
  options: { threshold?: number; factoryRunId?: string } = {},
): Promise<SignalCluster[]> {
  if (signals.length === 0) return [];
  const threshold = options.threshold ?? DEFAULT_THRESHOLD;

  const texts = signals.map((s) => `${s.kind}: ${s.statement} | ${s.subject} | ${s.keywords.join(' ')}`);
  const vectors = await embedTexts(texts, { ownerType: 'signal', factoryRunId: options.factoryRunId });

  // Deterministic order: strongest evidence first, so cluster leaders are the
  // most reliable signals rather than whatever arrived first.
  const order = signals
    .map((signal, index) => ({ signal, index }))
    .sort((a, b) => b.signal.confidence * b.signal.intensity - a.signal.confidence * a.signal.intensity);

  const clusters: MutableCluster[] = [];
  for (const { signal, index } of order) {
    const vector = vectors[index] as Float32Array;
    let best: MutableCluster | null = null;
    let bestScore = threshold;
    for (const cluster of clusters) {
      const score = cosineSimilarity(vector, cluster.centroid);
      if (score >= bestScore) {
        bestScore = score;
        best = cluster;
      }
    }
    if (best) {
      addToCentroid(best.centroid, vector, best.count);
      best.count += 1;
      best.signals.push(signal);
    } else {
      clusters.push({ centroid: Float32Array.from(vector), count: 1, signals: [signal] });
    }
  }

  return clusters
    .map((cluster) => {
      const timestamps = cluster.signals.map(evidenceTimestamp);
      const weights = cluster.signals.map((s) => s.confidence * (0.5 + 0.5 * s.intensity));
      const keywordCounts = new Map<string, number>();
      for (const signal of cluster.signals) {
        for (const keyword of signal.keywords) {
          keywordCounts.set(keyword.toLowerCase(), (keywordCounts.get(keyword.toLowerCase()) ?? 0) + 1);
        }
      }
      const keywords = [...keywordCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(([k]) => k);

      return {
        id: newId('clu'),
        signals: cluster.signals,
        keywords,
        momentum: computeMomentum(timestamps, weights),
        volume: weights.reduce((a, b) => a + b, 0),
        meanSentiment: cluster.signals.reduce((sum, s) => sum + s.sentiment, 0) / cluster.signals.length,
        firstSeenAt: new Date(Math.min(...timestamps)).toISOString(),
        lastSeenAt: new Date(Math.max(...timestamps)).toISOString(),
      };
    })
    .sort((a, b) => b.volume * (1 + b.momentum) - a.volume * (1 + a.momentum));
}

// ------------------------------------------------------------- persistence --

const NamingSchema = z.object({
  label: z.string().min(3).max(80),
  description: z.string().min(20).max(400),
  category: z.string().min(3).max(40),
});

export interface Trend {
  readonly id: string;
  readonly slug: string;
  readonly label: string;
  readonly description: string;
  readonly category: string;
  readonly momentum: number;
  readonly volume: number;
  readonly signalCount: number;
  readonly keywords: string[];
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

interface TrendRow {
  id: string;
  slug: string;
  label: string;
  description: string;
  category: string;
  momentum: number;
  volume: number;
  signal_count: number;
  keywords: string;
  first_seen_at: string;
  last_seen_at: string;
}

function toTrend(row: TrendRow): Trend {
  return {
    id: row.id,
    slug: row.slug,
    label: row.label,
    description: row.description,
    category: row.category,
    momentum: row.momentum,
    volume: row.volume,
    signalCount: row.signal_count,
    keywords: fromJson<string[]>(row.keywords, []),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'trend';
}

/** Names a cluster and upserts it as a trend, merging with an existing slug. */
export async function persistTrend(
  cluster: SignalCluster,
  context: { factoryRunId?: string; agentRunId?: string } = {},
): Promise<Trend> {
  const sample = cluster.signals
    .slice(0, 8)
    .map((s, i) => `${i + 1}. [${s.kind}] ${s.statement}`)
    .join('\n');

  const { data } = await completeJson({
    task: 'trend_naming',
    schema: NamingSchema,
    context,
    system:
      'You name emerging market trends. Base the name only on the signals given. ' +
      'The label must be a specific, non-generic noun phrase (never "AI trends" or "mobile apps"). ' +
      'The category is a single lowercase word such as productivity, health, finance, gaming, education, developer, creative.',
    messages: [
      {
        role: 'user',
        content:
          `Signals in this cluster:\n${sample}\n\nRecurring keywords: ${cluster.keywords.join(', ')}\n\n` +
          'Return JSON: {"label":"...","description":"...","category":"..."}',
      },
    ],
  });

  const slug = slugify(data.label);
  const database = db();
  const existing = database.prepare<[string], TrendRow>('SELECT * FROM trends WHERE slug = ?').get(slug);
  const now = nowIso();

  if (existing) {
    database
      .prepare(
        `UPDATE trends SET momentum = ?, volume = ?, signal_count = ?, keywords = ?,
           last_seen_at = ?, description = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        cluster.momentum,
        existing.volume + cluster.volume,
        existing.signal_count + cluster.signals.length,
        toJson([...new Set([...fromJson<string[]>(existing.keywords, []), ...cluster.keywords])].slice(0, 16)),
        cluster.lastSeenAt > existing.last_seen_at ? cluster.lastSeenAt : existing.last_seen_at,
        data.description,
        now,
        existing.id,
      );
    linkSignals(existing.id, cluster);
    const updated = database.prepare<[string], TrendRow>('SELECT * FROM trends WHERE id = ?').get(existing.id) as TrendRow;
    return toTrend(updated);
  }

  const id = newId('trd');
  database
    .prepare(
      `INSERT INTO trends (id, slug, label, description, category, momentum, volume, signal_count, keywords,
         first_seen_at, last_seen_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id, slug, data.label, data.description, data.category, cluster.momentum, cluster.volume,
      cluster.signals.length, toJson(cluster.keywords), cluster.firstSeenAt, cluster.lastSeenAt, now, now,
    );
  linkSignals(id, cluster);
  log.info('new trend recorded', { slug, signals: cluster.signals.length, momentum: cluster.momentum.toFixed(2) });
  return {
    id,
    slug,
    label: data.label,
    description: data.description,
    category: data.category,
    momentum: cluster.momentum,
    volume: cluster.volume,
    signalCount: cluster.signals.length,
    keywords: [...cluster.keywords],
    firstSeenAt: cluster.firstSeenAt,
    lastSeenAt: cluster.lastSeenAt,
  };
}

function linkSignals(trendId: string, cluster: SignalCluster): void {
  const database = db();
  const insert = database.prepare(
    'INSERT INTO trend_signals (trend_id, signal_id, weight) VALUES (?, ?, ?) ON CONFLICT DO NOTHING',
  );
  const tx = database.transaction(() => {
    for (const signal of cluster.signals) insert.run(trendId, signal.id, signal.confidence * signal.intensity);
  });
  tx();
}

export function listTrends(limit = 50): Trend[] {
  return db()
    .prepare<[number], TrendRow>('SELECT * FROM trends ORDER BY (volume * (1 + momentum)) DESC LIMIT ?')
    .all(Math.min(limit, 500))
    .map(toTrend);
}

export function getTrend(id: string): Trend | null {
  const row = db().prepare<[string], TrendRow>('SELECT * FROM trends WHERE id = ?').get(id);
  return row ? toTrend(row) : null;
}

export function signalIdsForTrend(trendId: string): string[] {
  return db()
    .prepare<[string], { signal_id: string }>('SELECT signal_id FROM trend_signals WHERE trend_id = ?')
    .all(trendId)
    .map((r) => r.signal_id);
}
