import { redirect } from 'next/navigation';
import { getSession } from '@/lib/security/auth';
import { capabilityReport } from '@/lib/config/capabilities';
import { budgetState, usageSince, startOfUtcDay } from '@/lib/ai/usage';
import { listRuns } from '@/lib/orchestrator/factory';
import { listProjects } from '@/lib/workspace/project';
import { listOpportunities } from '@/lib/market/gaps';
import { listTrends } from '@/lib/market/trends';
import { documentCount } from '@/lib/research/store';
import { measureQuality } from '@/lib/improvement/engine';
import { StartRun } from './start-run';
import { ActivityFeed } from './activity-feed';

export const dynamic = 'force-dynamic';

const STATUS_PILL: Record<string, string> = {
  READY: 'ok', SUCCEEDED: 'ok',
  RUNNING: 'run', BUILDING: 'run', TESTING: 'run', GENERATING: 'run',
  AWAITING_APPROVAL: 'warn', PROPOSED: 'warn',
  FAILED: 'fail', CANCELLED: 'fail',
};

function pill(status: string): string {
  return STATUS_PILL[status] ?? 'idle';
}

export default async function OverviewPage(): Promise<React.ReactElement> {
  const session = await getSession();
  if (!session) redirect('/login');

  const report = capabilityReport();
  const budget = budgetState();
  const today = usageSince(startOfUtcDay());
  const runs = listRuns(8);
  const projects = listProjects({ limit: 6 });
  const opportunities = listOpportunities({ limit: 6 });
  const trends = listTrends(6);
  const quality = measureQuality();
  const blocking = report.capabilities.filter((c) => c.state === 'unavailable');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Factory overview</h1>
          <p className="lede">
            {documentCount()} research documents indexed · {trends.length} live trends · {projects.length} products in the workspace.
          </p>
        </div>
        <StartRun canRun={session.user.permissions.includes('factory:run')} />
      </div>

      {blocking.length > 0 ? (
        <div className="notice" style={{ marginBottom: 18 }}>
          <strong>{blocking.length} capability {blocking.length === 1 ? 'is' : 'are'} unavailable.</strong>{' '}
          {blocking.map((c) => c.title).join(', ')}. The factory will refuse the steps that depend on them rather than
          producing invented results. <a href="/health">See what to configure →</a>
        </div>
      ) : null}

      <div className="grid cols-4">
        <div className="card tight">
          <div className="metric-label">Spend today</div>
          <div className="metric">${today.costUsd.toFixed(2)}</div>
          <div className="metric-note">of ${budget.costLimit.toFixed(2)} budget · {today.calls} calls</div>
        </div>
        <div className="card tight">
          <div className="metric-label">Cache hit rate</div>
          <div className="metric">{(quality.cacheHitRate * 100).toFixed(0)}%</div>
          <div className="metric-note">${today.savedUsd.toFixed(2)} avoided today</div>
        </div>
        <div className="card tight">
          <div className="metric-label">Build success</div>
          <div className="metric">{(quality.buildSuccessRate * 100).toFixed(0)}%</div>
          <div className="metric-note">runtime pass {(quality.runtimePassRate * 100).toFixed(0)}%</div>
        </div>
        <div className="card tight">
          <div className="metric-label">Cost per product</div>
          <div className="metric">${quality.meanCostUsdPerProduct.toFixed(2)}</div>
          <div className="metric-note">{quality.products} products generated</div>
        </div>
      </div>

      <div className="grid cols-2" style={{ marginTop: 22 }}>
        <div>
          <h2>Recent runs</h2>
          <div className="card" style={{ padding: 0 }}>
            {runs.length === 0 ? (
              <div className="empty">No runs yet. Start one above.</div>
            ) : (
              <table>
                <thead>
                  <tr><th>Objective</th><th>Step</th><th>Status</th><th>Cost</th></tr>
                </thead>
                <tbody>
                  {runs.map((run) => (
                    <tr key={run.id}>
                      <td>
                        {run.objective || '—'}
                        {run.summary ? <div className="faint" style={{ fontSize: 12 }}>{run.summary}</div> : null}
                        {run.error ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{run.error}</div> : null}
                      </td>
                      <td className="mono dim">{run.currentStep || '—'}</td>
                      <td><span className={`pill ${pill(run.status)}`}>{run.status}</span></td>
                      <td className="mono dim">${run.costUsd.toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>

          <h2>Top opportunities</h2>
          <div className="card" style={{ padding: 0 }}>
            {opportunities.length === 0 ? (
              <div className="empty">No scored opportunities yet.</div>
            ) : (
              <table>
                <thead><tr><th>Opportunity</th><th>Form</th><th>Score</th></tr></thead>
                <tbody>
                  {opportunities.map((opportunity) => (
                    <tr key={opportunity.id}>
                      <td>
                        {opportunity.title}
                        <div className="faint" style={{ fontSize: 12 }}>{opportunity.rationale.split('\n')[0]}</div>
                      </td>
                      <td className="mono dim">{opportunity.productForm}</td>
                      <td>
                        <span className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{opportunity.opportunityScore.toFixed(1)}</span>
                        <div className="bar" style={{ marginTop: 4, width: 70 }}>
                          <i style={{ width: `${Math.min(100, opportunity.opportunityScore)}%` }} />
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>

        <div>
          <h2>Live activity</h2>
          <ActivityFeed />

          <h2>Products</h2>
          <div className="card" style={{ padding: 0 }}>
            {projects.length === 0 ? (
              <div className="empty">Nothing generated yet.</div>
            ) : (
              <table>
                <thead><tr><th>Product</th><th>Kind</th><th>Status</th></tr></thead>
                <tbody>
                  {projects.map((project) => (
                    <tr key={project.id}>
                      <td><a href={`/projects/${project.id}`}>{project.name}</a>
                        <div className="faint" style={{ fontSize: 12 }}>{project.description}</div>
                      </td>
                      <td className="mono dim">{project.kind}</td>
                      <td><span className={`pill ${pill(project.status)}`}>{project.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
