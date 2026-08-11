import fs from 'node:fs';
import path from 'node:path';
import { config } from '@/lib/config/env';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('providers.pricing');

/**
 * Cost model.
 *
 * Vendor prices change; this table is a *default* that the operator overrides by
 * dropping a `pricing.json` into DATA_DIR. When a model is unknown the platform
 * reports `known: false` and a zero cost rather than inventing a number — the
 * cost dashboard shows those calls separately as "unpriced".
 */

export interface TokenPrice {
  /** USD per 1,000,000 input tokens. */
  readonly inputPerMillion: number;
  /** USD per 1,000,000 output tokens. */
  readonly outputPerMillion: number;
}

export interface UnitPrice {
  /** USD per single unit (one search query, one generated image). */
  readonly perUnit: number;
}

interface PricingTable {
  readonly tokens: Record<string, TokenPrice>;
  readonly units: Record<string, UnitPrice>;
}

const DEFAULT_PRICING: PricingTable = {
  tokens: {
    'claude-opus-5': { inputPerMillion: 15, outputPerMillion: 75 },
    'claude-sonnet-5': { inputPerMillion: 3, outputPerMillion: 15 },
    'claude-haiku-4-5-20251001': { inputPerMillion: 1, outputPerMillion: 5 },
    'gpt-4o': { inputPerMillion: 2.5, outputPerMillion: 10 },
    'gpt-4o-mini': { inputPerMillion: 0.15, outputPerMillion: 0.6 },
    'text-embedding-3-small': { inputPerMillion: 0.02, outputPerMillion: 0 },
    'text-embedding-3-large': { inputPerMillion: 0.13, outputPerMillion: 0 },
    'local-hashed-ngram': { inputPerMillion: 0, outputPerMillion: 0 },
  },
  units: {
    'search:brave': { perUnit: 0.005 },
    'search:tavily': { perUnit: 0.008 },
    'search:serper': { perUnit: 0.001 },
    'search:searxng': { perUnit: 0 },
    'image:gpt-image-1': { perUnit: 0.04 },
    'image:sd3.5-medium': { perUnit: 0.035 },
    'image:procedural': { perUnit: 0 },
  },
};

let table: PricingTable | null = null;

function loadTable(): PricingTable {
  if (table) return table;
  const file = path.join(config().dataDir, 'pricing.json');
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const parsed = JSON.parse(raw) as Partial<PricingTable>;
    table = {
      tokens: { ...DEFAULT_PRICING.tokens, ...(parsed.tokens ?? {}) },
      units: { ...DEFAULT_PRICING.units, ...(parsed.units ?? {}) },
    };
    log.info('loaded pricing overrides', { file });
  } catch {
    table = DEFAULT_PRICING;
  }
  return table;
}

export function resetPricingCache(): void {
  table = null;
}

export interface CostEstimate {
  readonly costUsd: number;
  readonly known: boolean;
}

export function tokenCost(model: string, inputTokens: number, outputTokens: number): CostEstimate {
  const price = loadTable().tokens[model];
  if (!price) return { costUsd: 0, known: false };
  return {
    costUsd: (inputTokens / 1_000_000) * price.inputPerMillion + (outputTokens / 1_000_000) * price.outputPerMillion,
    known: true,
  };
}

export function unitCost(unitKey: string, units: number): CostEstimate {
  const price = loadTable().units[unitKey];
  if (!price) return { costUsd: 0, known: false };
  return { costUsd: price.perUnit * units, known: true };
}

export function pricingTable(): PricingTable {
  return loadTable();
}
