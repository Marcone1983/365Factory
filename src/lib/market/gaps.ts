import { z } from 'zod';
import { db, fromJson, newId, nowIso, toJson } from '@/lib/db/client';
import { completeJson } from '@/lib/ai/router';
import { createLogger } from '@/lib/observability/logger';
import { getDocument } from '@/lib/research/store';
import { componentsFromEvidence, scoreOpportunity, scoringModel, clamp01, type EvidenceStatistics, type OpportunityScore } from './scoring';
import { slugify, type SignalCluster, type Trend } from './trends';
import { getSignals, type MarketSignal } from './signals';

const log = createLogger('market.gaps');

/**
 * Gap synthesis and opportunity scoring.
 *
 * A gap is a claim about what the market is missing. It is only created when it
 * can point at concrete signals, and it inherits its confidence from them. The
 * model supplies the *interpretation* (what is missing, for whom, why) and the
 * four judgement components; every evidence-driven component is computed from
 * the corpus so the score cannot be inflated by rhetoric.
 */

export const GAP_TYPES = [
  'unmet_need',
  'recurring_problem',
  'price_barrier',
  'poor_ux',
  'missing_feature',
  'rising_demand',
  'unused_technology',
  'fragmented_market',
  'badly_reviewed_incumbent',
  'novel_combination',
  'ignored_niche',
  'trend_derived_need',
] as const;

export type GapType = (typeof GAP_TYPES)[number];

const GapSchema = z.object({
  title: z.string().min(8).max(140),
  description: z.string().min(40).max(1200),
  gapType: z.enum(GAP_TYPES),
  audience: z.string().min(3).max(160),
  category: z.string().min(3).max(40),
  supportingSignalIndexes: z.array(z.number().int().min(0)).min(1).max(20),
  judgement: z.object({
    monetization: z.number().min(0).max(1),
    monetizationRationale: z.string().min(15).max(400),
    feasibility: z.number().min(0).max(1),
    feasibilityRationale: z.string().min(15).max(400),
    originality: z.number().min(0).max(1),
    originalityRationale: z.string().min(15).max(400),
    timing: z.number().min(0).max(1),
    timingRationale: z.string().min(15).max(400),
  }),
  productForm: z.enum(['mobile_app', 'productivity_app', 'utility', 'educational_app', 'simulation', 'game', 'hybrid']),
  productFormRationale: z.string().min(15).max(400),
});

const GapsSchema = z.object({ gaps: z.array(GapSchema).max(6) });

export interface MarketGap {
  readonly id: string;
  readonly slug: string;
  readonly title: string;
  readonly description: string;
  readonly gapType: GapType;
  readonly audience: string;
  readonly category: string;
  readonly trendId: string | null;
  readonly evidenceCount: number;
  readonly confidence: number;
  readonly status: string;
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
}

interface GapRow {
  id: string;
  slug: string;
  title: string;
  description: string;
  gap_type: string;
  audience: string;
  category: string;
  trend_id: string | null;
  factory_run_id: string | null;
  evidence_count: number;
  confidence: number;
  status: string;
  first_seen_at: string;
  last_seen_at: string;
}

function toGap(row: GapRow): MarketGap {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    gapType: row.gap_type as GapType,
    audience: row.audience,
    category: row.category,
    trendId: row.trend_id,
    evidenceCount: row.evidence_count,
    confidence: row.confidence,
    status: row.status,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
  };
}

export type ProductForm = z.infer<typeof GapSchema>['productForm'];

export interface SynthesisedGap {
  readonly gap: MarketGap;
  readonly signals: readonly MarketSignal[];
  readonly productForm: ProductForm;
  readonly productFormRationale: string;
  readonly judgement: z.infer<typeof GapSchema>['judgement'];
}

const SYSTEM_PROMPT = `You identify concrete market gaps from clustered evidence.

Hard rules:
- Ground every gap in the numbered signals provided. Reference them by index in "supportingSignalIndexes".
- Never introduce facts, products, statistics or user counts that are absent from the signals.
- A gap must be specific enough to build a single product against. "People want better productivity apps" is not a gap; "freelance illustrators have no way to version and diff layered artwork offline" is.
- Score the four judgement components honestly. Low scores are useful; inflated scores waste the operator's money.
- feasibility is judged for a solo automated build cycle producing either a TypeScript web/mobile application or a WebGL 3D game packaged for Android. Anything needing proprietary data, hardware or a marketplace of users on day one scores below 0.3.
- productForm: choose "game" only when the core value really is play. If you choose "game" or "simulation" the product will be built as a 3D game.
- If the evidence does not support any specific gap, return an empty array.`;

export interface SynthesiseOptions {
  readonly trend?: Trend;
  readonly factoryRunId?: string;
  readonly agentRunId?: string;
  readonly maxGaps?: number;
  readonly constraints?: readonly string[];
}

export async function synthesiseGaps(cluster: SignalCluster, options: SynthesiseOptions = {}): Promise<SynthesisedGap[]> {
  const signals = cluster.signals.slice(0, 24);
  if (signals.length === 0) return [];

  const numbered = signals
    .map((s, i) => {
      const document = getDocument(s.documentId);
      return `[${i}] (${s.kind}, source=${s.category}, confidence=${s.confidence.toFixed(2)}) ${s.statement}\n     quote: "${s.evidenceQuote.slice(0, 220)}"\n     url: ${document?.url ?? 'unknown'}`;
    })
    .join('\n');

  const constraintText = options.constraints?.length
    ? `\n\nOperator constraints that you MUST respect:\n${options.constraints.map((c) => `- ${c}`).join('\n')}`
    : '';

  const { data } = await completeJson({
    task: 'gap_synthesis',
    schema: GapsSchema,
    system: SYSTEM_PROMPT,
    context: { factoryRunId: options.factoryRunId, agentRunId: options.agentRunId },
    messages: [
      {
        role: 'user',
        content:
          (options.trend
            ? `TREND: ${options.trend.label} — ${options.trend.description} (momentum ${options.trend.momentum.toFixed(2)})\n\n`
            : '') +
          `SIGNALS:\n${numbered}${constraintText}\n\n` +
          `Identify at most ${options.maxGaps ?? 3} market gaps. Return JSON {"gaps":[...]}.`,
      },
    ],
  });

  const out: SynthesisedGap[] = [];
  for (const candidate of data.gaps) {
    const supporting = candidate.supportingSignalIndexes
      .map((i) => signals[i])
      .filter((s): s is MarketSignal => Boolean(s));
    if (supporting.length === 0) {
      log.warn('discarded a gap with no resolvable supporting signals', { title: candidate.title });
      continue;
    }
    const gap = upsertGap({
      title: candidate.title,
      description: candidate.description,
      gapType: candidate.gapType,
      audience: candidate.audience,
      category: candidate.category,
      trendId: options.trend?.id ?? null,
      factoryRunId: options.factoryRunId,
      signals: supporting,
    });
    out.push({
      gap,
      signals: supporting,
      productForm: candidate.productForm,
      productFormRationale: candidate.productFormRationale,
      judgement: candidate.judgement,
    });
  }
  return out;
}

interface UpsertGapInput {
  title: string;
  description: string;
  gapType: GapType;
  audience: string;
  category: string;
  trendId: string | null;
  factoryRunId?: string;
  signals: readonly MarketSignal[];
}

export function upsertGap(input: UpsertGapInput): MarketGap {
  const database = db();
  const slug = slugify(input.title);
  const confidence = clamp01(
    input.signals.reduce((sum, s) => sum + s.confidence, 0) / Math.max(1, input.signals.length) *
      (0.6 + 0.4 * Math.min(1, input.signals.length / 6)),
  );
  const now = nowIso();
  const existing = database.prepare<[string], GapRow>('SELECT * FROM market_gaps WHERE slug = ?').get(slug);

  const gapId = existing?.id ?? newId('gap');
  if (existing) {
    database
      .prepare(
        `UPDATE market_gaps SET description = ?, evidence_count = ?, confidence = ?, last_seen_at = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(input.description, existing.evidence_count + input.signals.length, Math.max(existing.confidence, confidence), now, now, gapId);
  } else {
    database
      .prepare(
        `INSERT INTO market_gaps (id, slug, title, description, gap_type, audience, category, trend_id,
           factory_run_id, evidence_count, confidence, status, first_seen_at, last_seen_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'DISCOVERED', ?, ?, ?, ?)`,
      )
      .run(
        gapId, slug, input.title, input.description, input.gapType, input.audience, input.category,
        input.trendId, input.factoryRunId ?? null, input.signals.length, confidence, now, now, now, now,
      );
  }

  const linkEvidence = database.prepare(
    'INSERT INTO gap_evidence (gap_id, signal_id, document_id, weight, note) VALUES (?, ?, ?, ?, ?) ON CONFLICT DO NOTHING',
  );
  const tx = database.transaction(() => {
    for (const signal of input.signals) {
      linkEvidence.run(gapId, signal.id, signal.documentId, signal.confidence * signal.intensity, signal.kind);
    }
  });
  tx();

  const row = database.prepare<[string], GapRow>('SELECT * FROM market_gaps WHERE id = ?').get(gapId) as GapRow;
  return toGap(row);
}

// ------------------------------------------------------------ opportunities --

export interface CompetitiveSummary {
  readonly competitorCount: number;
  readonly meanRating: number | null;
}

export interface Opportunity {
  readonly id: string;
  readonly gapId: string;
  readonly title: string;
  readonly score: OpportunityScore;
  readonly rationale: string;
  readonly status: string;
  readonly productForm: ProductForm;
  readonly createdAt: string;
}

interface OpportunityRow {
  id: string;
  gap_id: string;
  factory_run_id: string | null;
  title: string;
  demand_score: number;
  competition_score: number;
  pain_score: number;
  growth_score: number;
  monetization_score: number;
  feasibility_score: number;
  originality_score: number;
  timing_score: number;
  data_confidence: number;
  opportunity_score: number;
  scoring_version: string;
  scoring_breakdown: string;
  rationale: string;
  status: string;
  created_at: string;
}

export function evidenceStatistics(
  signals: readonly MarketSignal[],
  cluster: SignalCluster | null,
  competitive: CompetitiveSummary,
): EvidenceStatistics {
  const documents = signals.map((s) => getDocument(s.documentId));
  const hosts = new Set<string>();
  const kinds = new Set<string>();
  let recent = 0;
  const thirtyDaysAgo = Date.now() - 30 * 86_400_000;

  for (const document of documents) {
    if (!document) continue;
    kinds.add(document.category);
    try {
      hosts.add(new URL(document.url).host);
    } catch {
      /* malformed stored URL cannot happen, but never let it throw here */
    }
    const ts = Date.parse(document.publishedAt ?? document.fetchedAt);
    if (Number.isFinite(ts) && ts >= thirtyDaysAgo) recent += 1;
  }

  const meanDocumentConfidence =
    documents.filter(Boolean).reduce((sum, d) => sum + (d?.confidence ?? 0), 0) / Math.max(1, documents.filter(Boolean).length);

  return {
    sourceKinds: kinds.size,
    distinctHosts: hosts.size,
    signalCount: signals.length,
    meanDocumentConfidence,
    meanPainIntensity: signals.reduce((sum, s) => sum + s.intensity, 0) / Math.max(1, signals.length),
    meanSentiment: signals.reduce((sum, s) => sum + s.sentiment, 0) / Math.max(1, signals.length),
    trendMomentum: cluster?.momentum ?? 0,
    recentShare: documents.length === 0 ? 0 : recent / documents.length,
    competitorCount: competitive.competitorCount,
    meanCompetitorRating: competitive.meanRating,
  };
}

export interface CreateOpportunityInput {
  readonly gap: MarketGap;
  readonly signals: readonly MarketSignal[];
  readonly cluster: SignalCluster | null;
  readonly competitive: CompetitiveSummary;
  readonly judgement: z.infer<typeof GapSchema>['judgement'];
  readonly productForm: ProductForm;
  readonly factoryRunId?: string;
}

export function createOpportunity(input: CreateOpportunityInput): Opportunity {
  const stats = evidenceStatistics(input.signals, input.cluster, input.competitive);
  const evidenceComponents = componentsFromEvidence(stats);
  const score = scoreOpportunity({
    ...evidenceComponents,
    monetization: input.judgement.monetization,
    feasibility: input.judgement.feasibility,
    originality: input.judgement.originality,
    timing: input.judgement.timing,
  });

  const rationale = [
    `Demand ${(evidenceComponents.demand * 100).toFixed(0)}/100 from ${stats.signalCount} signals across ${stats.sourceKinds} source classes and ${stats.distinctHosts} hosts.`,
    `Pain ${(evidenceComponents.pain * 100).toFixed(0)}/100 (mean sentiment ${stats.meanSentiment.toFixed(2)}).`,
    `Growth ${(evidenceComponents.growth * 100).toFixed(0)}/100 (trend momentum ${stats.trendMomentum.toFixed(2)}, ${(stats.recentShare * 100).toFixed(0)}% of evidence from the last 30 days).`,
    `Competition ${(evidenceComponents.competition * 100).toFixed(0)}/100 from ${stats.competitorCount} discovered incumbents.`,
    `Monetization: ${input.judgement.monetizationRationale}`,
    `Feasibility: ${input.judgement.feasibilityRationale}`,
    `Originality: ${input.judgement.originalityRationale}`,
    `Timing: ${input.judgement.timingRationale}`,
  ].join('\n');

  const id = newId('opp');
  db()
    .prepare(
      `INSERT INTO opportunities
        (id, gap_id, factory_run_id, title, demand_score, competition_score, pain_score, growth_score,
         monetization_score, feasibility_score, originality_score, timing_score, data_confidence,
         opportunity_score, scoring_version, scoring_breakdown, rationale, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.gap.id,
      input.factoryRunId ?? null,
      input.gap.title,
      score.components.demand,
      score.components.competition,
      score.components.pain,
      score.components.growth,
      score.components.monetization,
      score.components.feasibility,
      score.components.originality,
      score.components.timing,
      score.components.dataConfidence,
      score.score,
      score.version,
      toJson({ breakdown: score.breakdown, base: score.base, evidenceGate: score.evidenceGate, statistics: stats, productForm: input.productForm }),
      rationale,
      score.accepted ? 'PROPOSED' : 'ARCHIVED',
      nowIso(),
    );

  db().prepare('UPDATE market_gaps SET status = ?, updated_at = ? WHERE id = ?')
    .run(score.accepted ? 'ANALYZING' : 'ARCHIVED', nowIso(), input.gap.id);

  return {
    id,
    gapId: input.gap.id,
    title: input.gap.title,
    score,
    rationale,
    status: score.accepted ? 'PROPOSED' : 'ARCHIVED',
    productForm: input.productForm,
    createdAt: nowIso(),
  };
}

export interface OpportunitySummary {
  readonly id: string;
  readonly gapId: string;
  readonly title: string;
  readonly opportunityScore: number;
  readonly status: string;
  readonly rationale: string;
  readonly breakdown: Record<string, unknown>;
  readonly productForm: ProductForm;
  readonly createdAt: string;
}

function toSummary(row: OpportunityRow): OpportunitySummary {
  const breakdown = fromJson<Record<string, unknown>>(row.scoring_breakdown, {});
  return {
    id: row.id,
    gapId: row.gap_id,
    title: row.title,
    opportunityScore: row.opportunity_score,
    status: row.status,
    rationale: row.rationale,
    breakdown,
    productForm: (breakdown.productForm as ProductForm) ?? 'mobile_app',
    createdAt: row.created_at,
  };
}

export function listOpportunities(options: { limit?: number; factoryRunId?: string; status?: string } = {}): OpportunitySummary[] {
  const limit = Math.min(options.limit ?? 50, 500);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (options.factoryRunId) {
    clauses.push('factory_run_id = ?');
    params.push(options.factoryRunId);
  }
  if (options.status) {
    clauses.push('status = ?');
    params.push(options.status);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  return db()
    .prepare<unknown[], OpportunityRow>(`SELECT * FROM opportunities ${where} ORDER BY opportunity_score DESC LIMIT ?`)
    .all(...params)
    .map(toSummary);
}

export function getOpportunity(id: string): OpportunitySummary | null {
  const row = db().prepare<[string], OpportunityRow>('SELECT * FROM opportunities WHERE id = ?').get(id);
  return row ? toSummary(row) : null;
}

export function getGap(id: string): MarketGap | null {
  const row = db().prepare<[string], GapRow>('SELECT * FROM market_gaps WHERE id = ?').get(id);
  return row ? toGap(row) : null;
}

export function listGaps(options: { limit?: number; factoryRunId?: string } = {}): MarketGap[] {
  const limit = Math.min(options.limit ?? 50, 500);
  if (options.factoryRunId) {
    return db()
      .prepare<[string, number], GapRow>('SELECT * FROM market_gaps WHERE factory_run_id = ? ORDER BY confidence DESC LIMIT ?')
      .all(options.factoryRunId, limit)
      .map(toGap);
  }
  return db()
    .prepare<[number], GapRow>('SELECT * FROM market_gaps ORDER BY last_seen_at DESC LIMIT ?')
    .all(limit)
    .map(toGap);
}

/** Evidence trail for the "why did the AI choose this?" view. */
export interface GapEvidenceEntry {
  readonly signalId: string;
  readonly documentId: string;
  readonly weight: number;
  readonly statement: string;
  readonly quote: string;
  readonly url: string;
  readonly title: string;
  readonly sourceCategory: string;
  readonly fetchedAt: string;
}

export function gapEvidence(gapId: string): GapEvidenceEntry[] {
  const rows = db()
    .prepare<[string], { signal_id: string; document_id: string; weight: number }>(
      'SELECT signal_id, document_id, weight FROM gap_evidence WHERE gap_id = ? ORDER BY weight DESC',
    )
    .all(gapId);
  const signals = new Map(getSignals(rows.map((r) => r.signal_id)).map((s) => [s.id, s]));
  return rows.flatMap((row) => {
    const signal = signals.get(row.signal_id);
    const document = getDocument(row.document_id);
    if (!signal || !document) return [];
    return [
      {
        signalId: signal.id,
        documentId: document.id,
        weight: row.weight,
        statement: signal.statement,
        quote: signal.evidenceQuote,
        url: document.url,
        title: document.title,
        sourceCategory: document.category,
        fetchedAt: document.fetchedAt,
      },
    ];
  });
}

export function acceptanceThreshold(): number {
  return scoringModel().acceptanceThreshold;
}
