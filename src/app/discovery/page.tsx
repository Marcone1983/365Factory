import { redirect } from 'next/navigation';
import { getSession } from '@/lib/security/auth';
import { acceptanceThreshold, gapEvidence, listGaps, listOpportunities } from '@/lib/market/gaps';
import { listTrends } from '@/lib/market/trends';
import { documentCount } from '@/lib/research/store';
import { capabilityReport } from '@/lib/config/capabilities';

export const dynamic = 'force-dynamic';

/**
 * Market discovery.
 *
 * Everything here is read from the database and traced back to the document it
 * came from. A gap shows the verbatim quote that supports it and a link to the
 * page it was fetched from, so an operator can check any claim against its
 * source rather than trusting a score.
 */
export default async function DiscoveryPage(): Promise<React.ReactElement> {
  const session = await getSession();
  if (!session) redirect('/login');

  const trends = listTrends(12);
  const gaps = listGaps({ limit: 12 });
  const opportunities = listOpportunities({ limit: 12 });
  const threshold = acceptanceThreshold();
  const documents = documentCount();
  const research = capabilityReport().capabilities.find((c) => c.id === 'web_research');

  // Provenance for the strongest gaps: the quotes that actually support them.
  const evidence = gaps.slice(0, 5).map((gap) => ({ gap, entries: gapEvidence(gap.id).slice(0, 4) }));

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Discovery</h1>
          <p className="lede">
            {documents} indexed documents · {trends.length} trends · {gaps.length} gaps · {opportunities.length} scored
            opportunities. Every figure below is stored evidence, not an estimate.
          </p>
        </div>
      </div>

      {documents === 0 ? (
        <div className="notice" style={{ marginBottom: 18 }}>
          <strong>No research has been performed yet.</strong>{' '}
          {research && research.state !== 'ready'
            ? `Web research is ${research.state}: ${research.summary}`
            : 'Start a run from the overview to populate this page.'}{' '}
          Nothing is shown here until real documents have been fetched and indexed.
        </div>
      ) : null}

      <h2>Scored opportunities</h2>
      {opportunities.length === 0 ? (
        <div className="empty">No opportunity has been scored yet.</div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Opportunity</th>
                <th>Form</th>
                <th style={{ width: 150 }}>Score</th>
                <th style={{ width: 110 }}>Status</th>
              </tr>
            </thead>
            <tbody>
              {opportunities.map((opportunity) => {
                const accepted = opportunity.opportunityScore >= threshold;
                return (
                  <tr key={opportunity.id}>
                    <td>
                      <strong>{opportunity.title}</strong>
                      <div className="dim" style={{ fontSize: 12.5, marginTop: 3 }}>{opportunity.rationale}</div>
                    </td>
                    <td className="mono">{opportunity.productForm}</td>
                    <td>
                      <div className="mono" style={{ marginBottom: 4 }}>
                        {opportunity.opportunityScore.toFixed(3)}{' '}
                        <span className="faint">/ {threshold} needed</span>
                      </div>
                      <div className="bar">
                        <i
                          style={{
                            width: `${Math.min(100, opportunity.opportunityScore * 100)}%`,
                            background: accepted ? 'var(--ok)' : 'var(--warn)',
                          }}
                        />
                      </div>
                    </td>
                    <td>
                      <span className={`pill ${accepted ? 'ok' : 'warn'}`}>{opportunity.status}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <h2>Market gaps and their evidence</h2>
      {evidence.length === 0 ? (
        <div className="empty">No gap has been detected yet.</div>
      ) : (
        <div className="grid" style={{ gap: 12 }}>
          {evidence.map(({ gap, entries }) => (
            <div className="card" key={gap.id}>
              <div className="card-head">
                <div>
                  <h3 style={{ marginBottom: 2 }}>{gap.title}</h3>
                  <div className="faint mono" style={{ fontSize: 11.5 }}>
                    {gap.gapType} · {gap.audience} · {gap.category}
                  </div>
                </div>
                <span className={`pill ${gap.confidence >= 0.6 ? 'ok' : gap.confidence >= 0.35 ? 'warn' : 'idle'}`}>
                  {gap.evidenceCount} sources · {(gap.confidence * 100).toFixed(0)}%
                </span>
              </div>
              <p className="dim" style={{ margin: '0 0 10px', fontSize: 13.5 }}>{gap.description}</p>

              {entries.length === 0 ? (
                <div className="faint" style={{ fontSize: 12.5 }}>
                  No evidence rows are attached to this gap.
                </div>
              ) : (
                <div style={{ display: 'grid', gap: 8 }}>
                  {entries.map((entry) => (
                    <div key={entry.signalId} style={{ borderLeft: '2px solid var(--border-bright)', paddingLeft: 10 }}>
                      <div style={{ fontSize: 13 }}>{entry.statement}</div>
                      {/* The quote is verified verbatim against the fetched document
                          before a signal is stored, so it can be shown as a quote. */}
                      <div className="dim" style={{ fontSize: 12.5, fontStyle: 'italic', margin: '3px 0' }}>
                        “{entry.quote}”
                      </div>
                      <a className="mono" style={{ fontSize: 11.5 }} href={entry.url} target="_blank" rel="noreferrer noopener">
                        {entry.title || entry.url}
                      </a>{' '}
                      <span className="faint mono" style={{ fontSize: 11.5 }}>
                        · {entry.sourceCategory} · weight {entry.weight.toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      <h2>Trends</h2>
      {trends.length === 0 ? (
        <div className="empty">No trend has been detected yet.</div>
      ) : (
        <div className="card">
          <table>
            <thead>
              <tr>
                <th>Trend</th>
                <th style={{ width: 130 }}>Category</th>
                <th style={{ width: 90 }}>Signals</th>
                <th style={{ width: 160 }}>Momentum</th>
                <th style={{ width: 120 }}>Last seen</th>
              </tr>
            </thead>
            <tbody>
              {trends.map((trend) => (
                <tr key={trend.id}>
                  <td>
                    <strong>{trend.label}</strong>
                    <div className="dim" style={{ fontSize: 12.5, marginTop: 3 }}>{trend.description}</div>
                  </td>
                  <td className="mono">{trend.category}</td>
                  <td className="mono">{trend.signalCount}</td>
                  <td>
                    <div className="mono" style={{ marginBottom: 4 }}>{trend.momentum.toFixed(3)}</div>
                    <div className="bar">
                      <i style={{ width: `${Math.min(100, Math.max(0, trend.momentum * 100))}%` }} />
                    </div>
                  </td>
                  <td className="mono faint">{trend.lastSeenAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
