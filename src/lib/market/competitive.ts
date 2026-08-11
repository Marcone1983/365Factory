import { z } from 'zod';
import { db, fromJson, newId, nowIso, toJson } from '@/lib/db/client';
import { completeJson } from '@/lib/ai/router';
import { runResearch } from '@/lib/research/pipeline';
import { createLogger } from '@/lib/observability/logger';
import type { QueryPlanEntry } from '@/lib/research/sources';
import type { ResearchDocument } from '@/lib/research/store';
import type { MarketGap } from './gaps';

const log = createLogger('market.competitive');

/**
 * Competitive intelligence.
 *
 * Incumbents are discovered by searching the stores, review marketplaces and
 * launch sites, fetching what the crawler is allowed to fetch, and extracting a
 * structured profile from that text only. Ratings, pricing and user counts are
 * recorded only when the fetched page states them; otherwise the field stays
 * empty, because an invented download number would poison the whole score.
 */

const CompetitorSchema = z.object({
  name: z.string().min(2).max(120),
  url: z.string().max(500).default(''),
  platform: z.string().max(80).default(''),
  pricing: z.string().max(200).default(''),
  usersEstimate: z.string().max(120).default(''),
  rating: z.number().min(0).max(5).nullable().default(null),
  strengths: z.array(z.string().max(200)).max(6).default([]),
  weaknesses: z.array(z.string().max(200)).max(6).default([]),
  complaints: z.array(z.string().max(300)).max(8).default([]),
  monetization: z.string().max(200).default(''),
  sourceIndex: z.number().int().min(0),
});

const AnalysisSchema = z.object({
  competitors: z.array(CompetitorSchema).max(12),
  differentiationStrategy: z.object({
    positioning: z.string().min(30).max(600),
    unexploitedAngles: z.array(z.string().max(240)).min(1).max(8),
    avoid: z.array(z.string().max(240)).max(6).default([]),
    hardestToCopy: z.string().min(20).max(400),
  }),
  saturationAssessment: z.object({
    level: z.enum(['empty', 'thin', 'competitive', 'crowded', 'saturated']),
    reasoning: z.string().min(20).max(600),
  }),
});

export interface Competitor {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly platform: string;
  readonly pricing: string;
  readonly usersEstimate: string;
  readonly rating: number | null;
  readonly strengths: string[];
  readonly weaknesses: string[];
  readonly complaints: string[];
  readonly monetization: string;
  readonly evidenceDocumentId: string | null;
}

export interface CompetitiveMap {
  readonly competitors: readonly Competitor[];
  readonly differentiation: z.infer<typeof AnalysisSchema>['differentiationStrategy'];
  readonly saturation: z.infer<typeof AnalysisSchema>['saturationAssessment'];
  readonly documentsAnalysed: number;
  readonly meanRating: number | null;
}

function competitorQueries(gap: MarketGap, isGame: boolean): QueryPlanEntry[] {
  const subject = `${gap.title} ${gap.audience}`.slice(0, 120);
  const base: QueryPlanEntry[] = [
    { query: `${subject} app`, kind: 'app_store', intent: 'supply', freshness: 'year', site: 'play.google.com' },
    { query: `${subject} app`, kind: 'app_store', intent: 'supply', freshness: 'year', site: 'apps.apple.com' },
    { query: `best ${subject} tools comparison`, kind: 'review', intent: 'supply', freshness: 'year' },
    { query: `${subject} alternatives`, kind: 'review', intent: 'supply', freshness: 'year', site: 'alternativeto.net' },
    { query: `${subject} reviews complaints`, kind: 'review', intent: 'complaint', freshness: 'year' },
    { query: `${subject} pricing plans`, kind: 'review', intent: 'commercial', freshness: 'year' },
  ];
  if (isGame) {
    base.push(
      { query: `${subject} game`, kind: 'game_store', intent: 'supply', freshness: 'year', site: 'store.steampowered.com' },
      { query: `${subject} game`, kind: 'game_store', intent: 'supply', freshness: 'year', site: 'itch.io' },
    );
  }
  return base;
}

export interface CompetitiveOptions {
  readonly isGame?: boolean;
  readonly factoryRunId?: string;
  readonly agentRunId?: string;
  readonly maxDocuments?: number;
  readonly signal?: AbortSignal;
}

const SYSTEM_PROMPT = `You are a competitive analyst. You are given fetched pages about products that already serve a market.

Hard rules:
- Extract only products that are actually described in the provided documents. Reference the document you used with "sourceIndex".
- "rating", "pricing" and "usersEstimate" must be left empty/null unless the document states them explicitly. Never estimate them.
- "complaints" must paraphrase concrete criticisms present in the documents, not generic weaknesses.
- The differentiation strategy must describe angles that the listed incumbents demonstrably do not cover.
- If the documents show no real competitor, return an empty competitors array and say so in the saturation reasoning.`;

export async function analyseCompetition(
  gap: MarketGap,
  opportunityId: string,
  options: CompetitiveOptions = {},
): Promise<CompetitiveMap> {
  const research = await runResearch({
    queries: competitorQueries(gap, options.isGame ?? false),
    maxDocuments: options.maxDocuments ?? 18,
    factoryRunId: options.factoryRunId,
    signal: options.signal,
    resultsPerQuery: 6,
    minWordCount: 60,
  });

  const documents: ResearchDocument[] = [...research.documents];
  if (documents.length === 0) {
    log.warn('competitive research returned no new documents', { gapId: gap.id, failures: research.failures.length });
    return {
      competitors: [],
      differentiation: {
        positioning: 'No incumbent documentation could be retrieved, so positioning is based solely on the gap evidence.',
        unexploitedAngles: ['Direct solution to the stated gap, since no competitor evidence was retrievable.'],
        avoid: [],
        hardestToCopy: 'Unknown: no competitor evidence was available at analysis time.',
      },
      saturation: { level: 'thin', reasoning: 'No competitor pages could be fetched; treat this reading as low confidence.' },
      documentsAnalysed: 0,
      meanRating: null,
    };
  }

  const corpus = documents
    .map((d, i) => `[${i}] ${d.title}\nURL: ${d.url}\n${d.content.slice(0, 3500)}`)
    .join('\n\n---\n\n');

  const { data } = await completeJson({
    task: 'competitive_analysis',
    schema: AnalysisSchema,
    system: SYSTEM_PROMPT,
    context: { factoryRunId: options.factoryRunId, agentRunId: options.agentRunId },
    messages: [
      {
        role: 'user',
        content:
          `GAP: ${gap.title}\n${gap.description}\nAUDIENCE: ${gap.audience}\n\nDOCUMENTS:\n${corpus.slice(0, 60_000)}\n\n` +
          'Return the JSON analysis.',
      },
    ],
  });

  const database = db();
  const insert = database.prepare(
    `INSERT INTO competitors (id, opportunity_id, name, url, platform, pricing, users_estimate, rating,
       strengths, weaknesses, complaints, monetization, evidence_document_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const competitors: Competitor[] = [];
  const tx = database.transaction(() => {
    for (const candidate of data.competitors) {
      const evidence = documents[candidate.sourceIndex];
      const record: Competitor = {
        id: newId('cmp'),
        name: candidate.name,
        url: candidate.url || evidence?.url || '',
        platform: candidate.platform,
        pricing: candidate.pricing,
        usersEstimate: candidate.usersEstimate,
        rating: candidate.rating,
        strengths: candidate.strengths,
        weaknesses: candidate.weaknesses,
        complaints: candidate.complaints,
        monetization: candidate.monetization,
        evidenceDocumentId: evidence?.id ?? null,
      };
      insert.run(
        record.id, opportunityId, record.name, record.url, record.platform, record.pricing, record.usersEstimate,
        record.rating, toJson(record.strengths), toJson(record.weaknesses), toJson(record.complaints),
        record.monetization, record.evidenceDocumentId, nowIso(),
      );
      competitors.push(record);
    }
  });
  tx();

  const rated = competitors.filter((c) => typeof c.rating === 'number');
  const meanRating = rated.length === 0 ? null : rated.reduce((sum, c) => sum + (c.rating as number), 0) / rated.length / 5;

  return {
    competitors,
    differentiation: data.differentiationStrategy,
    saturation: data.saturationAssessment,
    documentsAnalysed: documents.length,
    meanRating,
  };
}

interface CompetitorRow {
  id: string;
  name: string;
  url: string;
  platform: string;
  pricing: string;
  users_estimate: string;
  rating: number | null;
  strengths: string;
  weaknesses: string;
  complaints: string;
  monetization: string;
  evidence_document_id: string | null;
}

export function listCompetitors(opportunityId: string): Competitor[] {
  return db()
    .prepare<[string], CompetitorRow>('SELECT * FROM competitors WHERE opportunity_id = ? ORDER BY created_at')
    .all(opportunityId)
    .map((row) => ({
      id: row.id,
      name: row.name,
      url: row.url,
      platform: row.platform,
      pricing: row.pricing,
      usersEstimate: row.users_estimate,
      rating: row.rating,
      strengths: fromJson<string[]>(row.strengths, []),
      weaknesses: fromJson<string[]>(row.weaknesses, []),
      complaints: fromJson<string[]>(row.complaints, []),
      monetization: row.monetization,
      evidenceDocumentId: row.evidence_document_id,
    }));
}
