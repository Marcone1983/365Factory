import { z } from 'zod';
import { Agent, AgentError, type AgentContext } from './base';
import { completeJson } from '@/lib/ai/router';
import { runResearch, type ResearchOutcome } from '@/lib/research/pipeline';
import { baseQueryPlan, gameQueryPlan, type QueryPlanEntry } from '@/lib/research/sources';
import { extractSignals, type MarketSignal } from '@/lib/market/signals';
import { clusterSignals, persistTrend, type SignalCluster, type Trend } from '@/lib/market/trends';
import { analyseCompetition, type CompetitiveMap } from '@/lib/market/competitive';
import { createOpportunity, synthesiseGaps, type MarketGap, type Opportunity, type ProductForm } from '@/lib/market/gaps';
import type { ResearchDocument } from '@/lib/research/store';

/**
 * Discovery agents: they turn an objective into evidence, evidence into trends,
 * trends into gaps, and gaps into scored opportunities. Each one is a thin,
 * auditable wrapper over the market-intelligence engine — the reasoning lives in
 * the engine, the agent owns retries, provenance and progress reporting.
 */

// ------------------------------------------------------------------ research --

const QueryPlanSchema = z.object({
  queries: z
    .array(
      z.object({
        query: z.string().min(4).max(220),
        intent: z.enum(['demand', 'complaint', 'supply', 'commercial', 'emerging']),
        freshness: z.enum(['day', 'week', 'month', 'year', 'any']),
        site: z.string().max(80).optional(),
        rationale: z.string().max(200),
      }),
    )
    .min(1)
    .max(14),
});

export interface ResearchAgentInput {
  readonly objective: string;
  readonly constraints?: readonly string[];
  readonly includeGameSources?: boolean;
  readonly rounds?: number;
  readonly maxDocuments?: number;
}

export interface ResearchAgentOutput {
  readonly documents: readonly ResearchDocument[];
  readonly rounds: number;
  readonly queriesExecuted: number;
  readonly failures: number;
  readonly searchProvider: string;
}

export class ResearchAgent extends Agent<ResearchAgentInput, ResearchAgentOutput> {
  readonly name = 'research';
  readonly description = 'Plans and runs iterative web research, verifying and storing sources with provenance';

  protected async execute(input: ResearchAgentInput, context: AgentContext): Promise<ResearchAgentOutput> {
    const rounds = Math.max(1, Math.min(input.rounds ?? 2, 5));
    const collected: ResearchDocument[] = [];
    const seenQueries = new Set<string>();
    let executed = 0;
    let failures = 0;
    let provider = 'unknown';

    let plan: QueryPlanEntry[] = [
      ...baseQueryPlan(input.objective),
      ...(input.includeGameSources ? gameQueryPlan(input.objective) : []),
    ];

    for (let round = 1; round <= rounds; round += 1) {
      const fresh = plan.filter((entry) => {
        const key = `${entry.query}|${entry.site ?? ''}`;
        if (seenQueries.has(key)) return false;
        seenQueries.add(key);
        return true;
      });
      if (fresh.length === 0) break;

      context.progress(`research round ${round}: ${fresh.length} queries`, { round, queries: fresh.map((q) => q.query) });
      let outcome: ResearchOutcome;
      try {
        outcome = await runResearch({
          queries: fresh,
          maxDocuments: Math.ceil((input.maxDocuments ?? 60) / rounds),
          factoryRunId: context.factoryRunId,
          signal: context.signal,
        });
      } catch (error) {
        throw new AgentError((error as Error).message, false, 'RESEARCH_UNAVAILABLE');
      }

      provider = outcome.searchProvider;
      executed += outcome.queries.length;
      failures += outcome.failures.length;
      collected.push(...outcome.documents);
      context.checkpoint({ round, documents: collected.length });
      context.progress(`round ${round}: stored ${outcome.documents.length} new documents (${outcome.duplicates} duplicates, ${outcome.failures.length} unreachable)`);

      if (round === rounds || collected.length === 0) break;

      // Iterative refinement: the next round's queries are derived from what the
      // corpus actually revealed, not from the original phrasing.
      plan = await this.deriveFollowUpQueries(input, collected, context);
    }

    if (collected.length === 0) {
      throw new AgentError(
        'Research produced no usable documents. Either the search provider returned nothing for this objective, ' +
          'or every candidate source refused crawling. No market conclusions can be drawn.',
        false,
        'NO_EVIDENCE',
      );
    }

    return { documents: collected, rounds, queriesExecuted: executed, failures, searchProvider: provider };
  }

  private async deriveFollowUpQueries(
    input: ResearchAgentInput,
    documents: readonly ResearchDocument[],
    context: AgentContext,
  ): Promise<QueryPlanEntry[]> {
    const digest = documents
      .slice(0, 25)
      .map((d, i) => `[${i}] (${d.category}) ${d.title} — ${d.keywords.slice(0, 8).join(', ')}`)
      .join('\n');

    const { data } = await completeJson({
      task: 'query_expansion',
      schema: QueryPlanSchema,
      context: { factoryRunId: context.factoryRunId },
      signal: context.signal,
      system:
        'You plan the next round of market research. Read what the first round found and propose queries that ' +
        'close the gaps: contradicting evidence, unexamined audiences, pricing reality, and the specific vocabulary ' +
        'the affected people actually use. Never repeat a query that would return the same pages.',
      messages: [
        {
          role: 'user',
          content:
            `OBJECTIVE: ${input.objective}\n` +
            (input.constraints?.length ? `CONSTRAINTS: ${input.constraints.join('; ')}\n` : '') +
            `\nWHAT ROUND 1 FOUND:\n${digest}\n\nReturn JSON {"queries":[{"query","intent","freshness","site?","rationale"}]}.`,
        },
      ],
    });

    return data.queries.map((entry) => ({
      query: entry.query,
      kind: 'general' as const,
      intent: entry.intent,
      freshness: entry.freshness,
      ...(entry.site ? { site: entry.site } : {}),
    }));
  }
}

// --------------------------------------------------------------------- trend --

export interface TrendAgentInput {
  readonly documents: readonly ResearchDocument[];
  readonly maxTrends?: number;
}

export interface TrendAgentOutput {
  readonly signals: readonly MarketSignal[];
  readonly clusters: readonly SignalCluster[];
  readonly trends: readonly Trend[];
  readonly rejectedQuotes: number;
}

export class TrendAgent extends Agent<TrendAgentInput, TrendAgentOutput> {
  readonly name = 'trend';
  readonly description = 'Extracts verifiable market signals and clusters them into named trends';

  protected async execute(input: TrendAgentInput, context: AgentContext): Promise<TrendAgentOutput> {
    context.progress(`extracting signals from ${input.documents.length} documents`);
    const extraction = await extractSignals(input.documents, {
      factoryRunId: context.factoryRunId,
      signal: context.signal,
    });
    if (extraction.signals.length === 0) {
      throw new AgentError(
        `No market signal survived quote verification across ${input.documents.length} documents ` +
          `(${extraction.rejectedQuotes} candidate quotes were rejected as not present in their source).`,
        false,
        'NO_SIGNALS',
      );
    }
    context.progress(`kept ${extraction.signals.length} verified signals, rejected ${extraction.rejectedQuotes} unverifiable quotes`);

    const clusters = await clusterSignals(extraction.signals, { factoryRunId: context.factoryRunId });
    const top = clusters.slice(0, input.maxTrends ?? 6);
    context.progress(`clustered into ${clusters.length} groups; naming the top ${top.length}`);

    const trends: Trend[] = [];
    for (const cluster of top) {
      if (cluster.signals.length < 2) continue;
      trends.push(await persistTrend(cluster, { factoryRunId: context.factoryRunId }));
    }

    return { signals: extraction.signals, clusters: top, trends, rejectedQuotes: extraction.rejectedQuotes };
  }
}

// ----------------------------------------------------------------------- gap --

export interface GapAgentInput {
  readonly clusters: readonly SignalCluster[];
  readonly trends: readonly Trend[];
  readonly constraints?: readonly string[];
  readonly maxGapsPerCluster?: number;
}

export interface SynthesisedGapWithForm {
  readonly gap: MarketGap;
  readonly cluster: SignalCluster;
  readonly signals: readonly MarketSignal[];
  readonly productForm: ProductForm;
  readonly productFormRationale: string;
  readonly judgement: {
    monetization: number;
    monetizationRationale: string;
    feasibility: number;
    feasibilityRationale: string;
    originality: number;
    originalityRationale: string;
    timing: number;
    timingRationale: string;
  };
}

export interface GapAgentOutput {
  readonly gaps: readonly SynthesisedGapWithForm[];
}

export class GapAgent extends Agent<GapAgentInput, GapAgentOutput> {
  readonly name = 'gap';
  readonly description = 'Synthesises concrete, evidence-backed market gaps from clustered signals';

  protected async execute(input: GapAgentInput, context: AgentContext): Promise<GapAgentOutput> {
    const gaps: SynthesisedGapWithForm[] = [];

    for (const [index, cluster] of input.clusters.entries()) {
      if (context.signal?.aborted) break;
      const trend = input.trends[index];
      context.progress(`synthesising gaps for cluster ${index + 1}/${input.clusters.length} (${cluster.signals.length} signals)`);
      const synthesised = await synthesiseGaps(cluster, {
        trend,
        factoryRunId: context.factoryRunId,
        constraints: input.constraints,
        maxGaps: input.maxGapsPerCluster ?? 2,
      });
      for (const entry of synthesised) {
        gaps.push({
          gap: entry.gap,
          cluster,
          signals: entry.signals,
          productForm: entry.productForm,
          productFormRationale: entry.productFormRationale,
          judgement: entry.judgement,
        });
      }
    }

    if (gaps.length === 0) {
      throw new AgentError(
        'No market gap could be grounded in the collected evidence. The scan found signals but nothing specific ' +
          'enough to build a product against.',
        false,
        'NO_GAPS',
      );
    }
    return { gaps };
  }
}

// --------------------------------------------------------------- competitive --

export interface CompetitiveAgentInput {
  readonly gaps: readonly SynthesisedGapWithForm[];
  readonly maxGapsToAnalyse?: number;
}

export interface ScoredOpportunity {
  readonly opportunity: Opportunity;
  readonly gap: MarketGap;
  readonly competitive: CompetitiveMap;
  readonly productForm: ProductForm;
}

export interface CompetitiveAgentOutput {
  readonly opportunities: readonly ScoredOpportunity[];
}

export class CompetitiveAgent extends Agent<CompetitiveAgentInput, CompetitiveAgentOutput> {
  readonly name = 'competitive';
  readonly description = 'Maps incumbents for each gap and produces the final scored opportunities';

  protected async execute(input: CompetitiveAgentInput, context: AgentContext): Promise<CompetitiveAgentOutput> {
    const limit = input.maxGapsToAnalyse ?? 4;
    // Analyse the best-evidenced gaps first: competitive research is the most
    // expensive discovery step, so it is spent where it can change a decision.
    const ordered = [...input.gaps].sort((a, b) => b.gap.confidence - a.gap.confidence).slice(0, limit);
    const opportunities: ScoredOpportunity[] = [];

    for (const entry of ordered) {
      if (context.signal?.aborted) break;
      context.progress(`competitive research: ${entry.gap.title}`);
      const isGame = entry.productForm === 'game' || entry.productForm === 'simulation';

      // The opportunity row is created after the competitive map so the
      // competition component is grounded in real incumbents.
      const placeholderId = entry.gap.id;
      const competitive = await analyseCompetition(entry.gap, placeholderId, {
        isGame,
        factoryRunId: context.factoryRunId,
        signal: context.signal,
      });

      const opportunity = createOpportunity({
        gap: entry.gap,
        signals: entry.signals,
        cluster: entry.cluster,
        competitive: { competitorCount: competitive.competitors.length, meanRating: competitive.meanRating },
        judgement: entry.judgement,
        productForm: entry.productForm,
        factoryRunId: context.factoryRunId,
      });

      context.progress(
        `${entry.gap.title}: score ${opportunity.score.score.toFixed(1)} (${competitive.competitors.length} incumbents, ${competitive.saturation.level})`,
        { opportunityId: opportunity.id, score: opportunity.score.score, accepted: opportunity.score.accepted },
      );
      opportunities.push({ opportunity, gap: entry.gap, competitive, productForm: entry.productForm });
    }

    if (opportunities.length === 0) {
      throw new AgentError('No opportunity could be scored from the discovered gaps.', false, 'NO_OPPORTUNITIES');
    }
    return { opportunities: opportunities.sort((a, b) => b.opportunity.score.score - a.opportunity.score.score) };
  }
}
