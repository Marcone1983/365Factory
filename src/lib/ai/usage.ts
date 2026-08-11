import { db, newId, nowIso } from '@/lib/db/client';
import { config } from '@/lib/config/env';
import { createLogger } from '@/lib/observability/logger';
import { counter } from '@/lib/observability/metrics';
import { emitEvent } from '@/lib/observability/events';

const log = createLogger('ai.usage');

export type CacheOutcome = 'miss' | 'exact' | 'semantic' | 'coalesced';

export interface UsageRecord {
  readonly provider: string;
  readonly kind: 'llm' | 'embedding' | 'search' | 'image' | 'fetch';
  readonly model?: string;
  readonly operation?: string;
  readonly tokensIn?: number;
  readonly tokensOut?: number;
  readonly units?: number;
  readonly costUsd?: number;
  /** Cost that was avoided because the result came from a cache. */
  readonly savedUsd?: number;
  readonly cacheHit?: CacheOutcome;
  readonly latencyMs?: number;
  readonly success?: boolean;
  readonly errorCode?: string;
  readonly projectId?: string;
  readonly factoryRunId?: string;
  readonly agentRunId?: string;
}

export function recordUsage(record: UsageRecord): void {
  try {
    db()
      .prepare(
        `INSERT INTO api_usage
           (id, ts, provider, kind, model, operation, tokens_in, tokens_out, units, cost_usd, saved_usd,
            cache_hit, latency_ms, success, error_code, project_id, factory_run_id, agent_run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        newId('usg'),
        nowIso(),
        record.provider,
        record.kind,
        record.model ?? '',
        record.operation ?? '',
        record.tokensIn ?? 0,
        record.tokensOut ?? 0,
        record.units ?? 0,
        record.costUsd ?? 0,
        record.savedUsd ?? 0,
        record.cacheHit ?? 'miss',
        record.latencyMs ?? 0,
        record.success === false ? 0 : 1,
        record.errorCode ?? null,
        record.projectId ?? null,
        record.factoryRunId ?? null,
        record.agentRunId ?? null,
      );
  } catch (error) {
    log.error('failed to persist usage record', { error });
  }

  counter('api.calls', { provider: record.provider, kind: record.kind, cache: record.cacheHit ?? 'miss' });
  emitEvent({
    type: 'api.call',
    scope: `provider.${record.provider}`,
    message: `${record.kind} ${record.operation ?? ''} (${record.cacheHit ?? 'miss'})`.trim(),
    runId: record.factoryRunId,
    projectId: record.projectId,
    data: {
      provider: record.provider,
      kind: record.kind,
      model: record.model,
      costUsd: record.costUsd ?? 0,
      savedUsd: record.savedUsd ?? 0,
      cache: record.cacheHit ?? 'miss',
      latencyMs: record.latencyMs ?? 0,
    },
  });
}

export interface UsageTotals {
  readonly calls: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly units: number;
  readonly costUsd: number;
  readonly savedUsd: number;
  readonly cacheHits: number;
  readonly errors: number;
}

const EMPTY: UsageTotals = {
  calls: 0,
  tokensIn: 0,
  tokensOut: 0,
  units: 0,
  costUsd: 0,
  savedUsd: 0,
  cacheHits: 0,
  errors: 0,
};

interface TotalsRow {
  calls: number;
  tokens_in: number | null;
  tokens_out: number | null;
  units: number | null;
  cost: number | null;
  saved: number | null;
  hits: number | null;
  errors: number | null;
}

function mapTotals(row: TotalsRow | undefined): UsageTotals {
  if (!row) return EMPTY;
  return {
    calls: row.calls ?? 0,
    tokensIn: row.tokens_in ?? 0,
    tokensOut: row.tokens_out ?? 0,
    units: row.units ?? 0,
    costUsd: row.cost ?? 0,
    savedUsd: row.saved ?? 0,
    cacheHits: row.hits ?? 0,
    errors: row.errors ?? 0,
  };
}

const TOTALS_SELECT = `
  SELECT COUNT(*) AS calls,
         SUM(tokens_in) AS tokens_in,
         SUM(tokens_out) AS tokens_out,
         SUM(units) AS units,
         SUM(cost_usd) AS cost,
         SUM(saved_usd) AS saved,
         SUM(CASE WHEN cache_hit != 'miss' THEN 1 ELSE 0 END) AS hits,
         SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS errors
  FROM api_usage`;

export function usageSince(sinceIso: string): UsageTotals {
  return mapTotals(db().prepare<[string], TotalsRow>(`${TOTALS_SELECT} WHERE ts >= ?`).get(sinceIso));
}

export function usageForProject(projectId: string): UsageTotals {
  return mapTotals(db().prepare<[string], TotalsRow>(`${TOTALS_SELECT} WHERE project_id = ?`).get(projectId));
}

export function usageForRun(runId: string): UsageTotals {
  return mapTotals(db().prepare<[string], TotalsRow>(`${TOTALS_SELECT} WHERE factory_run_id = ?`).get(runId));
}

export function startOfUtcDay(date = new Date()): string {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

// ------------------------------------------------------------------ budgets --

export class BudgetExceededError extends Error {
  readonly status = 429;
  readonly code = 'BUDGET_EXCEEDED';
  constructor(readonly kind: 'tokens' | 'cost', readonly used: number, readonly limit: number) {
    super(
      `Daily ${kind} budget exhausted (${used.toFixed(kind === 'cost' ? 4 : 0)} of ${limit}). ` +
        'Raise LLM_DAILY_TOKEN_BUDGET / LLM_DAILY_COST_BUDGET_USD or wait for the next UTC day.',
    );
    this.name = 'BudgetExceededError';
  }
}

export interface BudgetState {
  readonly tokensUsed: number;
  readonly tokenLimit: number;
  readonly costUsed: number;
  readonly costLimit: number;
  readonly tokensRemaining: number;
  readonly costRemaining: number;
}

export function budgetState(): BudgetState {
  const cfg = config();
  const today = usageSince(startOfUtcDay());
  const tokensUsed = today.tokensIn + today.tokensOut;
  return {
    tokensUsed,
    tokenLimit: cfg.LLM_DAILY_TOKEN_BUDGET,
    costUsed: today.costUsd,
    costLimit: cfg.LLM_DAILY_COST_BUDGET_USD,
    tokensRemaining: Math.max(0, cfg.LLM_DAILY_TOKEN_BUDGET - tokensUsed),
    costRemaining: Math.max(0, cfg.LLM_DAILY_COST_BUDGET_USD - today.costUsd),
  };
}

/** Throws before an expensive call when the daily budget is already exhausted. */
export function assertWithinBudget(): void {
  const state = budgetState();
  if (state.tokenLimit > 0 && state.tokensUsed >= state.tokenLimit) {
    throw new BudgetExceededError('tokens', state.tokensUsed, state.tokenLimit);
  }
  if (state.costLimit > 0 && state.costUsed >= state.costLimit) {
    throw new BudgetExceededError('cost', state.costUsed, state.costLimit);
  }
}

// ------------------------------------------------------------- breakdowns --

export interface UsageBreakdownRow {
  readonly key: string;
  readonly calls: number;
  readonly costUsd: number;
  readonly savedUsd: number;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly cacheHits: number;
  readonly errors: number;
  readonly p50LatencyMs: number;
}

const BREAKDOWN_COLUMNS = `
  COUNT(*) AS calls,
  COALESCE(SUM(cost_usd), 0) AS costUsd,
  COALESCE(SUM(saved_usd), 0) AS savedUsd,
  COALESCE(SUM(tokens_in), 0) AS tokensIn,
  COALESCE(SUM(tokens_out), 0) AS tokensOut,
  COALESCE(SUM(CASE WHEN cache_hit != 'miss' THEN 1 ELSE 0 END), 0) AS cacheHits,
  COALESCE(SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END), 0) AS errors,
  COALESCE(CAST(AVG(latency_ms) AS INTEGER), 0) AS p50LatencyMs`;

/**
 * Spend grouped by a recorded column. Only a fixed set of columns is groupable:
 * the column name is chosen from this map, never interpolated from a caller's
 * string, so no query text can originate outside this module.
 */
const GROUPABLE = {
  operation: 'operation',
  model: 'model',
  provider: 'provider',
  kind: 'kind',
} as const;

export type UsageGroup = keyof typeof GROUPABLE;

export function usageBreakdown(group: UsageGroup, sinceIso: string, limit = 20): UsageBreakdownRow[] {
  const column = GROUPABLE[group];
  return db()
    .prepare<[string, number], UsageBreakdownRow>(
      `SELECT ${column} AS key, ${BREAKDOWN_COLUMNS}
       FROM api_usage WHERE ts >= ? AND ${column} != ''
       GROUP BY ${column} ORDER BY costUsd DESC, calls DESC LIMIT ?`,
    )
    .all(sinceIso, limit);
}

export interface DailyUsagePoint {
  readonly day: string;
  readonly calls: number;
  readonly costUsd: number;
  readonly savedUsd: number;
}

/** Daily totals for the cost chart, oldest first. */
export function dailyUsage(days = 14): DailyUsagePoint[] {
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  return db()
    .prepare<[string], DailyUsagePoint>(
      `SELECT substr(ts, 1, 10) AS day,
              COUNT(*) AS calls,
              COALESCE(SUM(cost_usd), 0) AS costUsd,
              COALESCE(SUM(saved_usd), 0) AS savedUsd
       FROM api_usage WHERE ts >= ?
       GROUP BY day ORDER BY day ASC`,
    )
    .all(since);
}

export interface UsageFailure {
  readonly ts: string;
  readonly provider: string;
  readonly operation: string;
  readonly model: string;
  readonly errorCode: string | null;
}

export function recentFailures(limit = 10): UsageFailure[] {
  return db()
    .prepare<[number], UsageFailure>(
      `SELECT ts, provider, operation, model, error_code AS errorCode
       FROM api_usage WHERE success = 0 ORDER BY ts DESC LIMIT ?`,
    )
    .all(limit);
}
