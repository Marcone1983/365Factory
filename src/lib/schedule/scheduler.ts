import { config } from '@/lib/config/env';
import { db, fromJson, newId, nowIso, toJson } from '@/lib/db/client';
import { createLogger } from '@/lib/observability/logger';
import { emitEvent } from '@/lib/observability/events';
import { counter, observe } from '@/lib/observability/metrics';
import { isValidCron, nextOccurrence } from './cron';

const log = createLogger('scheduler');

/**
 * The scheduler that makes the factory autonomous.
 *
 * A single in-process ticker wakes every SCHEDULER_TICK_MS, claims every
 * schedule whose next_run_at has passed, and runs its job. Claiming is a
 * conditional UPDATE: the row's next_run_at is advanced in the same statement
 * that selects it, so a schedule cannot be claimed twice even if two ticks
 * overlap or a second process is attached to the same database.
 *
 * Jobs are named, not stored as code. A schedule row references a job by name
 * and carries a JSON payload; nothing in the database is ever executed. That is
 * the same boundary the sandbox enforces for AI-authored code — data configures
 * behaviour, data never becomes behaviour.
 *
 * A missed window (the process was down) fires once on the next tick rather than
 * replaying every occurrence it slept through: catching up on six missed daily
 * market scans would burn six days of budget to produce one day of value.
 */

export type JobName =
  | 'daily_market_scan'
  | 'gap_analysis'
  | 'opportunity_selection'
  | 'product_generation'
  | 'self_improvement'
  | 'maintenance';

export interface JobContext {
  readonly scheduleId: string;
  readonly payload: Record<string, unknown>;
  readonly signal: AbortSignal;
}

export interface JobOutcome {
  readonly summary: string;
  readonly data?: Record<string, unknown>;
}

export type JobHandler = (ctx: JobContext) => Promise<JobOutcome>;

interface ScheduleRow {
  id: string;
  name: string;
  cron: string;
  job: string;
  enabled: number;
  payload: string;
  last_run_at: string | null;
  last_status: string | null;
  next_run_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ScheduleView {
  readonly id: string;
  readonly name: string;
  readonly cron: string;
  readonly job: JobName;
  readonly enabled: boolean;
  readonly payload: Record<string, unknown>;
  readonly lastRunAt: string | null;
  readonly lastStatus: string | null;
  readonly nextRunAt: string | null;
}

function objectiveFrom(payload: Record<string, unknown>, fallback: string): string {
  const value = payload.objective;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function constraintsFrom(payload: Record<string, unknown>): string[] {
  const value = payload.constraints;
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

/**
 * Runs the factory pipeline up to a given step. The four discovery jobs are the
 * same pipeline stopped at different points, which is what makes a day's work
 * resumable: the scan populates research, the gap analysis reads it from the
 * database rather than re-crawling, and so on.
 */
async function runPipelineTo(
  ctx: JobContext,
  stopAfter: 'trends' | 'competition' | 'selection' | 'learning',
  fallbackObjective: string,
): Promise<JobOutcome> {
  const { runFactory } = await import('@/lib/orchestrator/factory');
  const result = await runFactory({
    objective: objectiveFrom(ctx.payload, fallbackObjective),
    constraints: constraintsFrom(ctx.payload),
    includeGames: ctx.payload.includeGames !== false,
    trigger: 'scheduled',
    stopAfter,
    signal: ctx.signal,
  });
  if (result.status === 'FAILED') {
    throw new Error(result.error ?? 'factory run failed without an error message');
  }
  return {
    summary: result.summary,
    data: {
      runId: result.runId,
      status: result.status,
      projectId: result.project?.id ?? null,
      opportunities: result.opportunities.length,
      costUsd: result.costUsd,
    },
  };
}

const HANDLERS: Readonly<Record<JobName, JobHandler>> = {
  daily_market_scan: (ctx) =>
    runPipelineTo(ctx, 'trends', 'Scan the web for emerging software needs and unmet demand signals'),

  gap_analysis: (ctx) =>
    runPipelineTo(ctx, 'competition', 'Analyse today\'s research for market gaps and map the competitive field'),

  opportunity_selection: (ctx) =>
    runPipelineTo(ctx, 'selection', 'Score today\'s market gaps and select the strongest opportunity'),

  product_generation: (ctx) =>
    runPipelineTo(ctx, 'learning', 'Invent, build, verify and package today\'s product'),

  self_improvement: async (ctx) => {
    const { runImprovementCycle } = await import('@/lib/improvement/engine');
    const result = await runImprovementCycle({ signal: ctx.signal });
    return {
      summary: `${result.proposals.length} improvement proposals, ${result.applied.length} applied`,
      data: {
        proposals: result.proposals.length,
        applied: result.applied.length,
        buildSuccessRate: result.snapshot.buildSuccessRate,
        errorRecurrenceRate: result.snapshot.errorRecurrenceRate,
      },
    };
  },

  maintenance: async () => {
    const { purgeExpiredCache } = await import('@/lib/cache');
    const { purgeExpiredHttpCache } = await import('@/lib/research/fetcher');
    const { purgeExpiredSessions } = await import('@/lib/security/auth');
    const cache = purgeExpiredCache();
    const http = purgeExpiredHttpCache();
    const sessions = purgeExpiredSessions();
    // Metrics are kept for a month; beyond that the dashboards aggregate from
    // the run history instead, so retaining raw samples only grows the file.
    db().prepare('DELETE FROM metrics WHERE ts < ?').run(new Date(Date.now() - 30 * 24 * 3600_000).toISOString());
    db().pragma('wal_checkpoint(TRUNCATE)');
    return {
      summary: `purged ${cache} cache entries, ${http} HTTP entries, ${sessions} sessions`,
      data: { cache, http, sessions },
    };
  },
};

export function isJobName(value: string): value is JobName {
  return Object.prototype.hasOwnProperty.call(HANDLERS, value);
}

function toView(row: ScheduleRow): ScheduleView {
  return {
    id: row.id,
    name: row.name,
    cron: row.cron,
    job: row.job as JobName,
    enabled: row.enabled === 1,
    payload: fromJson<Record<string, unknown>>(row.payload, {}),
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    nextRunAt: row.next_run_at,
  };
}

export function listSchedules(): ScheduleView[] {
  return db()
    .prepare<[], ScheduleRow>('SELECT * FROM schedules ORDER BY next_run_at IS NULL, next_run_at ASC')
    .all()
    .map(toView);
}

export function getSchedule(name: string): ScheduleView | null {
  const row = db().prepare<[string], ScheduleRow>('SELECT * FROM schedules WHERE name = ?').get(name);
  return row ? toView(row) : null;
}

export interface UpsertScheduleInput {
  readonly name: string;
  readonly cron: string;
  readonly job: JobName;
  readonly enabled?: boolean;
  readonly payload?: Record<string, unknown>;
}

/**
 * Creates or updates a schedule. The cron expression is validated here so an
 * unparseable expression is rejected at the edge instead of silently never
 * firing, and next_run_at is recomputed from the new expression.
 */
export function upsertSchedule(input: UpsertScheduleInput): ScheduleView {
  if (!isValidCron(input.cron)) {
    throw new Error(`"${input.cron}" is not a valid cron expression`);
  }
  if (!isJobName(input.job)) {
    throw new Error(`unknown job "${input.job}"`);
  }
  const cfg = config();
  const enabled = input.enabled ?? true;
  const next = enabled ? nextOccurrence(input.cron, new Date(), cfg.SCHEDULER_TIMEZONE_OFFSET_MINUTES) : null;

  db()
    .prepare(
      `INSERT INTO schedules (id, name, cron, job, enabled, payload, next_run_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET
         cron = excluded.cron, job = excluded.job, enabled = excluded.enabled,
         payload = excluded.payload, next_run_at = excluded.next_run_at, updated_at = excluded.updated_at`,
    )
    .run(
      newId('sch'),
      input.name,
      input.cron,
      input.job,
      enabled ? 1 : 0,
      toJson(input.payload ?? {}),
      next?.toISOString() ?? null,
      nowIso(),
      nowIso(),
    );

  const view = getSchedule(input.name);
  if (!view) throw new Error(`schedule "${input.name}" vanished immediately after being written`);
  return view;
}

export function setScheduleEnabled(name: string, enabled: boolean): ScheduleView | null {
  const existing = getSchedule(name);
  if (!existing) return null;
  return upsertSchedule({ ...existing, enabled });
}

/**
 * Installs the four discovery schedules plus maintenance and self-improvement
 * from the environment. Existing rows are updated so a changed cron in the
 * environment takes effect on restart, but the enabled flag an operator toggled
 * in the console is preserved.
 */
export function installDefaultSchedules(): ScheduleView[] {
  const cfg = config();
  const defaults: readonly UpsertScheduleInput[] = [
    { name: 'daily market scan', cron: cfg.DAILY_MARKET_SCAN_CRON, job: 'daily_market_scan' },
    { name: 'gap analysis', cron: cfg.DAILY_GAP_ANALYSIS_CRON, job: 'gap_analysis' },
    { name: 'opportunity selection', cron: cfg.DAILY_SELECTION_CRON, job: 'opportunity_selection' },
    { name: 'product generation', cron: cfg.DAILY_GENERATION_CRON, job: 'product_generation' },
    { name: 'self improvement', cron: '0 3 * * *', job: 'self_improvement' },
    { name: 'maintenance', cron: '20 4 * * *', job: 'maintenance' },
  ];

  const installed = defaults.map((entry) => {
    const existing = getSchedule(entry.name);
    return upsertSchedule({ ...entry, enabled: existing?.enabled ?? true, payload: existing?.payload ?? {} });
  });

  // A row whose job is not in the registry can never run — it is left over from
  // an older release that named its jobs differently. Removing it keeps the
  // console showing only schedules that will actually fire.
  for (const stale of listSchedules()) {
    if (!isJobName(stale.job)) {
      db().prepare('DELETE FROM schedules WHERE id = ?').run(stale.id);
      log.warn('removed a schedule referencing an unknown job', { name: stale.name, job: stale.job });
    }
  }

  return installed;
}

/**
 * Atomically claims every schedule that is due.
 *
 * The UPDATE advances next_run_at as part of the selection, so a row is handed
 * to exactly one caller. next_run_at is computed from *now* rather than from the
 * previous next_run_at, which is what collapses a backlog of missed occurrences
 * into a single run.
 */
function claimDue(now: Date): ScheduleView[] {
  const cfg = config();
  const database = db();
  const claimed: ScheduleView[] = [];

  const claim = database.transaction((iso: string) => {
    const due = database
      .prepare<[string], ScheduleRow>(
        'SELECT * FROM schedules WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?',
      )
      .all(iso);

    for (const row of due) {
      const next = nextOccurrence(row.cron, now, cfg.SCHEDULER_TIMEZONE_OFFSET_MINUTES);
      const updated = database
        .prepare(
          `UPDATE schedules SET next_run_at = ?, last_run_at = ?, last_status = 'RUNNING', updated_at = ?
           WHERE id = ? AND next_run_at = ?`,
        )
        .run(next?.toISOString() ?? null, iso, iso, row.id, row.next_run_at).changes;
      if (updated === 1) claimed.push(toView(row));
    }
  });

  claim(nowIso());
  return claimed;
}

function finish(id: string, status: 'SUCCEEDED' | 'FAILED' | 'SKIPPED', detail: string): void {
  db()
    .prepare('UPDATE schedules SET last_status = ?, updated_at = ? WHERE id = ?')
    .run(status, nowIso(), id);
  log[status === 'FAILED' ? 'error' : 'info']('scheduled job finished', { scheduleId: id, status, detail });
}

let running = false;
let timer: NodeJS.Timeout | null = null;
let controller: AbortController | null = null;
const active = new Set<string>();

/**
 * Runs one due job. Exported so the console can trigger a schedule on demand
 * and get exactly the behaviour the timer would have produced.
 */
export async function runScheduledJob(schedule: ScheduleView, signal: AbortSignal): Promise<JobOutcome> {
  const handler = HANDLERS[schedule.job];
  if (!handler) throw new Error(`schedule "${schedule.name}" references unknown job "${schedule.job}"`);

  const started = Date.now();
  // The timer path already stamped last_run_at when it claimed the row, but a
  // job started from the console has not been claimed. Stamping here keeps the
  // "last run" column truthful whichever path started the job.
  db()
    .prepare("UPDATE schedules SET last_run_at = ?, last_status = 'RUNNING', updated_at = ? WHERE id = ?")
    .run(nowIso(), nowIso(), schedule.id);

  emitEvent({
    type: 'scheduler.tick',
    scope: 'scheduler',
    message: `running scheduled job: ${schedule.name}`,
    data: { schedule: schedule.name, job: schedule.job },
  });

  try {
    const outcome = await handler({ scheduleId: schedule.id, payload: schedule.payload, signal });
    observe('scheduler.job.duration', Date.now() - started, { job: schedule.job, outcome: 'success' });
    counter('scheduler.job', { job: schedule.job, outcome: 'success' });
    finish(schedule.id, 'SUCCEEDED', outcome.summary);
    emitEvent({
      type: 'scheduler.tick',
      scope: 'scheduler',
      message: `${schedule.name}: ${outcome.summary}`,
      data: { schedule: schedule.name, job: schedule.job, ...outcome.data },
    });
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    observe('scheduler.job.duration', Date.now() - started, { job: schedule.job, outcome: 'failure' });
    counter('scheduler.job', { job: schedule.job, outcome: 'failure' });
    finish(schedule.id, 'FAILED', message);
    emitEvent({
      type: 'scheduler.tick',
      scope: 'scheduler',
      message: `${schedule.name} failed: ${message}`,
      data: { schedule: schedule.name, job: schedule.job, error: message },
    });
    throw error;
  }
}

/** Runs a named schedule immediately, without disturbing its cron cadence. */
export async function triggerSchedule(name: string): Promise<JobOutcome> {
  const schedule = getSchedule(name);
  if (!schedule) throw new Error(`no schedule named "${name}"`);
  if (active.has(schedule.id)) throw new Error(`schedule "${name}" is already running`);
  active.add(schedule.id);
  const ac = new AbortController();
  try {
    return await runScheduledJob(schedule, ac.signal);
  } finally {
    active.delete(schedule.id);
  }
}

async function tick(): Promise<void> {
  const signal = controller?.signal;
  if (!signal || signal.aborted) return;

  let due: ScheduleView[];
  try {
    due = claimDue(new Date());
  } catch (error) {
    log.error('scheduler failed to claim due schedules', { error });
    return;
  }
  if (due.length === 0) return;

  for (const schedule of due) {
    if (signal.aborted) return;
    // Jobs run one at a time: two concurrent factory runs would compete for the
    // same daily budget and the same workspace, and neither would finish sooner.
    if (active.has(schedule.id)) {
      finish(schedule.id, 'SKIPPED', 'the previous occurrence was still running');
      continue;
    }
    active.add(schedule.id);
    try {
      await runScheduledJob(schedule, signal);
    } catch {
      // runScheduledJob has already recorded and emitted the failure; a failed
      // job must not stop the remaining schedules from running.
    } finally {
      active.delete(schedule.id);
    }
  }
}

export interface SchedulerStatus {
  readonly enabled: boolean;
  readonly running: boolean;
  readonly activeJobs: number;
  readonly schedules: readonly ScheduleView[];
}

export function schedulerStatus(): SchedulerStatus {
  return {
    enabled: config().SCHEDULER_ENABLED,
    running,
    activeJobs: active.size,
    schedules: listSchedules(),
  };
}

/**
 * Starts the ticker. Safe to call more than once; the second call is a no-op.
 * Returns false when the scheduler is disabled by configuration, so the caller
 * can report the real state instead of implying autonomous operation.
 */
export function startScheduler(): boolean {
  if (running) return true;
  const cfg = config();
  if (!cfg.SCHEDULER_ENABLED) {
    log.info('scheduler disabled by configuration (SCHEDULER_ENABLED=false)');
    return false;
  }

  installDefaultSchedules();
  controller = new AbortController();
  running = true;

  // A 30-second tick against a one-minute cron resolution guarantees every
  // occurrence is seen without polling the database more than twice a minute.
  timer = setInterval(() => {
    void tick();
  }, 30_000);
  timer.unref();
  void tick();

  const schedules = listSchedules().filter((s) => s.enabled);
  log.info('scheduler started', {
    schedules: schedules.length,
    next: schedules[0]?.nextRunAt ?? null,
    offsetMinutes: cfg.SCHEDULER_TIMEZONE_OFFSET_MINUTES,
  });
  return true;
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
  controller?.abort();
  controller = null;
  running = false;
  log.info('scheduler stopped');
}
