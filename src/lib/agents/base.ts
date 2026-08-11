import { db, newId, nowIso, toJson } from '@/lib/db/client';
import { createLogger, type Logger } from '@/lib/observability/logger';
import { emitEvent } from '@/lib/observability/events';
import { counter, observe } from '@/lib/observability/metrics';
import { usageForRun } from '@/lib/ai/usage';
import { withTimeout } from '@/lib/util/pool';

/**
 * Agent runtime.
 *
 * Every agent execution is a persisted, resumable unit of work: it gets a row
 * in `agent_runs` before it starts, records its input, output, attempts, token
 * cost and duration, and streams progress to the live activity feed. Retries use
 * exponential backoff and only apply to failures the agent itself declares
 * retryable, so a schema violation is not retried thirty times.
 */

export interface AgentContext {
  readonly factoryRunId?: string;
  readonly projectId?: string;
  readonly step: string;
  readonly signal?: AbortSignal;
  readonly logger: Logger;
  /** Persisted progress marker so a resumed run can skip completed work. */
  checkpoint(data: Record<string, unknown>): void;
  progress(message: string, data?: Record<string, unknown>): void;
}

export class AgentError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly code = 'AGENT_ERROR',
  ) {
    super(message);
    this.name = 'AgentError';
  }
}

export interface AgentResult<O> {
  readonly output: O;
  readonly agentRunId: string;
  readonly attempts: number;
  readonly durationMs: number;
}

export interface AgentOptions {
  readonly maxAttempts?: number;
  readonly timeoutMs?: number;
}

export abstract class Agent<I, O> {
  abstract readonly name: string;
  abstract readonly description: string;
  protected readonly options: Required<AgentOptions>;

  constructor(options: AgentOptions = {}) {
    this.options = {
      maxAttempts: options.maxAttempts ?? 2,
      timeoutMs: options.timeoutMs ?? 900_000,
    };
  }

  /** The agent's actual work. Throw `AgentError` to control retry behaviour. */
  protected abstract execute(input: I, context: AgentContext): Promise<O>;

  async run(input: I, context: Omit<AgentContext, 'logger' | 'checkpoint' | 'progress'>): Promise<AgentResult<O>> {
    const agentRunId = newId('arn');
    const logger = createLogger(`agent.${this.name}`, { agentRunId, runId: context.factoryRunId });
    const startedAt = Date.now();

    db()
      .prepare(
        `INSERT INTO agent_runs (id, factory_run_id, project_id, agent_name, step, status, input, started_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'RUNNING', ?, ?, ?)`,
      )
      .run(agentRunId, context.factoryRunId ?? null, context.projectId ?? null, this.name, context.step, toJson(truncate(input)), nowIso(), nowIso());

    emitEvent({
      type: 'agent.started',
      scope: `agent.${this.name}`,
      runId: context.factoryRunId,
      projectId: context.projectId,
      message: `${this.name}: ${this.description}`,
      data: { step: context.step, agentRunId },
    });

    const fullContext: AgentContext = {
      ...context,
      logger,
      checkpoint: (data) => {
        if (!context.factoryRunId) return;
        db().prepare('UPDATE factory_runs SET checkpoint = ?, current_step = ? WHERE id = ?')
          .run(toJson(data), context.step, context.factoryRunId);
      },
      progress: (message, data) => {
        db().prepare('INSERT INTO agent_messages (id, agent_run_id, role, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(newId('amg'), agentRunId, 'progress', message, toJson(data ?? {}), nowIso());
        emitEvent({
          type: 'agent.progress',
          scope: `agent.${this.name}`,
          runId: context.factoryRunId,
          projectId: context.projectId,
          message,
          data,
        });
      },
    };

    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt += 1) {
      if (context.signal?.aborted) {
        lastError = new AgentError('run cancelled', false, 'CANCELLED');
        break;
      }
      try {
        const output = await withTimeout(this.execute(input, fullContext), this.options.timeoutMs, `${this.name} agent`);
        const durationMs = Date.now() - startedAt;
        const usage = context.factoryRunId ? usageForRun(context.factoryRunId) : null;

        db()
          .prepare(
            `UPDATE agent_runs SET status = 'SUCCEEDED', output = ?, attempts = ?, duration_ms = ?,
               tokens_in = ?, tokens_out = ?, cost_usd = ?, finished_at = ? WHERE id = ?`,
          )
          .run(toJson(truncate(output)), attempt, durationMs, usage?.tokensIn ?? 0, usage?.tokensOut ?? 0, usage?.costUsd ?? 0, nowIso(), agentRunId);

        observe('agent.duration', durationMs, { agent: this.name, outcome: 'success' });
        counter('agent.runs', { agent: this.name, outcome: 'success' });
        emitEvent({
          type: 'agent.finished',
          scope: `agent.${this.name}`,
          runId: context.factoryRunId,
          projectId: context.projectId,
          message: `${this.name} completed in ${(durationMs / 1000).toFixed(1)}s`,
          data: { step: context.step, attempts: attempt, durationMs },
        });
        return { output, agentRunId, attempts: attempt, durationMs };
      } catch (error) {
        lastError = error as Error;
        const retryable = error instanceof AgentError ? error.retryable : isTransient(error as Error);
        logger.warn('agent attempt failed', { attempt, retryable, error: lastError.message });
        if (!retryable || attempt === this.options.maxAttempts) break;
        const backoff = Math.min(2000 * 2 ** (attempt - 1), 20_000) + Math.floor(Math.random() * 400);
        await new Promise((resolve) => setTimeout(resolve, backoff));
      }
    }

    const durationMs = Date.now() - startedAt;
    db()
      .prepare("UPDATE agent_runs SET status = 'FAILED', error = ?, attempts = ?, duration_ms = ?, finished_at = ? WHERE id = ?")
      .run(lastError?.message ?? 'unknown failure', this.options.maxAttempts, durationMs, nowIso(), agentRunId);
    observe('agent.duration', durationMs, { agent: this.name, outcome: 'failure' });
    counter('agent.runs', { agent: this.name, outcome: 'failure' });
    emitEvent({
      type: 'agent.failed',
      scope: `agent.${this.name}`,
      runId: context.factoryRunId,
      projectId: context.projectId,
      message: `${this.name} failed: ${lastError?.message ?? 'unknown failure'}`,
      data: { step: context.step },
    });
    throw lastError ?? new AgentError(`${this.name} failed`, false);
  }
}

/** Network blips, rate limits and timeouts are retried; contract errors are not. */
function isTransient(error: Error): boolean {
  const message = error.message.toLowerCase();
  if (error.name === 'TimeoutError') return true;
  if (/rate limit|429|502|503|504|timeout|socket hang up|econnreset|etimedout|fetch failed/.test(message)) return true;
  if (/circuit breaker open/.test(message)) return true;
  return false;
}

function truncate(value: unknown, maxLength = 24_000): unknown {
  const json = JSON.stringify(value ?? null);
  if (json.length <= maxLength) return value;
  return { truncated: true, preview: json.slice(0, maxLength) };
}

export interface AgentRunSummary {
  readonly id: string;
  readonly agentName: string;
  readonly step: string;
  readonly status: string;
  readonly attempts: number;
  readonly durationMs: number;
  readonly error: string | null;
  readonly createdAt: string;
}

export function listAgentRuns(factoryRunId: string): AgentRunSummary[] {
  return db()
    .prepare<[string], {
      id: string; agent_name: string; step: string; status: string; attempts: number;
      duration_ms: number; error: string | null; created_at: string;
    }>('SELECT * FROM agent_runs WHERE factory_run_id = ? ORDER BY created_at')
    .all(factoryRunId)
    .map((row) => ({
      id: row.id,
      agentName: row.agent_name,
      step: row.step,
      status: row.status,
      attempts: row.attempts,
      durationMs: row.duration_ms,
      error: row.error,
      createdAt: row.created_at,
    }));
}

export function agentMessages(agentRunId: string, limit = 200): Array<{ role: string; content: string; createdAt: string }> {
  return db()
    .prepare<[string, number], { role: string; content: string; created_at: string }>(
      'SELECT role, content, created_at FROM agent_messages WHERE agent_run_id = ? ORDER BY created_at LIMIT ?',
    )
    .all(agentRunId, limit)
    .map((row) => ({ role: row.role, content: row.content, createdAt: row.created_at }));
}
