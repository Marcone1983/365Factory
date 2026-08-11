import { z } from 'zod';
import { db, fromJson, newId, nowIso, toJson } from '@/lib/db/client';
import { completeJson } from '@/lib/ai/router';
import { mapPool } from '@/lib/util/pool';
import { config } from '@/lib/config/env';
import { createLogger } from '@/lib/observability/logger';
import { counter } from '@/lib/observability/metrics';
import { analyze } from '@/lib/research/analyze';
import type { ResearchDocument } from '@/lib/research/store';

const log = createLogger('market.signals');

/**
 * Market signal extraction.
 *
 * A signal is one atomic, attributable observation about the market taken from
 * exactly one document. Every signal must carry a verbatim quote from that
 * document; quotes that cannot be located in the source text are rejected
 * outright, which is the platform's primary defence against fabricated evidence.
 */

export const SIGNAL_KINDS = [
  'unmet_need',
  'complaint',
  'demand',
  'growth',
  'pricing_objection',
  'ux_failure',
  'missing_feature',
  'emerging_technology',
  'fragmentation',
  'competitor',
  'regulatory',
] as const;

export type SignalKind = (typeof SIGNAL_KINDS)[number];

const SignalSchema = z.object({
  kind: z.enum(SIGNAL_KINDS),
  statement: z.string().min(12).max(400),
  subject: z.string().max(160).default(''),
  audience: z.string().max(160).default(''),
  keywords: z.array(z.string().max(60)).max(10).default([]),
  intensity: z.number().min(0).max(1),
  evidenceQuote: z.string().min(12).max(600),
});

const ExtractionSchema = z.object({
  signals: z.array(SignalSchema).max(12),
});

export interface MarketSignal {
  readonly id: string;
  readonly documentId: string;
  readonly kind: SignalKind;
  readonly statement: string;
  readonly subject: string;
  readonly audience: string;
  readonly category: string;
  readonly keywords: string[];
  readonly sentiment: number;
  readonly intensity: number;
  readonly evidenceQuote: string;
  readonly confidence: number;
}

interface SignalRow {
  id: string;
  document_id: string;
  factory_run_id: string | null;
  kind: string;
  statement: string;
  subject: string;
  audience: string;
  category: string;
  keywords: string;
  sentiment: number;
  intensity: number;
  evidence_quote: string;
  confidence: number;
  created_at: string;
}

function toSignal(row: SignalRow): MarketSignal {
  return {
    id: row.id,
    documentId: row.document_id,
    kind: row.kind as SignalKind,
    statement: row.statement,
    subject: row.subject,
    audience: row.audience,
    category: row.category,
    keywords: fromJson<string[]>(row.keywords, []),
    sentiment: row.sentiment,
    intensity: row.intensity,
    evidenceQuote: row.evidence_quote,
    confidence: row.confidence,
  };
}

/** Normalises whitespace and case so quote verification tolerates re-wrapping. */
function normalise(text: string): string {
  return text.toLowerCase().replace(/[\s ]+/g, ' ').replace(/[“”„‟"'’‘`]/g, '"').trim();
}

/**
 * Verifies that a quote genuinely appears in the source document. Exact match
 * first; then a token-overlap fallback that tolerates ellipsis and minor
 * truncation, which models commonly introduce. Anything below the overlap
 * threshold is treated as fabricated.
 */
export function verifyQuote(quote: string, documentText: string): { verified: boolean; overlap: number } {
  const haystack = normalise(documentText);
  const needle = normalise(quote);
  if (needle.length < 10) return { verified: false, overlap: 0 };
  if (haystack.includes(needle)) return { verified: true, overlap: 1 };

  const tokens = needle.split(' ').filter((t) => t.length > 3);
  if (tokens.length === 0) return { verified: false, overlap: 0 };
  const present = tokens.filter((t) => haystack.includes(t)).length;
  const overlap = present / tokens.length;

  // Require a contiguous anchor as well, so a bag of common words cannot pass.
  const anchorLength = Math.min(40, Math.max(18, Math.floor(needle.length * 0.3)));
  let anchored = false;
  for (let i = 0; i + anchorLength <= needle.length; i += 8) {
    if (haystack.includes(needle.slice(i, i + anchorLength))) {
      anchored = true;
      break;
    }
  }
  return { verified: overlap >= 0.82 && anchored, overlap };
}

const SYSTEM_PROMPT = `You are a market research analyst extracting atomic market signals from a single source document.

Rules you must follow exactly:
- Only report what the document itself states or clearly demonstrates. Never infer facts that are not present.
- Every signal must include "evidenceQuote": a VERBATIM span copied from the document text. Do not paraphrase quotes, do not merge sentences, do not add ellipses.
- If the document contains no genuine market signal, return an empty "signals" array. An empty result is a correct and expected answer.
- "intensity" is how strongly the document expresses the signal: 0.1 = passing mention, 1.0 = the whole document is about this problem.
- Prefer first-hand user voice (complaints, requests, reviews) over commentary.
- Never invent product names, statistics, user counts or dates.`;

export interface ExtractSignalsOptions {
  readonly factoryRunId?: string;
  readonly agentRunId?: string;
  readonly maxPerDocument?: number;
  readonly signal?: AbortSignal;
}

export interface ExtractSignalsResult {
  readonly signals: readonly MarketSignal[];
  readonly rejectedQuotes: number;
  readonly documentsProcessed: number;
}

export async function extractSignals(
  documents: readonly ResearchDocument[],
  options: ExtractSignalsOptions = {},
): Promise<ExtractSignalsResult> {
  if (documents.length === 0) return { signals: [], rejectedQuotes: 0, documentsProcessed: 0 };
  const cfg = config();
  const stored: MarketSignal[] = [];
  let rejected = 0;

  const results = await mapPool(documents, Math.max(2, Math.floor(cfg.RESEARCH_MAX_CONCURRENCY / 2)), async (document) => {
    const body = document.content.slice(0, 12_000);
    const { data } = await completeJson({
      task: 'signal_extraction',
      schema: ExtractionSchema,
      system: SYSTEM_PROMPT,
      signal: options.signal,
      context: { factoryRunId: options.factoryRunId, agentRunId: options.agentRunId },
      messages: [
        {
          role: 'user',
          content:
            `SOURCE: ${document.url}\n` +
            `SOURCE CLASS: ${document.category}\n` +
            `TITLE: ${document.title}\n` +
            `PUBLISHED: ${document.publishedAt ?? 'unknown'}\n\n` +
            `DOCUMENT TEXT:\n${body}\n\n` +
            `Extract at most ${options.maxPerDocument ?? 6} market signals as JSON: ` +
            `{"signals":[{"kind":..., "statement":..., "subject":..., "audience":..., "keywords":[...], "intensity":0..1, "evidenceQuote":"verbatim span"}]}`,
        },
      ],
    });

    const accepted: MarketSignal[] = [];
    for (const candidate of data.signals) {
      const check = verifyQuote(candidate.evidenceQuote, `${document.title}\n${document.content}`);
      if (!check.verified) {
        rejected += 1;
        counter('signals.quote_rejected', { category: document.category });
        log.warn('rejected a signal whose quote is not present in the source', {
          documentId: document.id,
          overlap: Number(check.overlap.toFixed(2)),
        });
        continue;
      }
      const sentiment = analyze(candidate.evidenceQuote).sentiment;
      accepted.push({
        id: newId('sig'),
        documentId: document.id,
        kind: candidate.kind,
        statement: candidate.statement,
        subject: candidate.subject,
        audience: candidate.audience,
        category: document.category,
        keywords: candidate.keywords,
        sentiment,
        intensity: candidate.intensity,
        evidenceQuote: candidate.evidenceQuote,
        // A signal is never more trustworthy than the document it came from.
        confidence: Number((document.confidence * (0.6 + 0.4 * check.overlap)).toFixed(4)),
      });
    }
    return accepted;
  });

  const database = db();
  const insert = database.prepare(
    `INSERT INTO market_signals
       (id, document_id, factory_run_id, kind, statement, subject, audience, category, keywords, sentiment, intensity, evidence_quote, confidence, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const tx = database.transaction((batch: MarketSignal[]) => {
    for (const s of batch) {
      insert.run(
        s.id, s.documentId, options.factoryRunId ?? null, s.kind, s.statement, s.subject, s.audience,
        s.category, toJson(s.keywords), s.sentiment, s.intensity, s.evidenceQuote, s.confidence, nowIso(),
      );
    }
  });

  for (const result of results) {
    if (result.status === 'fulfilled') {
      tx(result.value);
      stored.push(...result.value);
    } else {
      log.warn('signal extraction failed for a document', { error: (result.reason as Error).message });
    }
  }

  counter('signals.extracted', {}, stored.length);
  return { signals: stored, rejectedQuotes: rejected, documentsProcessed: documents.length };
}

export function listSignals(options: { factoryRunId?: string; limit?: number } = {}): MarketSignal[] {
  const limit = Math.min(options.limit ?? 500, 5000);
  if (options.factoryRunId) {
    return db()
      .prepare<[string, number], SignalRow>('SELECT * FROM market_signals WHERE factory_run_id = ? ORDER BY created_at DESC LIMIT ?')
      .all(options.factoryRunId, limit)
      .map(toSignal);
  }
  return db()
    .prepare<[number], SignalRow>('SELECT * FROM market_signals ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map(toSignal);
}

export function getSignals(ids: readonly string[]): MarketSignal[] {
  if (ids.length === 0) return [];
  const placeholders = ids.map(() => '?').join(',');
  return db()
    .prepare<string[], SignalRow>(`SELECT * FROM market_signals WHERE id IN (${placeholders})`)
    .all(...ids)
    .map(toSignal);
}
