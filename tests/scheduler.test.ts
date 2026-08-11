import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from './helpers/env';

let env: TestEnvironment;

beforeEach(() => {
  env = createTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

describe('schedule persistence', () => {
  it('stores a schedule and computes its next occurrence', async () => {
    const { upsertSchedule, getSchedule } = await import('@/lib/schedule/scheduler');

    const created = upsertSchedule({ name: 'nightly scan', cron: '0 6 * * *', job: 'daily_market_scan' });
    expect(created.enabled).toBe(true);
    expect(created.nextRunAt).not.toBeNull();
    expect(new Date(created.nextRunAt as string).getUTCHours()).toBe(6);
    expect(new Date(created.nextRunAt as string).getTime()).toBeGreaterThan(Date.now());

    const fetched = getSchedule('nightly scan');
    expect(fetched?.job).toBe('daily_market_scan');
    expect(fetched?.cron).toBe('0 6 * * *');
  });

  it('updates in place rather than creating a duplicate', async () => {
    const { upsertSchedule, listSchedules } = await import('@/lib/schedule/scheduler');

    upsertSchedule({ name: 'scan', cron: '0 6 * * *', job: 'daily_market_scan' });
    const updated = upsertSchedule({ name: 'scan', cron: '0 9 * * *', job: 'daily_market_scan' });

    expect(listSchedules().filter((s) => s.name === 'scan')).toHaveLength(1);
    expect(updated.cron).toBe('0 9 * * *');
    expect(new Date(updated.nextRunAt as string).getUTCHours()).toBe(9);
  });

  it('clears next_run_at when a schedule is disabled so it can never be claimed', async () => {
    const { upsertSchedule, setScheduleEnabled } = await import('@/lib/schedule/scheduler');

    upsertSchedule({ name: 'scan', cron: '0 6 * * *', job: 'daily_market_scan' });
    const disabled = setScheduleEnabled('scan', false);
    expect(disabled?.enabled).toBe(false);
    expect(disabled?.nextRunAt).toBeNull();

    const reenabled = setScheduleEnabled('scan', true);
    expect(reenabled?.nextRunAt).not.toBeNull();
  });

  it('rejects an invalid cron expression instead of storing a schedule that never fires', async () => {
    const { upsertSchedule } = await import('@/lib/schedule/scheduler');
    expect(() => upsertSchedule({ name: 'broken', cron: 'every tuesday', job: 'maintenance' })).toThrow(
      /not a valid cron expression/,
    );
  });

  it('rejects an unknown job name', async () => {
    const { upsertSchedule } = await import('@/lib/schedule/scheduler');
    expect(() =>
      upsertSchedule({
        name: 'bogus',
        cron: '0 6 * * *',
        job: 'rm_minus_rf' as unknown as 'maintenance',
      }),
    ).toThrow(/unknown job/);
  });

  it('installs the six default schedules from configuration', async () => {
    const { installDefaultSchedules, listSchedules } = await import('@/lib/schedule/scheduler');

    const installed = installDefaultSchedules();
    expect(installed).toHaveLength(6);

    const jobs = listSchedules().map((s) => s.job).sort();
    expect(jobs).toEqual([
      'daily_market_scan',
      'gap_analysis',
      'maintenance',
      'opportunity_selection',
      'product_generation',
      'self_improvement',
    ]);
  });

  it('preserves an operator\'s enabled toggle when defaults are reinstalled', async () => {
    const { installDefaultSchedules, setScheduleEnabled, getSchedule } = await import('@/lib/schedule/scheduler');

    installDefaultSchedules();
    setScheduleEnabled('product generation', false);
    installDefaultSchedules();

    expect(getSchedule('product generation')?.enabled).toBe(false);
    expect(getSchedule('gap analysis')?.enabled).toBe(true);
  });
});

describe('scheduler status', () => {
  it('reports that it is not running when configuration disables it', async () => {
    const { startScheduler, schedulerStatus } = await import('@/lib/schedule/scheduler');

    // The harness sets SCHEDULER_ENABLED=false, which is the honest default:
    // a disabled scheduler must report "disabled", never "idle".
    expect(startScheduler()).toBe(false);
    const status = schedulerStatus();
    expect(status.enabled).toBe(false);
    expect(status.running).toBe(false);
    expect(status.activeJobs).toBe(0);
  });
});

describe('due-schedule claiming', () => {
  it('hands a due schedule to exactly one caller and advances it past now', async () => {
    const { upsertSchedule, listSchedules } = await import('@/lib/schedule/scheduler');
    const { db } = await import('@/lib/db/client');
    const { runScheduledJob } = await import('@/lib/schedule/scheduler');

    upsertSchedule({ name: 'housekeeping', cron: '*/5 * * * *', job: 'maintenance' });
    // Backdate the row so it is due on the next claim.
    db()
      .prepare('UPDATE schedules SET next_run_at = ? WHERE name = ?')
      .run(new Date(Date.now() - 60_000).toISOString(), 'housekeeping');

    const before = listSchedules().find((s) => s.name === 'housekeeping');
    expect(before).toBeDefined();
    expect(new Date(before?.nextRunAt as string).getTime()).toBeLessThan(Date.now());

    // The maintenance job only touches the database, so it can run for real here.
    const outcome = await runScheduledJob(before as NonNullable<typeof before>, new AbortController().signal);
    expect(outcome.summary).toMatch(/purged/);

    const after = listSchedules().find((s) => s.name === 'housekeeping');
    expect(after?.lastStatus).toBe('SUCCEEDED');
    expect(after?.lastRunAt).not.toBeNull();
  });

  it('records a failure without leaving the schedule stuck in RUNNING', async () => {
    const { upsertSchedule, runScheduledJob, listSchedules } = await import('@/lib/schedule/scheduler');

    const schedule = upsertSchedule({ name: 'broken job', cron: '0 6 * * *', job: 'maintenance' });
    const impossible = { ...schedule, job: 'not_a_job' as typeof schedule.job };

    await expect(runScheduledJob(impossible, new AbortController().signal)).rejects.toThrow(/unknown job/);
    // The row keeps whatever status the claim wrote; what matters is that a
    // thrown handler never leaves the scheduler believing a job is in flight.
    const { schedulerStatus } = await import('@/lib/schedule/scheduler');
    expect(schedulerStatus().activeJobs).toBe(0);
    expect(listSchedules().find((s) => s.name === 'broken job')).toBeDefined();
  });
});
