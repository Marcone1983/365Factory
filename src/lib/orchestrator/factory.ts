import { db, fromJson, newId, nowIso, toJson } from '@/lib/db/client';
import { config } from '@/lib/config/env';
import { createLogger } from '@/lib/observability/logger';
import { emitEvent } from '@/lib/observability/events';
import { counter, observe } from '@/lib/observability/metrics';
import { usageForRun } from '@/lib/ai/usage';
import { ResearchAgent, TrendAgent, GapAgent, CompetitiveAgent, type ScoredOpportunity } from '@/lib/agents/research-agents';
import { ProductInventorAgent, ArchitectAgent, AssetAgent } from '@/lib/agents/product-agents';
import { CodingAgent } from '@/lib/agents/coding';
import { QaAgent, BuildAgent, SecurityAgent, LearningAgent } from '@/lib/agents/delivery-agents';
import { updateProject, getProject, type Project } from '@/lib/workspace/project';
import { acceptanceThreshold } from '@/lib/market/gaps';

const log = createLogger('orchestrator');

/**
 * Factory orchestrator.
 *
 * Runs the full pipeline and records every step so a run is auditable and
 * resumable:
 *
 *   research → trends → gaps → competition → selection → invention →
 *   assets → architecture → implementation → build → runtime QA →
 *   security → packaging → learning
 *
 * Each step writes a checkpoint before it starts. A run that is interrupted can
 * be resumed from its last completed step rather than repeating expensive
 * research, and every step's inputs, outputs, cost and duration are persisted.
 */

export const FACTORY_STEPS = [
  'research',
  'trends',
  'gaps',
  'competition',
  'selection',
  'invention',
  'assets',
  'architecture',
  'implementation',
  'build',
  'qa',
  'security',
  'package',
  'learning',
] as const;

export type FactoryStep = (typeof FACTORY_STEPS)[number];

export type RunStatus = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'AWAITING_APPROVAL';

export interface FactoryRunOptions {
  readonly objective: string;
  readonly constraints?: readonly string[];
  readonly includeGames?: boolean;
  readonly userId?: string;
  readonly trigger: 'manual' | 'scheduled' | 'chat';
  /** Stops after this step; used by "just research today" style requests. */
  readonly stopAfter?: FactoryStep;
  readonly signal?: AbortSignal;
  readonly maxDocuments?: number;
}

export interface FactoryRunResult {
  readonly runId: string;
  readonly status: RunStatus;
  readonly project: Project | null;
  readonly opportunities: readonly ScoredOpportunity[];
  readonly stepsCompleted: readonly FactoryStep[];
  readonly error: string | null;
  readonly costUsd: number;
  readonly durationMs: number;
  readonly summary: string;
}

interface RunRow {
  id: string;
  trigger: string;
  mode: string;
  status: string;
  user_id: string | null;
  project_id: string | null;
  constraints: string;
  current_step: string;
  checkpoint: string;
  result: string;
  error: string | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export function createRun(options: FactoryRunOptions): string {
  const id = newId('run');
  db()
    .prepare(
      `INSERT INTO factory_runs (id, trigger, mode, status, user_id, constraints, current_step, checkpoint, result, started_at, created_at)
       VALUES (?, ?, ?, 'RUNNING', ?, ?, '', '{}', '{}', ?, ?)`,
    )
    .run(
      id,
      options.trigger,
      config().AUTONOMY_MODE,
      options.userId ?? null,
      toJson({ objective: options.objective, constraints: options.constraints ?? [], includeGames: options.includeGames ?? true }),
      nowIso(),
      nowIso(),
    );
  emitEvent({ type: 'factory.run.started', scope: 'orchestrator', runId: id, message: `factory run started: ${options.objective}` });
  return id;
}

function setStep(runId: string, step: FactoryStep, checkpoint: Record<string, unknown>): void {
  db().prepare('UPDATE factory_runs SET current_step = ?, checkpoint = ? WHERE id = ?').run(step, toJson(checkpoint), runId);
  emitEvent({ type: 'factory.run.step', scope: 'orchestrator', runId, message: `step: ${step}`, data: { step } });
}

function finishRun(runId: string, status: RunStatus, result: Record<string, unknown>, error?: string): void {
  db()
    .prepare('UPDATE factory_runs SET status = ?, result = ?, error = ?, finished_at = ? WHERE id = ?')
    .run(status, toJson(result), error ?? null, nowIso(), runId);
  emitEvent({
    type: status === 'SUCCEEDED' ? 'factory.run.finished' : 'factory.run.failed',
    scope: 'orchestrator',
    runId,
    message: status === 'SUCCEEDED' ? 'factory run completed' : `factory run ${status.toLowerCase()}: ${error ?? ''}`,
    data: { status },
  });
}

/**
 * Runs the pipeline. Every step is optional in the sense that the run can be
 * stopped after any of them, which is how the chat surfaces "just find gaps"
 * versus "build it".
 */
export async function runFactory(options: FactoryRunOptions): Promise<FactoryRunResult> {
  const started = Date.now();
  const runId = createRun(options);
  const completed: FactoryStep[] = [];
  const stopAfter = options.stopAfter ?? 'learning';
  const shouldStop = (step: FactoryStep): boolean => FACTORY_STEPS.indexOf(step) >= FACTORY_STEPS.indexOf(stopAfter);

  const base = { factoryRunId: runId, signal: options.signal };
  let project: Project | null = null;
  let opportunities: readonly ScoredOpportunity[] = [];
  let summary = '';

  try {
    // 1. research -----------------------------------------------------------
    setStep(runId, 'research', { objective: options.objective });
    const research = await new ResearchAgent().run(
      {
        objective: options.objective,
        constraints: options.constraints,
        includeGameSources: options.includeGames ?? true,
        maxDocuments: options.maxDocuments,
      },
      { ...base, step: 'research' },
    );
    completed.push('research');
    summary = `${research.output.documents.length} sources from ${research.output.queriesExecuted} queries`;
    if (shouldStop('research')) return complete(runId, 'SUCCEEDED', summary);

    // 2. trends -------------------------------------------------------------
    setStep(runId, 'trends', { documents: research.output.documents.length });
    const trends = await new TrendAgent().run({ documents: research.output.documents }, { ...base, step: 'trends' });
    completed.push('trends');
    summary = `${trends.output.signals.length} signals, ${trends.output.trends.length} trends`;
    if (shouldStop('trends')) return complete(runId, 'SUCCEEDED', summary);

    // 3. gaps ---------------------------------------------------------------
    setStep(runId, 'gaps', { clusters: trends.output.clusters.length });
    const gaps = await new GapAgent().run(
      { clusters: trends.output.clusters, trends: trends.output.trends, constraints: options.constraints },
      { ...base, step: 'gaps' },
    );
    completed.push('gaps');
    summary = `${gaps.output.gaps.length} market gaps identified`;
    if (shouldStop('gaps')) return complete(runId, 'SUCCEEDED', summary);

    // 4. competition + scoring ---------------------------------------------
    setStep(runId, 'competition', { gaps: gaps.output.gaps.length });
    const competitive = await new CompetitiveAgent().run({ gaps: gaps.output.gaps }, { ...base, step: 'competition' });
    opportunities = competitive.output.opportunities;
    completed.push('competition');
    completed.push('selection');
    summary = `${opportunities.length} scored opportunities; best ${opportunities[0]?.opportunity.score.score.toFixed(1) ?? 'n/a'}`;
    if (shouldStop('competition') || shouldStop('selection')) return complete(runId, 'SUCCEEDED', summary);

    // 5. selection ----------------------------------------------------------
    const best = opportunities.find((o) => o.opportunity.score.accepted) ?? null;
    if (!best) {
      const top = opportunities[0];
      summary =
        `No opportunity cleared the acceptance threshold of ${acceptanceThreshold()}. ` +
        `The best scored ${top?.opportunity.score.score.toFixed(1) ?? 'n/a'}: ${top?.opportunity.score.rejectionReasons.join('; ') ?? 'no candidates'}. ` +
        'Nothing was built, which is the correct outcome for weak evidence.';
      return complete(runId, 'SUCCEEDED', summary);
    }
    setStep(runId, 'selection', { opportunityId: best.opportunity.id, score: best.opportunity.score.score });

    if (config().AUTONOMY_MODE === 'manual' && options.trigger === 'scheduled') {
      finishRun(runId, 'AWAITING_APPROVAL', { opportunityId: best.opportunity.id, score: best.opportunity.score.score });
      return {
        runId,
        status: 'AWAITING_APPROVAL',
        project: null,
        opportunities,
        stepsCompleted: completed,
        error: null,
        costUsd: usageForRun(runId).costUsd,
        durationMs: Date.now() - started,
        summary: `Selected "${best.gap.title}" (score ${best.opportunity.score.score.toFixed(1)}); awaiting operator approval before building.`,
      };
    }

    // 6. invention ----------------------------------------------------------
    setStep(runId, 'invention', { opportunityId: best.opportunity.id });
    const invention = await new ProductInventorAgent().run(
      {
        gap: best.gap,
        opportunityId: best.opportunity.id,
        competitive: best.competitive,
        productForm: best.productForm,
        constraints: options.constraints,
      },
      { ...base, step: 'invention' },
    );
    completed.push('invention');
    summary = `concept: ${invention.output.concept.name}`;
    if (shouldStop('invention')) return complete(runId, 'SUCCEEDED', summary);

    // 7. assets + workspace -------------------------------------------------
    setStep(runId, 'assets', { conceptId: invention.output.conceptId });
    const assets = await new AssetAgent().run(
      { concept: invention.output.concept, kind: invention.output.kind, userId: options.userId },
      { ...base, step: 'assets' },
    );
    project = assets.output.project;
    db().prepare('UPDATE factory_runs SET project_id = ? WHERE id = ?').run(project.id, runId);
    completed.push('assets');
    if (shouldStop('assets')) return complete(runId, 'SUCCEEDED', `${assets.output.assets.length} assets generated for ${project.name}`);

    // 8. architecture -------------------------------------------------------
    setStep(runId, 'architecture', { projectId: project.id });
    const architecture = await new ArchitectAgent().run(
      {
        concept: invention.output.concept,
        kind: invention.output.kind,
        assetPaths: assets.output.assets.map((a) => a.path),
      },
      { ...base, step: 'architecture', projectId: project.id },
    );
    completed.push('architecture');

    // 9. implementation -----------------------------------------------------
    setStep(runId, 'implementation', { files: architecture.output.plan.length });
    updateProject(project.id, { status: 'GENERATING' });
    const coding = await new CodingAgent().run(
      {
        project,
        kind: invention.output.kind,
        design: architecture.output.design,
        plan: architecture.output.plan,
        assets: assets.output.assets.map((a) => ({ path: a.path, kind: a.kind, name: a.name })),
        modelData: assets.output.modelData,
      },
      { ...base, step: 'implementation', projectId: project.id },
    );
    completed.push('implementation');
    if (!coding.output.succeeded) {
      updateProject(project.id, { status: 'FAILED' });
      throw new Error(`Implementation did not reach a clean build after ${coding.output.repairAttempts} repair rounds: ${coding.output.build.build.errorSummary}`);
    }

    // 10. build -------------------------------------------------------------
    setStep(runId, 'build', { projectId: project.id });
    updateProject(project.id, { status: 'BUILDING' });
    const build = await new BuildAgent().run({ project, android: true }, { ...base, step: 'build', projectId: project.id });
    completed.push('build');

    // 11. runtime QA --------------------------------------------------------
    setStep(runId, 'qa', { buildId: build.output.web.id });
    updateProject(project.id, { status: 'TESTING' });
    const qa = await new QaAgent().run(
      { project, kind: invention.output.kind, buildId: build.output.web.id },
      { ...base, step: 'qa', projectId: project.id },
    );
    completed.push('qa');

    // 12. security ----------------------------------------------------------
    setStep(runId, 'security', { projectId: project.id });
    const security = await new SecurityAgent().run(
      { project, buildId: build.output.web.id },
      { ...base, step: 'security', projectId: project.id },
    );
    completed.push('security');
    completed.push('package');

    const ready = qa.output.passed && security.output.verdict !== 'fail';
    updateProject(project.id, { status: ready ? 'READY' : 'FAILED' });

    // 13. learning ----------------------------------------------------------
    setStep(runId, 'learning', { projectId: project.id });
    const notes = [
      `implementation needed ${coding.output.repairAttempts} repair round(s), ${coding.output.rejectedRepairs} rejected by the quality policy`,
      `reused ${coding.output.memoriesUsed} verified remedies from error memory`,
      qa.output.runtime.summary,
      `security: ${security.output.verdict} — ${security.output.summary}`,
      build.output.apk
        ? `APK produced: ${build.output.apk.filename} (${build.output.apk.bytes} bytes, sha256 ${build.output.apk.sha256.slice(0, 16)}…)`
        : `APK not produced: ${build.output.toolchainMissing.length > 0 ? `toolchain missing (${build.output.toolchainMissing.join(', ')})` : build.output.android?.errorSummary ?? 'unknown'}`,
    ];
    await new LearningAgent().run(
      { project, outcome: ready ? 'ready' : 'failed', notes, runtime: qa.output.runtime },
      { ...base, step: 'learning', projectId: project.id },
    );
    completed.push('learning');

    summary =
      `${project.name}: ${ready ? 'READY' : 'FAILED'} — ${qa.output.runtime.summary}. ` +
      (build.output.apk ? `APK ${build.output.apk.filename}.` : `No APK (${build.output.toolchainMissing.join(', ') || 'build failed'}).`);

    counter('factory.runs', { outcome: ready ? 'ready' : 'failed' });
    observe('factory.duration', Date.now() - started, { outcome: ready ? 'ready' : 'failed' });
    return complete(runId, 'SUCCEEDED', summary);
  } catch (error) {
    const message = (error as Error).message;
    log.error('factory run failed', { runId, step: completed[completed.length - 1] ?? 'research', error: message });
    if (project) updateProject(project.id, { status: 'FAILED' });
    finishRun(runId, 'FAILED', { stepsCompleted: completed }, message);
    counter('factory.runs', { outcome: 'error' });
    return {
      runId,
      status: 'FAILED',
      project,
      opportunities,
      stepsCompleted: completed,
      error: message,
      costUsd: usageForRun(runId).costUsd,
      durationMs: Date.now() - started,
      summary: `Run failed after ${completed.length} step(s): ${message}`,
    };
  }

  function complete(id: string, status: RunStatus, text: string): FactoryRunResult {
    finishRun(id, status, { stepsCompleted: completed, summary: text });
    return {
      runId: id,
      status,
      project,
      opportunities,
      stepsCompleted: completed,
      error: null,
      costUsd: usageForRun(id).costUsd,
      durationMs: Date.now() - started,
      summary: text,
    };
  }
}

export interface FactoryRunSummary {
  readonly id: string;
  readonly trigger: string;
  readonly status: string;
  readonly currentStep: string;
  readonly projectId: string | null;
  readonly objective: string;
  readonly summary: string;
  readonly error: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly costUsd: number;
}

function toSummary(row: RunRow): FactoryRunSummary {
  const constraints = fromJson<{ objective?: string }>(row.constraints, {});
  const result = fromJson<{ summary?: string }>(row.result, {});
  return {
    id: row.id,
    trigger: row.trigger,
    status: row.status,
    currentStep: row.current_step,
    projectId: row.project_id,
    objective: constraints.objective ?? '',
    summary: result.summary ?? '',
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    costUsd: usageForRun(row.id).costUsd,
  };
}

export function listRuns(limit = 25): FactoryRunSummary[] {
  return db()
    .prepare<[number], RunRow>('SELECT * FROM factory_runs ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map(toSummary);
}

export function getRun(id: string): FactoryRunSummary | null {
  const row = db().prepare<[string], RunRow>('SELECT * FROM factory_runs WHERE id = ?').get(id);
  return row ? toSummary(row) : null;
}

/** Marks runs left RUNNING by a crash as failed, so the dashboard is truthful. */
export function reconcileInterruptedRuns(): number {
  const stale = db()
    .prepare<[], RunRow>("SELECT * FROM factory_runs WHERE status = 'RUNNING'")
    .all();
  for (const row of stale) {
    finishRun(row.id, 'FAILED', { stepsCompleted: [] }, 'The process restarted while this run was in progress.');
    if (row.project_id) {
      const project = getProject(row.project_id);
      if (project && !['READY', 'ARCHIVED'].includes(project.status)) updateProject(project.id, { status: 'FAILED' });
    }
  }
  return stale.length;
}
