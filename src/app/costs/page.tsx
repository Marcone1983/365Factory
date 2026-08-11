import { redirect } from 'next/navigation';
import { getSession } from '@/lib/security/auth';
import {
  budgetState,
  dailyUsage,
  recentFailures,
  startOfUtcDay,
  usageBreakdown,
  usageSince,
  type UsageBreakdownRow,
} from '@/lib/ai/usage';
import { cacheStats } from '@/lib/cache';
import { activeModelSummary, taskCatalogue } from '@/lib/ai/router';

export const dynamic = 'force-dynamic';

function money(value: number): string {
  if (value === 0) return '$0.00';
  return value < 0.01 ? `$${value.toFixed(5)}` : `$${value.toFixed(2)}`;
}

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(value);
}

function BreakdownTable({ title, rows, label }: { title: string; rows: readonly UsageBreakdownRow[]; label: string }): React.ReactElement {
  return (
    <div className="card">
      <div className="card-head">
        <h3 style={{ margin: 0 }}>{title}</h3>
      </div>
      {rows.length === 0 ? (
        <div className="empty">Nothing recorded in this window.</div>
      ) : (
        <table>
          <thead>
            <tr>
              <th>{label}</th>
              <th style={{ width: 70 }}>Calls</th>
              <th style={{ width: 90 }}>Cost</th>
              <th style={{ width: 90 }}>Avoided</th>
              <th style={{ width: 80 }}>Cached</th>
              <th style={{ width: 80 }}>Errors</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key}>
                <td className="mono">{row.key}</td>
                <td className="mono">{row.calls}</td>
                <td className="mono">{money(row.costUsd)}</td>
                <td className="mono" style={{ color: row.savedUsd > 0 ? 'var(--ok)' : undefined }}>
                  {money(row.savedUsd)}
                </td>
                <td className="mono">
                  {row.calls > 0 ? `${((row.cacheHits / row.calls) * 100).toFixed(0)}%` : '—'}
                </td>
                <td className="mono" style={{ color: row.errors > 0 ? 'var(--danger)' : undefined }}>
                  {row.errors}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/**
 * Cost and cache.
 *
 * Every number is summed from recorded API calls. Nothing is estimated: if the
 * platform has made no calls, the page says so rather than showing a plausible
 * looking figure.
 */
export default async function CostsPage(): Promise<React.ReactElement> {
  const session = await getSession();
  if (!session) redirect('/login');

  const today = usageSince(startOfUtcDay());
  const week = usageSince(new Date(Date.now() - 7 * 86_400_000).toISOString());
  const budget = budgetState();
  const cache = cacheStats();
  const daily = dailyUsage(14);
  const byOperation = usageBreakdown('operation', new Date(Date.now() - 7 * 86_400_000).toISOString());
  const byModel = usageBreakdown('model', new Date(Date.now() - 7 * 86_400_000).toISOString());
  const failures = recentFailures(8);
  const models = activeModelSummary();
  const tasks = taskCatalogue();

  const maxDaily = Math.max(0.000001, ...daily.map((d) => d.costUsd + d.savedUsd));
  const weekTotal = week.costUsd + week.savedUsd;
  const savedShare = weekTotal > 0 ? (week.savedUsd / weekTotal) * 100 : 0;
  const costPct = budget.costLimit > 0 ? Math.min(100, (budget.costUsed / budget.costLimit) * 100) : 0;
  const tokenPct = budget.tokenLimit > 0 ? Math.min(100, (budget.tokensUsed / budget.tokenLimit) * 100) : 0;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Cost &amp; cache</h1>
          <p className="lede">
            Summed from {compact(week.calls)} recorded API calls in the last seven days. Provider{' '}
            <span className="mono">{models.provider}</span>
            {models.configured ? '' : ' (not configured — no calls can be made)'}.
          </p>
        </div>
      </div>

      {week.calls === 0 ? (
        <div className="notice" style={{ marginBottom: 18 }}>
          <strong>No API calls have been recorded.</strong> Cost figures appear here once the factory has actually
          called a provider. Nothing on this page is estimated or projected.
        </div>
      ) : null}

      <div className="grid cols-4">
        <div className="card tight">
          <div className="metric-label">Spent today</div>
          <div className="metric">{money(today.costUsd)}</div>
          <div className="metric-note">{today.calls} calls · {compact(today.tokensIn + today.tokensOut)} tokens</div>
        </div>
        <div className="card tight">
          <div className="metric-label">Avoided today</div>
          <div className="metric" style={{ color: 'var(--ok)' }}>{money(today.savedUsd)}</div>
          <div className="metric-note">{today.cacheHits} of {today.calls} calls served from cache</div>
        </div>
        <div className="card tight">
          <div className="metric-label">Cost budget</div>
          <div className="metric">{costPct.toFixed(0)}%</div>
          <div className="bar" style={{ margin: '6px 0 4px' }}>
            <i style={{ width: `${costPct}%`, background: costPct > 85 ? 'var(--danger)' : 'var(--accent)' }} />
          </div>
          <div className="metric-note">{money(budget.costRemaining)} of {money(budget.costLimit)} left today</div>
        </div>
        <div className="card tight">
          <div className="metric-label">Token budget</div>
          <div className="metric">{tokenPct.toFixed(0)}%</div>
          <div className="bar" style={{ margin: '6px 0 4px' }}>
            <i style={{ width: `${tokenPct}%`, background: tokenPct > 85 ? 'var(--danger)' : 'var(--accent)' }} />
          </div>
          <div className="metric-note">{compact(budget.tokensRemaining)} of {compact(budget.tokenLimit)} left today</div>
        </div>
      </div>

      <h2>Spend and savings, last 14 days</h2>
      {daily.length === 0 ? (
        <div className="empty">No usage has been recorded in the last fourteen days.</div>
      ) : (
        <div className="card">
          {/* Solid bars are money actually spent; the lighter segment above each
              is what the cache avoided spending. Both come from recorded rows. */}
          <div className="chart">
            {daily.map((point) => (
              <div className="chart-col" key={point.day} title={`${point.day}: ${money(point.costUsd)} spent, ${money(point.savedUsd)} avoided, ${point.calls} calls`}>
                <div className="chart-stack">
                  <i className="saved" style={{ height: `${(point.savedUsd / maxDaily) * 100}%` }} />
                  <i className="spent" style={{ height: `${(point.costUsd / maxDaily) * 100}%` }} />
                </div>
                <span className="chart-label">{point.day.slice(5)}</span>
              </div>
            ))}
          </div>
          <div className="faint" style={{ fontSize: 12, marginTop: 10 }}>
            <span style={{ color: 'var(--accent)' }}>■</span> spent ·{' '}
            <span style={{ color: 'var(--ok)' }}>■</span> avoided by cache. Peak day {money(maxDaily)}.
          </div>
        </div>
      )}

      <h2>Where the money goes</h2>
      <div className="grid cols-2">
        <BreakdownTable title="By operation" rows={byOperation} label="Operation" />
        <BreakdownTable title="By model" rows={byModel} label="Model" />
      </div>

      <h2>Cache</h2>
      <div className="grid cols-4">
        <div className="card tight">
          <div className="metric-label">Stored entries</div>
          <div className="metric">{compact(cache.l2Entries)}</div>
          <div className="metric-note">{(cache.l2Bytes / 1024 / 1024).toFixed(1)} MB on disk</div>
        </div>
        <div className="card tight">
          <div className="metric-label">In memory</div>
          <div className="metric">{compact(cache.l1Entries)}</div>
          <div className="metric-note">{(cache.l1Bytes / 1024 / 1024).toFixed(1)} MB resident</div>
        </div>
        <div className="card tight">
          <div className="metric-label">Total hits</div>
          <div className="metric">{compact(cache.totalHits)}</div>
          <div className="metric-note">across {cache.namespaces.length} namespaces</div>
        </div>
        <div className="card tight">
          <div className="metric-label">Share avoided</div>
          <div className="metric" style={{ color: savedShare > 0 ? 'var(--ok)' : undefined }}>
            {savedShare.toFixed(0)}%
          </div>
          <div className="metric-note">of what seven days would have cost uncached</div>
        </div>
      </div>

      {cache.namespaces.length > 0 ? (
        <div className="card" style={{ marginTop: 14 }}>
          <table>
            <thead>
              <tr>
                <th>Namespace</th>
                <th style={{ width: 100 }}>Entries</th>
                <th style={{ width: 100 }}>Hits</th>
                <th style={{ width: 120 }}>Size</th>
              </tr>
            </thead>
            <tbody>
              {cache.namespaces.map((namespace) => (
                <tr key={namespace.namespace}>
                  <td className="mono">{namespace.namespace}</td>
                  <td className="mono">{namespace.entries}</td>
                  <td className="mono">{namespace.hits}</td>
                  <td className="mono faint">{(namespace.bytes / 1024).toFixed(0)} KB</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      <h2>Model routing</h2>
      <div className="card">
        <p className="dim" style={{ marginTop: 0, fontSize: 13.5 }}>
          Each task is routed to a model tier and given its own cache policy. Cheap, repetitive work runs on the fast
          tier and caches for hours; creative work runs on the deep tier and is never cached, because reusing an
          invention would produce the same product twice.
        </p>
        <table>
          <thead>
            <tr>
              <th>Task</th>
              <th style={{ width: 90 }}>Tier</th>
              <th style={{ width: 110 }}>Cache TTL</th>
              <th style={{ width: 90 }}>Semantic</th>
              <th style={{ width: 110 }}>Max output</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((task) => (
              <tr key={task.task}>
                <td>
                  <span className="mono">{task.task}</span>
                  <div className="faint" style={{ fontSize: 12 }}>{task.description}</div>
                </td>
                <td className="mono">{task.tier}</td>
                <td className="mono faint">
                  {task.cacheTtlSeconds === 0 ? 'never' : `${Math.round(task.cacheTtlSeconds / 3600)}h`}
                </td>
                <td className="mono faint">{task.semanticCache ? 'yes' : 'no'}</td>
                <td className="mono faint">{compact(task.maxOutputTokens)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {failures.length > 0 ? (
        <>
          <h2>Recent provider failures</h2>
          <div className="card">
            <table>
              <thead>
                <tr>
                  <th style={{ width: 170 }}>When</th>
                  <th style={{ width: 120 }}>Provider</th>
                  <th>Operation</th>
                  <th>Error</th>
                </tr>
              </thead>
              <tbody>
                {failures.map((failure, index) => (
                  <tr key={`${failure.ts}-${index}`}>
                    <td className="mono faint">{failure.ts.replace('T', ' ').slice(0, 19)}</td>
                    <td className="mono">{failure.provider}</td>
                    <td className="mono">{failure.operation}</td>
                    <td className="mono" style={{ color: 'var(--danger)' }}>{failure.errorCode ?? 'unknown'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
    </>
  );
}
