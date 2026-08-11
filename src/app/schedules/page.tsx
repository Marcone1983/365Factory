import { redirect } from 'next/navigation';
import { getSession } from '@/lib/security/auth';
import { installDefaultSchedules, schedulerStatus } from '@/lib/schedule/scheduler';
import { describeCron, isValidCron } from '@/lib/schedule/cron';
import { config } from '@/lib/config/env';
import { ScheduleControls } from './schedule-controls';

export const dynamic = 'force-dynamic';

const STATUS_PILL: Record<string, string> = {
  SUCCEEDED: 'ok',
  RUNNING: 'run',
  SKIPPED: 'warn',
  FAILED: 'fail',
};

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const delta = new Date(iso).getTime() - Date.now();
  const minutes = Math.round(Math.abs(delta) / 60_000);
  const label =
    minutes < 60
      ? `${minutes}m`
      : minutes < 1440
        ? `${Math.round(minutes / 60)}h`
        : `${Math.round(minutes / 1440)}d`;
  return delta >= 0 ? `in ${label}` : `${label} ago`;
}

/**
 * Automation.
 *
 * The scheduler is what makes the factory run without an operator. This page
 * shows its real state: whether it is running at all, what each job does, when
 * each next fires and how the last firing ended. When SCHEDULER_ENABLED is off,
 * the page says the jobs are dormant rather than showing schedules that look
 * live but never fire.
 */
export default async function SchedulesPage(): Promise<React.ReactElement> {
  const session = await getSession();
  if (!session) redirect('/login');

  // Ensure the environment's schedules exist before rendering, so a fresh
  // deployment shows its automation rather than an empty table.
  installDefaultSchedules();
  const status = schedulerStatus();
  const cfg = config();
  const canWrite = session.user.permissions.includes('schedule:write');
  const canTrigger = canWrite && session.user.permissions.includes('factory:run');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Automation</h1>
          <p className="lede">
            {status.schedules.length} jobs · {status.schedules.filter((s) => s.enabled).length} enabled ·{' '}
            {status.activeJobs} running now. Times are evaluated in UTC
            {cfg.SCHEDULER_TIMEZONE_OFFSET_MINUTES !== 0
              ? `, shifted by ${cfg.SCHEDULER_TIMEZONE_OFFSET_MINUTES} minutes`
              : ''}
            .
          </p>
        </div>
        <span className={`pill ${status.running ? 'run' : 'idle'}`}>{status.running ? 'running' : 'stopped'}</span>
      </div>

      {!status.enabled ? (
        <div className="notice" style={{ marginBottom: 18 }}>
          <strong>The scheduler is disabled.</strong> <span className="mono">SCHEDULER_ENABLED=false</span>, so none of
          the jobs below fire on their own — they are stored, not running. Set it to true and restart to make the
          factory autonomous, or run a job manually from here.
        </div>
      ) : null}

      <div className="card">
        <table>
          <thead>
            <tr>
              <th>Job</th>
              <th style={{ width: 200 }}>Schedule</th>
              <th style={{ width: 140 }}>Next run</th>
              <th style={{ width: 150 }}>Last run</th>
              <th style={{ width: 210 }}>{canWrite ? 'Controls' : 'State'}</th>
            </tr>
          </thead>
          <tbody>
            {status.schedules.map((schedule) => (
              <tr key={schedule.id}>
                <td>
                  <strong>{schedule.name}</strong>
                  <div className="faint mono" style={{ fontSize: 11.5, marginTop: 2 }}>{schedule.job}</div>
                </td>
                <td>
                  <div className="mono">{schedule.cron}</div>
                  <div className="faint" style={{ fontSize: 12 }}>
                    {isValidCron(schedule.cron) ? describeCron(schedule.cron) : 'unparseable expression'}
                  </div>
                </td>
                <td>
                  {schedule.enabled && schedule.nextRunAt ? (
                    <>
                      <div className="mono" style={{ fontSize: 12.5 }}>{schedule.nextRunAt.replace('T', ' ').slice(0, 16)}</div>
                      <div className="faint" style={{ fontSize: 12 }}>{relative(schedule.nextRunAt)}</div>
                    </>
                  ) : (
                    <span className="faint">—</span>
                  )}
                </td>
                <td>
                  {schedule.lastRunAt ? (
                    <>
                      <span className={`pill ${STATUS_PILL[schedule.lastStatus ?? ''] ?? 'idle'}`}>
                        {schedule.lastStatus ?? 'unknown'}
                      </span>
                      <div className="faint" style={{ fontSize: 12, marginTop: 3 }}>{relative(schedule.lastRunAt)}</div>
                    </>
                  ) : (
                    <span className="faint">never run</span>
                  )}
                </td>
                <td>
                  {canWrite ? (
                    <ScheduleControls
                      name={schedule.name}
                      enabled={schedule.enabled}
                      cron={schedule.cron}
                      canTrigger={canTrigger}
                    />
                  ) : (
                    <span className={`pill ${schedule.enabled ? 'ok' : 'idle'}`}>
                      {schedule.enabled ? 'enabled' : 'disabled'}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <h2>What each job does</h2>
      <div className="card">
        <table>
          <thead>
            <tr>
              <th style={{ width: 200 }}>Job</th>
              <th>Behaviour</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td className="mono">daily_market_scan</td>
              <td className="dim">Runs the pipeline through trend detection: searches, fetches, extracts verified signals and clusters them.</td>
            </tr>
            <tr>
              <td className="mono">gap_analysis</td>
              <td className="dim">Continues to competitive mapping: derives unmet needs from the clustered evidence and maps who already serves them.</td>
            </tr>
            <tr>
              <td className="mono">opportunity_selection</td>
              <td className="dim">Scores the gaps and selects the strongest one. A gap without enough independent evidence cannot pass the gate.</td>
            </tr>
            <tr>
              <td className="mono">product_generation</td>
              <td className="dim">Runs the full pipeline: invents the product, generates assets and code, builds, verifies at runtime and packages it.</td>
            </tr>
            <tr>
              <td className="mono">self_improvement</td>
              <td className="dim">Measures platform quality, reads the recorded failures, and proposes changes to the platform&apos;s own source. Applied automatically only in fully autonomous mode.</td>
            </tr>
            <tr>
              <td className="mono">maintenance</td>
              <td className="dim">Purges expired cache and HTTP entries, expired sessions and metrics older than thirty days, then checkpoints the database.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <p className="faint" style={{ fontSize: 12.5, marginTop: 14, maxWidth: '74ch' }}>
        A job whose window was missed while the platform was down fires once on the next tick rather than replaying every
        occurrence it slept through. Two occurrences of the same job never overlap: the second is skipped and recorded as
        such.
      </p>
    </>
  );
}
