import fs from 'node:fs';
import path from 'node:path';
import { config } from '@/lib/config/env';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('market.scoring');

/**
 * Opportunity scoring model — version 1.
 *
 * Design intent
 * -------------
 * The score must be *explainable* and *auditable*: an operator has to be able to
 * read why an idea outranked another. So the model is a transparent weighted sum
 * of eight normalised components, gated by how much evidence actually backs it.
 *
 *     base       = Σ  wᵢ · sᵢ                       (sᵢ ∈ [0,1], Σ wᵢ = 1)
 *     evidence   = dataConfidence ^ γ               (γ = confidenceExponent)
 *     score      = 100 · base · evidence
 *
 * The evidence gate is deliberately multiplicative rather than additive: a
 * brilliant-looking opportunity supported by two thin blog posts *must not*
 * outrank a solid one supported by twenty first-hand user complaints. With the
 * default γ = 0.5, halving the confidence costs ~29% of the score.
 *
 * `competitionScore` is expressed as "how crowded the space is" (1 = saturated)
 * and enters the sum inverted, so the stored component stays intuitive while the
 * maths stays a plain weighted sum.
 *
 * Weights, the exponent and the acceptance threshold are configuration, not
 * code: drop a `scoring.json` into DATA_DIR to override them. The version string
 * is stored on every opportunity row so historical scores remain interpretable
 * after a model change.
 */

export const SCORING_VERSION = 'opportunity-v1';

export interface ScoreComponents {
  /** Volume and diversity of expressed demand. */
  readonly demand: number;
  /** Intensity of the pain: how badly current options fail people. */
  readonly pain: number;
  /** Direction and speed of interest over the observation window. */
  readonly growth: number;
  /** How crowded the space already is. Higher = more crowded. */
  readonly competition: number;
  /** Plausibility of a durable revenue model. */
  readonly monetization: number;
  /** Buildability by this factory within one generation cycle. */
  readonly feasibility: number;
  /** Distance from the closest discovered incumbent. */
  readonly originality: number;
  /** Why now: enabling technology, regulation, seasonality. */
  readonly timing: number;
  /** Quality and quantity of the underlying evidence. */
  readonly dataConfidence: number;
}

export interface ScoringWeights {
  readonly demand: number;
  readonly pain: number;
  readonly growth: number;
  readonly competitionInverse: number;
  readonly monetization: number;
  readonly feasibility: number;
  readonly originality: number;
  readonly timing: number;
}

export interface ScoringModel {
  readonly version: string;
  readonly weights: ScoringWeights;
  readonly confidenceExponent: number;
  /** Opportunities below this score are archived rather than built. */
  readonly acceptanceThreshold: number;
  /** Below this data confidence the opportunity is never auto-built. */
  readonly minimumDataConfidence: number;
  /** Concepts at or above this similarity to an incumbent must be revised. */
  readonly maximumSimilarity: number;
}

export const DEFAULT_MODEL: ScoringModel = {
  version: SCORING_VERSION,
  weights: {
    demand: 0.2,
    pain: 0.18,
    growth: 0.12,
    competitionInverse: 0.14,
    monetization: 0.1,
    feasibility: 0.12,
    originality: 0.08,
    timing: 0.06,
  },
  confidenceExponent: 0.5,
  acceptanceThreshold: 58,
  minimumDataConfidence: 0.35,
  maximumSimilarity: 0.86,
};

let model: ScoringModel | null = null;

export function scoringModel(): ScoringModel {
  if (model) return model;
  const file = path.join(config().dataDir, 'scoring.json');
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ScoringModel>;
    const merged: ScoringModel = {
      ...DEFAULT_MODEL,
      ...parsed,
      weights: { ...DEFAULT_MODEL.weights, ...(parsed.weights ?? {}) },
    };
    const total = Object.values(merged.weights).reduce((a, b) => a + b, 0);
    if (Math.abs(total - 1) > 0.001) {
      log.warn('scoring weights do not sum to 1; normalising', { total, file });
      const scale = 1 / total;
      model = {
        ...merged,
        weights: Object.fromEntries(Object.entries(merged.weights).map(([k, v]) => [k, v * scale])) as unknown as ScoringWeights,
      };
    } else {
      model = merged;
    }
    log.info('loaded scoring overrides', { file, version: model.version });
  } catch {
    model = DEFAULT_MODEL;
  }
  return model;
}

export function resetScoringModel(): void {
  model = null;
}

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export interface ScoreBreakdownEntry {
  readonly component: string;
  readonly value: number;
  readonly weight: number;
  readonly contribution: number;
  readonly explanation: string;
}

export interface OpportunityScore {
  readonly score: number;
  readonly base: number;
  readonly evidenceGate: number;
  readonly components: ScoreComponents;
  readonly breakdown: readonly ScoreBreakdownEntry[];
  readonly version: string;
  readonly accepted: boolean;
  readonly rejectionReasons: readonly string[];
}

const EXPLANATIONS: Record<keyof ScoringWeights, string> = {
  demand: 'Volume and diversity of independently expressed demand across source classes.',
  pain: 'Severity of the unmet need, from complaint density and negative sentiment in first-hand reports.',
  growth: 'Momentum of the underlying trend over the observation window.',
  competitionInverse: 'Head-room left by incumbents (inverse of how crowded the space is).',
  monetization: 'Plausibility of a durable revenue model for this audience.',
  feasibility: 'Buildability by this factory within one generation cycle on the available toolchain.',
  originality: 'Distance from the closest product discovered during competitive research.',
  timing: 'Why now: enabling technology, platform shift, regulation or seasonality.',
};

export function scoreOpportunity(components: ScoreComponents, override?: ScoringModel): OpportunityScore {
  const active = override ?? scoringModel();
  const w = active.weights;

  const normalised: ScoreComponents = {
    demand: clamp01(components.demand),
    pain: clamp01(components.pain),
    growth: clamp01(components.growth),
    competition: clamp01(components.competition),
    monetization: clamp01(components.monetization),
    feasibility: clamp01(components.feasibility),
    originality: clamp01(components.originality),
    timing: clamp01(components.timing),
    dataConfidence: clamp01(components.dataConfidence),
  };

  const pairs: Array<[keyof ScoringWeights, number]> = [
    ['demand', normalised.demand],
    ['pain', normalised.pain],
    ['growth', normalised.growth],
    ['competitionInverse', 1 - normalised.competition],
    ['monetization', normalised.monetization],
    ['feasibility', normalised.feasibility],
    ['originality', normalised.originality],
    ['timing', normalised.timing],
  ];

  const breakdown: ScoreBreakdownEntry[] = pairs.map(([component, value]) => ({
    component,
    value: Number(value.toFixed(4)),
    weight: w[component],
    contribution: Number((value * w[component]).toFixed(4)),
    explanation: EXPLANATIONS[component],
  }));

  const base = breakdown.reduce((sum, entry) => sum + entry.contribution, 0);
  const evidenceGate = normalised.dataConfidence ** active.confidenceExponent;
  const score = Number((100 * base * evidenceGate).toFixed(2));

  const rejectionReasons: string[] = [];
  if (score < active.acceptanceThreshold) {
    rejectionReasons.push(`score ${score.toFixed(1)} is below the acceptance threshold of ${active.acceptanceThreshold}`);
  }
  if (normalised.dataConfidence < active.minimumDataConfidence) {
    rejectionReasons.push(
      `evidence confidence ${normalised.dataConfidence.toFixed(2)} is below the minimum of ${active.minimumDataConfidence}`,
    );
  }
  if (normalised.feasibility < 0.3) {
    rejectionReasons.push('feasibility is too low to complete a build within one cycle');
  }

  return {
    score,
    base: Number(base.toFixed(4)),
    evidenceGate: Number(evidenceGate.toFixed(4)),
    components: normalised,
    breakdown,
    version: active.version,
    accepted: rejectionReasons.length === 0,
    rejectionReasons,
  };
}

// ------------------------------------------------- deterministic components --

export interface EvidenceStatistics {
  /** Distinct source classes that contributed at least one signal. */
  readonly sourceKinds: number;
  /** Distinct hosts that contributed at least one signal. */
  readonly distinctHosts: number;
  readonly signalCount: number;
  /** Mean per-document confidence of the supporting evidence. */
  readonly meanDocumentConfidence: number;
  /** Mean pain intensity across supporting signals, 0..1. */
  readonly meanPainIntensity: number;
  /** Mean sentiment across supporting signals, -1..1. */
  readonly meanSentiment: number;
  /** Trend momentum for the cluster this gap came from, -1..1. */
  readonly trendMomentum: number;
  /** Ratio of evidence published in the last 30 days. */
  readonly recentShare: number;
  readonly competitorCount: number;
  /** Mean incumbent user rating on a 0..1 scale, or null when unknown. */
  readonly meanCompetitorRating: number | null;
}

/**
 * Derives the evidence-driven components straight from the corpus so they cannot
 * be talked up by a model. Only the four judgement components (monetization,
 * feasibility, originality, timing) come from the LLM, and each of those must
 * cite evidence.
 */
export function componentsFromEvidence(stats: EvidenceStatistics): Pick<ScoreComponents, 'demand' | 'pain' | 'growth' | 'competition' | 'dataConfidence'> {
  // Demand saturates: 12 independent signals across 4 source classes is already
  // a strong reading; more adds little.
  const volume = 1 - Math.exp(-stats.signalCount / 8);
  const diversity = clamp01(stats.sourceKinds / 4) * 0.6 + clamp01(stats.distinctHosts / 8) * 0.4;
  const demand = clamp01(volume * 0.6 + diversity * 0.4);

  const negativity = clamp01((-stats.meanSentiment + 1) / 2);
  const pain = clamp01(stats.meanPainIntensity * 0.65 + negativity * 0.35);

  const growth = clamp01((stats.trendMomentum + 1) / 2 * 0.7 + stats.recentShare * 0.3);

  // Crowding rises with incumbent count and with how well those incumbents are
  // already rated: many well-liked competitors is the hardest market to enter.
  const density = 1 - Math.exp(-stats.competitorCount / 5);
  const satisfaction = stats.meanCompetitorRating ?? 0.6;
  const competition = clamp01(density * 0.65 + satisfaction * 0.35);

  const dataConfidence = clamp01(
    stats.meanDocumentConfidence * 0.5 +
      clamp01(stats.signalCount / 10) * 0.25 +
      clamp01(stats.distinctHosts / 6) * 0.25,
  );

  return { demand, pain, growth, competition, dataConfidence };
}
