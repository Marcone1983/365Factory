import { z } from 'zod';
import type { LLMToolDefinition } from '@/lib/providers/types';
import type { Permission } from '@/lib/security/rbac';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('chat.tools');

/**
 * The tools the chat agent may call.
 *
 * Every tool is a named function with a validated input schema and an explicit
 * permission. The model chooses which to call; it never supplies code, a query
 * string that reaches a database, or a path that reaches a filesystem. That is
 * the boundary: the model's output selects behaviour from this list, it never
 * becomes behaviour.
 *
 * Tools are split into read tools, which any authenticated operator may use, and
 * write tools, which start real work and cost real money — those are gated on a
 * permission and are refused rather than silently downgraded when it is absent.
 */

export interface ToolContext {
  readonly userId: string;
  readonly permissions: readonly Permission[];
  readonly signal: AbortSignal;
}

export interface ToolResult {
  /** Rendered for the model. Kept compact: this goes back through the context. */
  readonly summary: string;
  /** Structured payload the UI renders as a card. */
  readonly data?: Record<string, unknown>;
}

export interface ChatTool<S extends z.ZodTypeAny = z.ZodTypeAny> {
  readonly name: string;
  readonly description: string;
  readonly schema: S;
  /** Permission required to run it; read-only tools declare none. */
  readonly permission?: Permission;
  run(input: z.infer<S>, ctx: ToolContext): Promise<ToolResult>;
}

function money(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

const NO_ARGS = z.object({}).strict();

// --------------------------------------------------------------- read tools --

const listOpportunitiesTool: ChatTool = {
  name: 'list_opportunities',
  description:
    'List scored market opportunities the factory has already discovered, best first. Use this to answer questions about what the factory found, what it is considering building, or how an opportunity scored.',
  schema: z.object({ limit: z.number().int().min(1).max(25).default(8) }).strict(),
  async run(input) {
    const { listOpportunities, acceptanceThreshold } = await import('@/lib/market/gaps');
    const rows = listOpportunities({ limit: input.limit as number });
    if (rows.length === 0) {
      return { summary: 'No opportunities have been scored yet. A discovery run has to happen first.' };
    }
    const threshold = acceptanceThreshold();
    const lines = rows.map(
      (o, i) =>
        `${i + 1}. ${o.title} — score ${o.opportunityScore.toFixed(3)} (${o.opportunityScore >= threshold ? 'above' : 'below'} the ${threshold} acceptance threshold), status ${o.status}`,
    );
    return {
      summary: `${rows.length} scored opportunities:\n${lines.join('\n')}`,
      data: { opportunities: rows, threshold },
    };
  },
};

const listTrendsTool: ChatTool = {
  name: 'list_trends',
  description: 'List detected market trends with their momentum. Use this for "what is trending" or "what is the factory seeing" questions.',
  schema: z.object({ limit: z.number().int().min(1).max(25).default(10) }).strict(),
  async run(input) {
    const { listTrends } = await import('@/lib/market/trends');
    const rows = listTrends(input.limit as number);
    if (rows.length === 0) return { summary: 'No trends have been detected yet.' };
    return {
      summary: rows.map((t) => `${t.label} — momentum ${t.momentum.toFixed(3)}, ${t.signalCount} signals`).join('\n'),
      data: { trends: rows },
    };
  },
};

const searchResearchTool: ChatTool = {
  name: 'search_research',
  description:
    'Full-text search the research documents the factory has actually fetched and indexed. Returns real stored documents with their URLs. Use this to ground any factual claim about what was researched.',
  schema: z.object({ query: z.string().min(2).max(200), limit: z.number().int().min(1).max(15).default(6) }).strict(),
  async run(input) {
    const { searchDocuments } = await import('@/lib/research/store');
    const docs = searchDocuments(input.query as string, input.limit as number);
    if (docs.length === 0) {
      return { summary: `No indexed research document matches "${input.query as string}".` };
    }
    return {
      summary: docs.map((d) => `- ${d.title} (${d.url})`).join('\n'),
      data: { documents: docs.map((d) => ({ id: d.id, title: d.title, url: d.url, fetchedAt: d.fetchedAt })) },
    };
  },
};

const listProjectsTool: ChatTool = {
  name: 'list_projects',
  description: 'List products in the workspace with their status. Use this to answer "what has been built" questions.',
  schema: z.object({ limit: z.number().int().min(1).max(25).default(10) }).strict(),
  async run(input) {
    const { listProjects } = await import('@/lib/workspace/project');
    const rows = listProjects({ limit: input.limit as number });
    if (rows.length === 0) return { summary: 'The workspace has no products yet.' };
    return {
      summary: rows.map((p) => `${p.name} (${p.slug}) — ${p.status}, ${p.kind}`).join('\n'),
      data: { projects: rows.map((p) => ({ id: p.id, name: p.name, slug: p.slug, status: p.status, kind: p.kind })) },
    };
  },
};

const projectDetailTool: ChatTool = {
  name: 'get_project',
  description: 'Full detail for one product: status, versions, assets, builds and preview state. Takes a project id or slug.',
  schema: z.object({ project: z.string().min(1) }).strict(),
  async run(input) {
    const { getProject, getProjectBySlug, listVersions } = await import('@/lib/workspace/project');
    const key = input.project as string;
    const project = getProject(key) ?? getProjectBySlug(key);
    if (!project) return { summary: `No product matches "${key}".` };

    const versions = listVersions(project.id);
    const { listIndexedFiles } = await import('@/lib/ide/repo-index');
    const files = listIndexedFiles(project.id);

    return {
      summary: [
        `${project.name} (${project.slug})`,
        `status: ${project.status}, kind: ${project.kind}`,
        `${versions.length} versions, ${files.length} indexed source files`,
      ].join('\n'),
      data: {
        project: { id: project.id, name: project.name, slug: project.slug, status: project.status, kind: project.kind },
        versions: versions.slice(0, 10),
        fileCount: files.length,
      },
    };
  },
};

const readFileTool: ChatTool = {
  name: 'read_project_file',
  description:
    'Read one source file from a product workspace. The path is resolved inside that workspace and cannot escape it.',
  schema: z.object({ project: z.string().min(1), path: z.string().min(1).max(400) }).strict(),
  async run(input) {
    const { getProject, getProjectBySlug, workspaceFor } = await import('@/lib/workspace/project');
    const key = input.project as string;
    const project = getProject(key) ?? getProjectBySlug(key);
    if (!project) return { summary: `No product matches "${key}".` };

    try {
      // The workspace layer enforces containment; a traversal throws here rather
      // than returning a file from outside the jail.
      const source = workspaceFor(project, 'source');
      const content = source.readText(input.path as string);
      const clipped = content.length > 12_000 ? `${content.slice(0, 12_000)}\n… [truncated]` : content;
      return {
        summary: `${input.path as string} (${content.length} bytes):\n\`\`\`\n${clipped}\n\`\`\``,
        data: { path: input.path, bytes: content.length },
      };
    } catch (error) {
      return { summary: `Could not read ${input.path as string}: ${(error as Error).message}` };
    }
  },
};

const runStatusTool: ChatTool = {
  name: 'get_run_status',
  description: 'Status of factory runs — what is running now, what finished, what failed and why.',
  schema: z.object({ limit: z.number().int().min(1).max(15).default(5) }).strict(),
  async run(input) {
    const { listRuns } = await import('@/lib/orchestrator/factory');
    const runs = listRuns(input.limit as number);
    if (runs.length === 0) return { summary: 'No factory runs have been started yet.' };
    return {
      summary: runs
        .map((r) => `${r.id} — ${r.status}${r.currentStep ? ` at "${r.currentStep}"` : ''}${r.error ? `: ${r.error}` : ''}`)
        .join('\n'),
      data: { runs },
    };
  },
};

const costTool: ChatTool = {
  name: 'get_cost_report',
  description: 'Real API spend and cache savings from recorded usage, plus the remaining daily budget.',
  schema: NO_ARGS,
  async run() {
    const { budgetState, usageSince, startOfUtcDay } = await import('@/lib/ai/usage');
    const { cacheStats } = await import('@/lib/cache');
    const today = usageSince(startOfUtcDay());
    const budget = budgetState();
    const cache = cacheStats();

    return {
      summary: [
        `Today: ${today.calls} API calls, ${money(today.costUsd)} spent, ${money(today.savedUsd)} avoided by caching.`,
        `Budget: ${money(budget.costUsed)} of ${money(budget.costLimit)} used, ${money(budget.costRemaining)} remaining; ${budget.tokensUsed} of ${budget.tokenLimit} tokens.`,
        `Cache: ${cache.l2Entries} stored entries across ${cache.namespaces.length} namespaces, ${cache.totalHits} hits.`,
      ].join('\n'),
      data: { today, budget, cache: { entries: cache.l2Entries, hits: cache.totalHits } },
    };
  },
};

const capabilityTool: ChatTool = {
  name: 'get_capability_status',
  description:
    'Which platform capabilities are configured and which are not. Call this before claiming any capability works, and whenever the operator asks why something is unavailable.',
  schema: NO_ARGS,
  async run() {
    const { capabilityReport } = await import('@/lib/config/capabilities');
    const report = capabilityReport();
    return {
      summary: report.capabilities
        .map((c) => `${c.title}: ${c.state} — ${c.summary}${c.remedy.length > 0 ? ` (remedy: ${c.remedy.join('; ')})` : ''}`)
        .join('\n'),
      data: { capabilities: report.capabilities },
    };
  },
};

const errorMemoryTool: ChatTool = {
  name: 'search_error_memory',
  description:
    'Search the failures the factory has recorded and the verified fixes it found. Use this for "has this broken before" and "what did we learn" questions.',
  schema: z.object({ limit: z.number().int().min(1).max(20).default(10) }).strict(),
  async run(input) {
    const { listErrorMemories, errorMemoryStats } = await import('@/lib/knowledge/error-memory');
    const memories = listErrorMemories(input.limit as number);
    const stats = errorMemoryStats();
    if (memories.length === 0) return { summary: 'No failures have been recorded yet.' };
    return {
      summary: [
        `${stats.total} recorded failures, ${stats.resolved} with a verified fix, ${stats.recurrences} recurrences.`,
        ...memories.map((m) => `- [${m.category}] ${m.message.slice(0, 120)}${m.resolved ? ` → fixed: ${m.fixSummary.slice(0, 120)}` : ' (open)'}`),
      ].join('\n'),
      data: { stats, memories: memories.map((m) => ({ id: m.id, category: m.category, message: m.message, resolved: m.resolved, occurrences: m.occurrences })) },
    };
  },
};

const scheduleTool: ChatTool = {
  name: 'list_schedules',
  description: 'The factory\'s automation schedule: which jobs run, when they next run, and how the last run ended.',
  schema: NO_ARGS,
  async run() {
    const { schedulerStatus } = await import('@/lib/schedule/scheduler');
    const status = schedulerStatus();
    if (!status.enabled) {
      return {
        summary:
          'The scheduler is disabled (SCHEDULER_ENABLED=false), so no job runs automatically. Schedules below are stored but dormant.\n' +
          status.schedules.map((s) => `- ${s.name}: ${s.cron} (${s.job})`).join('\n'),
        data: { status },
      };
    }
    return {
      summary: status.schedules
        .map((s) => `${s.name} (${s.cron}) — next ${s.nextRunAt ?? 'never'}, last ${s.lastStatus ?? 'never run'}`)
        .join('\n'),
      data: { status },
    };
  },
};

// -------------------------------------------------------------- write tools --

const startRunTool: ChatTool = {
  name: 'start_factory_run',
  description:
    'Start a real factory run. This performs live research, spends API budget and can build a product, so only call it when the operator has clearly asked for work to be done. Use stop_after to run only part of the pipeline.',
  permission: 'factory:run',
  schema: z
    .object({
      objective: z.string().min(8).max(500),
      stop_after: z.enum(['research', 'trends', 'gaps', 'competition', 'selection', 'invention', 'learning']).optional(),
      include_games: z.boolean().default(true),
      constraints: z.array(z.string().max(200)).max(10).default([]),
    })
    .strict(),
  async run(input, ctx) {
    const { runFactory } = await import('@/lib/orchestrator/factory');
    const result = await runFactory({
      objective: input.objective as string,
      constraints: input.constraints as string[],
      includeGames: input.include_games as boolean,
      trigger: 'chat',
      userId: ctx.userId,
      stopAfter: input.stop_after as never,
      signal: ctx.signal,
    });
    return {
      summary: `Run ${result.runId} finished with status ${result.status}. ${result.summary}${result.error ? ` Error: ${result.error}` : ''}`,
      data: {
        runId: result.runId,
        status: result.status,
        projectId: result.project?.id ?? null,
        costUsd: result.costUsd,
        stepsCompleted: result.stepsCompleted,
      },
    };
  },
};

const triggerScheduleTool: ChatTool = {
  name: 'trigger_schedule',
  description: 'Run one stored schedule immediately, without changing its cron cadence.',
  permission: 'factory:run',
  schema: z.object({ name: z.string().min(1).max(80) }).strict(),
  async run(input) {
    const { triggerSchedule } = await import('@/lib/schedule/scheduler');
    const outcome = await triggerSchedule(input.name as string);
    return { summary: outcome.summary, data: outcome.data };
  },
};

const improvementTool: ChatTool = {
  name: 'run_improvement_cycle',
  description:
    'Run one self-improvement cycle: measure platform quality, gather evidence from recorded failures, and propose source changes. Proposals are applied automatically only in fully autonomous mode.',
  permission: 'factory:run',
  schema: NO_ARGS,
  async run(_input, ctx) {
    const { runImprovementCycle } = await import('@/lib/improvement/engine');
    const result = await runImprovementCycle({ signal: ctx.signal });
    return {
      summary:
        result.proposals.length === 0
          ? 'No improvement proposals: there is not enough recorded evidence to learn from yet.'
          : `${result.proposals.length} proposals (${result.applied.length} applied):\n${result.proposals.map((p) => `- [${p.risk} risk] ${p.title}`).join('\n')}`,
      data: { proposals: result.proposals.length, applied: result.applied, snapshot: result.snapshot },
    };
  },
};

export const CHAT_TOOLS: readonly ChatTool[] = [
  listOpportunitiesTool,
  listTrendsTool,
  searchResearchTool,
  listProjectsTool,
  projectDetailTool,
  readFileTool,
  runStatusTool,
  costTool,
  capabilityTool,
  errorMemoryTool,
  scheduleTool,
  startRunTool,
  triggerScheduleTool,
  improvementTool,
];

/** Converts a Zod schema to the JSON Schema shape providers expect. */
function jsonSchemaFor(tool: ChatTool): Record<string, unknown> {
  const shape = (tool.schema as unknown as { _def: { shape?: () => Record<string, z.ZodTypeAny> } })._def.shape?.() ?? {};
  const properties: Record<string, unknown> = {};
  const required: string[] = [];

  for (const [key, field] of Object.entries(shape)) {
    properties[key] = describeField(field);
    if (!field.isOptional()) required.push(key);
  }
  return { type: 'object', properties, required, additionalProperties: false };
}

function describeField(field: z.ZodTypeAny): Record<string, unknown> {
  let current: z.ZodTypeAny = field;
  // Unwrap default/optional so the underlying type drives the schema.
  while (current instanceof z.ZodDefault || current instanceof z.ZodOptional) {
    current = (current as unknown as { _def: { innerType: z.ZodTypeAny } })._def.innerType;
  }
  if (current instanceof z.ZodString) return { type: 'string' };
  if (current instanceof z.ZodNumber) return { type: 'integer' };
  if (current instanceof z.ZodBoolean) return { type: 'boolean' };
  if (current instanceof z.ZodEnum) {
    return { type: 'string', enum: (current as unknown as { _def: { values: string[] } })._def.values };
  }
  if (current instanceof z.ZodArray) {
    return { type: 'array', items: describeField((current as unknown as { _def: { type: z.ZodTypeAny } })._def.type) };
  }
  return { type: 'string' };
}

export function toolDefinitions(permissions: readonly Permission[]): LLMToolDefinition[] {
  return CHAT_TOOLS.filter((tool) => !tool.permission || permissions.includes(tool.permission)).map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: jsonSchemaFor(tool),
  }));
}

export function findTool(name: string): ChatTool | undefined {
  return CHAT_TOOLS.find((tool) => tool.name === name);
}

/**
 * Runs a tool the model asked for. Input is validated against the tool's schema:
 * a malformed call is reported back to the model as an error it can correct,
 * never executed on a best-effort reading of what it probably meant.
 */
export async function executeTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolResult> {
  const tool = findTool(name);
  if (!tool) return { summary: `There is no tool named "${name}".` };

  if (tool.permission && !ctx.permissions.includes(tool.permission)) {
    return { summary: `Refused: running "${name}" requires the ${tool.permission} permission, which this account does not have.` };
  }

  const parsed = tool.schema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; ');
    return { summary: `Invalid arguments for "${name}": ${issues}` };
  }

  try {
    return await tool.run(parsed.data, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('chat tool failed', { tool: name, error: message });
    return { summary: `"${name}" failed: ${message}` };
  }
}
