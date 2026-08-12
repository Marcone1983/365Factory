import { z } from 'zod';
import { config } from '@/lib/config/env';
import { getLlmProvider } from '@/lib/providers/registry';
import { tokenCost } from '@/lib/providers/pricing';
import { cached } from '@/lib/cache';
import { assertWithinBudget, recordUsage } from './usage';
import { createLogger } from '@/lib/observability/logger';
import { observe } from '@/lib/observability/metrics';
import type { LLMMessage, LLMResponse, LLMToolDefinition, ModelTier } from '@/lib/providers/types';

const log = createLogger('ai.router');

/**
 * AI router.
 *
 * Every LLM call in the platform names a *task*. The task determines the model
 * tier, the output budget, the sampling temperature and the cache policy, so
 * cheap mechanical work never reaches an expensive model and expensive
 * reasoning is never truncated. Adding a capability means adding a task here,
 * not scattering model ids through the codebase.
 */

export type TaskName =
  | 'query_expansion'
  | 'source_triage'
  | 'signal_extraction'
  | 'trend_naming'
  | 'gap_synthesis'
  | 'competitive_analysis'
  | 'product_invention'
  | 'concept_revision'
  | 'architecture_design'
  | 'game_design'
  | 'code_generation'
  | 'code_repair'
  | 'test_authoring'
  | 'asset_briefing'
  | 'asset_recipe'
  | 'asset_review'
  | 'security_review'
  | 'performance_review'
  | 'knowledge_summary'
  | 'chat_orchestration'
  | 'chat_reply';

export interface TaskPolicy {
  readonly tier: ModelTier;
  readonly maxOutputTokens: number;
  readonly temperature: number;
  /** Cache TTL in seconds. 0 disables caching for the task. */
  readonly cacheTtlSeconds: number;
  /** Whether near-identical prompts may reuse a cached completion. */
  readonly semanticCache: boolean;
  readonly description: string;
}

export const TASK_POLICIES: Record<TaskName, TaskPolicy> = {
  query_expansion: { tier: 'fast', maxOutputTokens: 900, temperature: 0.7, cacheTtlSeconds: 21_600, semanticCache: true, description: 'Turn an objective into a set of search queries.' },
  source_triage: { tier: 'fast', maxOutputTokens: 1200, temperature: 0.1, cacheTtlSeconds: 86_400, semanticCache: false, description: 'Decide which fetched sources are worth reading in full.' },
  signal_extraction: { tier: 'fast', maxOutputTokens: 3000, temperature: 0.15, cacheTtlSeconds: 604_800, semanticCache: false, description: 'Extract market signals from a document.' },
  trend_naming: { tier: 'fast', maxOutputTokens: 900, temperature: 0.4, cacheTtlSeconds: 86_400, semanticCache: true, description: 'Name and describe a cluster of signals.' },
  gap_synthesis: { tier: 'balanced', maxOutputTokens: 4000, temperature: 0.3, cacheTtlSeconds: 43_200, semanticCache: true, description: 'Synthesise market gaps from clustered evidence.' },
  competitive_analysis: { tier: 'balanced', maxOutputTokens: 3000, temperature: 0.2, cacheTtlSeconds: 86_400, semanticCache: true, description: 'Build a competitive map from fetched competitor pages.' },
  product_invention: { tier: 'deep', maxOutputTokens: 8000, temperature: 0.85, cacheTtlSeconds: 0, semanticCache: false, description: 'Invent an original product concept from an opportunity.' },
  concept_revision: { tier: 'deep', maxOutputTokens: 8000, temperature: 0.9, cacheTtlSeconds: 0, semanticCache: false, description: 'Differentiate a concept that scored too close to an incumbent.' },
  architecture_design: { tier: 'deep', maxOutputTokens: 8000, temperature: 0.3, cacheTtlSeconds: 0, semanticCache: false, description: 'Design the technical architecture and file plan.' },
  game_design: { tier: 'deep', maxOutputTokens: 8000, temperature: 0.8, cacheTtlSeconds: 0, semanticCache: false, description: 'Design 3D world, systems and gameplay tuning.' },
  code_generation: { tier: 'deep', maxOutputTokens: 16_000, temperature: 0.2, cacheTtlSeconds: 0, semanticCache: false, description: 'Write or modify project source files.' },
  code_repair: { tier: 'deep', maxOutputTokens: 12_000, temperature: 0.1, cacheTtlSeconds: 0, semanticCache: false, description: 'Fix a build, type or test failure.' },
  test_authoring: { tier: 'balanced', maxOutputTokens: 6000, temperature: 0.2, cacheTtlSeconds: 0, semanticCache: false, description: 'Author automated tests for generated code.' },
  asset_briefing: { tier: 'fast', maxOutputTokens: 2500, temperature: 0.8, cacheTtlSeconds: 0, semanticCache: false, description: 'Turn a concept into concrete art direction and asset briefs.' },
  // Writing a recipe is deep work: the brief alone runs to thousands of
  // characters before a single coordinate, and the geometry that follows is
  // long. Temperature is moderate — invention in the design, precision in the
  // numbers.
  // Balanced, not deep, and deliberately so. The expensive model writes a better
  // first draft; it does not write a better *third* one, because what fixes a
  // recipe is the critic looking at the render and saying which step is wrong.
  // Measured on this project, a deep-tier authoring round costs about five times
  // a balanced one — so the same money buys one shot from the best model or a
  // loop of five from a very good one, and the loop wins. Spend on the feedback,
  // not on the single guess.
  asset_recipe: { tier: 'balanced', maxOutputTokens: 20_000, temperature: 0.55, cacheTtlSeconds: 0, semanticCache: false, description: 'Write a full modelling recipe for a requested 3D asset.' },
  // Reviewing renders is a judgement call made against fixed criteria, so it
  // runs cold. It is never cached: the whole point is to look at this asset.
  asset_review: { tier: 'balanced', maxOutputTokens: 9000, temperature: 0.05, cacheTtlSeconds: 0, semanticCache: false, description: 'Grade rendered asset views against the brief that specified them.' },
  security_review: { tier: 'balanced', maxOutputTokens: 4000, temperature: 0.1, cacheTtlSeconds: 0, semanticCache: false, description: 'Review generated code for security defects.' },
  performance_review: { tier: 'balanced', maxOutputTokens: 3000, temperature: 0.2, cacheTtlSeconds: 0, semanticCache: false, description: 'Interpret runtime metrics and propose optimisations.' },
  knowledge_summary: { tier: 'fast', maxOutputTokens: 1500, temperature: 0.3, cacheTtlSeconds: 0, semanticCache: false, description: 'Condense a run outcome into reusable knowledge.' },
  chat_orchestration: { tier: 'balanced', maxOutputTokens: 2000, temperature: 0.2, cacheTtlSeconds: 0, semanticCache: false, description: 'Decide which platform tool a user instruction maps to.' },
  chat_reply: { tier: 'balanced', maxOutputTokens: 3000, temperature: 0.5, cacheTtlSeconds: 0, semanticCache: false, description: 'Answer the operator in natural language.' },
};

export interface CompleteOptions {
  readonly task: TaskName;
  readonly system?: string;
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly LLMToolDefinition[];
  readonly jsonOutput?: boolean;
  readonly maxOutputTokens?: number;
  readonly temperature?: number;
  readonly bypassCache?: boolean;
  readonly context?: { projectId?: string; factoryRunId?: string; agentRunId?: string };
  readonly signal?: AbortSignal;
}

function estimateTokens(text: string): number {
  // Conservative heuristic used only for pre-flight budgeting and prompt
  // trimming; real accounting always uses the provider's reported usage.
  return Math.ceil(text.length / 3.6);
}

export function estimatePromptTokens(options: CompleteOptions): number {
  return (
    estimateTokens(options.system ?? '') +
    options.messages.reduce((n, m) => n + estimateTokens(m.content), 0) +
    (options.tools?.reduce((n, t) => n + estimateTokens(JSON.stringify(t)), 0) ?? 0)
  );
}

export async function complete(options: CompleteOptions): Promise<LLMResponse> {
  const policy = TASK_POLICIES[options.task];
  const provider = getLlmProvider();
  const status = provider.status();
  if (!status.configured) {
    throw new Error(
      `AI reasoning is unavailable: ${status.detail} ` +
        `Set ${status.requires.join(' or ')} to enable the "${options.task}" task.`,
    );
  }
  assertWithinBudget();

  const model = provider.modelFor(policy.tier);
  const maxOutputTokens = options.maxOutputTokens ?? policy.maxOutputTokens;
  const temperature = options.temperature ?? policy.temperature;

  const requestPayload = {
    provider: provider.name,
    model,
    system: options.system ?? '',
    messages: options.messages,
    tools: options.tools ?? [],
    maxOutputTokens,
    temperature,
    jsonOutput: options.jsonOutput ?? false,
  };

  const run = async (): Promise<LLMResponse> => {
    const started = Date.now();
    try {
      const response = await provider.complete(
        {
          system: options.system,
          messages: options.messages,
          tools: options.tools,
          maxOutputTokens,
          temperature,
          model,
          tier: policy.tier,
          jsonOutput: options.jsonOutput,
        },
        options.signal,
      );
      const cost = tokenCost(response.model, response.usage.inputTokens, response.usage.outputTokens);
      recordUsage({
        provider: provider.name,
        kind: 'llm',
        model: response.model,
        operation: options.task,
        tokensIn: response.usage.inputTokens,
        tokensOut: response.usage.outputTokens,
        costUsd: cost.costUsd,
        latencyMs: response.latencyMs,
        projectId: options.context?.projectId,
        factoryRunId: options.context?.factoryRunId,
        agentRunId: options.context?.agentRunId,
      });
      observe('llm.latency', response.latencyMs, { task: options.task, tier: policy.tier });
      return response;
    } catch (error) {
      recordUsage({
        provider: provider.name,
        kind: 'llm',
        model,
        operation: options.task,
        success: false,
        errorCode: (error as { code?: string }).code ?? 'LLM_ERROR',
        latencyMs: Date.now() - started,
        projectId: options.context?.projectId,
        factoryRunId: options.context?.factoryRunId,
        agentRunId: options.context?.agentRunId,
      });
      throw error;
    }
  };

  if (policy.cacheTtlSeconds <= 0 || options.bypassCache) return run();

  const semanticText = policy.semanticCache
    ? `${options.task}\n${options.messages.map((m) => m.content).join('\n')}`.slice(0, 4000)
    : undefined;

  const result = await cached<LLMResponse>(
    requestPayload,
    {
      namespace: 'llm',
      ttlSeconds: policy.cacheTtlSeconds,
      semanticText,
      estimatedCostUsd: tokenCost(model, estimatePromptTokens(options), maxOutputTokens / 2).costUsd,
    },
    run,
  );

  if (result.source !== 'computed') {
    recordUsage({
      provider: provider.name,
      kind: 'llm',
      model,
      operation: options.task,
      cacheHit: result.source === 'semantic' ? 'semantic' : result.source === 'coalesced' ? 'coalesced' : 'exact',
      savedUsd: result.savedUsd,
      projectId: options.context?.projectId,
      factoryRunId: options.context?.factoryRunId,
      agentRunId: options.context?.agentRunId,
    });
  }
  return result.value;
}

// ------------------------------------------------------------- JSON output --

export class JsonContractError extends Error {
  readonly code = 'JSON_CONTRACT';
  constructor(readonly task: TaskName, readonly issues: string, readonly raw: string) {
    super(`Model output for task "${task}" did not satisfy the expected contract: ${issues}`);
    this.name = 'JsonContractError';
  }
}

/** Extracts the first complete JSON value from a model response. */
export function extractJson(text: string): string | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  const candidate = (fenced?.[1] ?? text).trim();
  const start = candidate.search(/[[{]/);
  if (start < 0) return null;
  const open = candidate[start] as string;
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < candidate.length; i += 1) {
    const ch = candidate[i] as string;
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return candidate.slice(start, i + 1);
    }
  }
  return null;
}

export interface JsonCompleteOptions<T> extends Omit<CompleteOptions, 'jsonOutput'> {
  /** Input type is deliberately `unknown` so schemas with defaults keep their parsed output type. */
  readonly schema: z.ZodType<T, z.ZodTypeDef, unknown>;
  /** Extra repair attempts when the model returns malformed or invalid JSON. */
  readonly repairAttempts?: number;
}

/**
 * Requests a JSON object and validates it against a zod schema, feeding
 * validation errors back to the model for a bounded number of repair rounds.
 * Callers therefore always receive well-typed data or a thrown error — never a
 * half-parsed object.
 */
export async function completeJson<T>(options: JsonCompleteOptions<T>): Promise<{ data: T; response: LLMResponse }> {
  const repairAttempts = options.repairAttempts ?? 2;
  const messages: LLMMessage[] = [...options.messages];
  let lastRaw = '';
  let lastIssues = '';

  for (let attempt = 0; attempt <= repairAttempts; attempt += 1) {
    const response = await complete({
      ...options,
      messages,
      jsonOutput: true,
      bypassCache: options.bypassCache || attempt > 0,
    });
    lastRaw = response.text;

    // A response cut off at the output limit is not a model that misunderstood
    // the schema; it is a model that ran out of room mid-sentence. Asking it to
    // "fix the JSON" sends the whole prompt again, produces the same truncation
    // at the same limit, and bills for both. Measured on this project: three
    // rounds, seventy-five cents, no possible outcome but failure.
    if (response.finishReason === 'length') {
      throw new JsonContractError(
        options.task,
        `the model hit its ${options.maxOutputTokens ?? 'configured'}-token output limit and the JSON was cut off mid-value. ` +
          'Raise maxOutputTokens for this task, or ask for a smaller answer. Retrying at the same limit cannot succeed.',
        lastRaw.slice(0, 4000),
      );
    }

    const json = extractJson(response.text);
    if (json) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch (error) {
        lastIssues = `not valid JSON: ${(error as Error).message}`;
        messages.push({ role: 'assistant', content: response.text.slice(0, 2000) });
        messages.push({ role: 'user', content: `That response was ${lastIssues}. Reply with a single valid JSON object only.` });
        continue;
      }
      const validated = options.schema.safeParse(parsed);
      if (validated.success) return { data: validated.data, response };
      lastIssues = validated.error.issues
        .slice(0, 12)
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ');
      log.warn('model output failed schema validation; requesting repair', { task: options.task, attempt, issues: lastIssues });
      messages.push({ role: 'assistant', content: response.text.slice(0, 4000) });
      messages.push({
        role: 'user',
        content: `The JSON did not satisfy the required schema. Fix exactly these problems and return the complete corrected JSON object only:\n${lastIssues}`,
      });
      continue;
    }
    lastIssues = 'response contained no JSON value';
    messages.push({ role: 'assistant', content: response.text.slice(0, 2000) });
    messages.push({ role: 'user', content: 'Reply with a single valid JSON object and nothing else.' });
  }

  throw new JsonContractError(options.task, lastIssues, lastRaw.slice(0, 4000));
}

export function activeModelSummary(): { provider: string; configured: boolean; models: Record<ModelTier, string> } {
  const provider = getLlmProvider();
  return {
    provider: provider.name,
    configured: provider.status().configured,
    models: { fast: provider.modelFor('fast'), balanced: provider.modelFor('balanced'), deep: provider.modelFor('deep') },
  };
}

export function taskCatalogue(): Array<{ task: TaskName } & TaskPolicy> {
  return (Object.keys(TASK_POLICIES) as TaskName[]).map((task) => ({ task, ...TASK_POLICIES[task] }));
}

void config;
