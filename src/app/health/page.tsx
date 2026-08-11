import { redirect } from 'next/navigation';
import { getSession } from '@/lib/security/auth';
import { capabilityReport } from '@/lib/config/capabilities';
import { androidToolchain } from '@/lib/build/toolchain';
import { browserStatus } from '@/lib/qa/browser';
import { cacheStats } from '@/lib/cache';
import { errorMemoryStats } from '@/lib/knowledge/error-memory';
import { measureQuality, listProposals } from '@/lib/improvement/engine';
import { breakerSnapshot } from '@/lib/providers/http';
import { activeModelSummary } from '@/lib/ai/router';
import { recentLogs } from '@/lib/observability/logger';

export const dynamic = 'force-dynamic';

const STATE_PILL: Record<string, string> = { ready: 'ok', degraded: 'warn', unavailable: 'fail' };

export default async function HealthPage(): Promise<React.ReactElement> {
  const session = await getSession();
  if (!session) redirect('/login');

  const report = capabilityReport();
  const android = androidToolchain();
  const browser = browserStatus();
  const cache = cacheStats();
  const memory = errorMemoryStats();
  const quality = measureQuality();
  const circuits = breakerSnapshot();
  const models = activeModelSummary();
  const proposals = listProposals(undefined, 8);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>System health</h1>
          <p className="lede">
            What this installation can actually do right now. A capability marked unavailable is refused at the point of
            use — the factory never substitutes invented output for a missing dependency.
          </p>
        </div>
      </div>

      <h2>Capabilities</h2>
      <div className="grid cols-2">
        {report.capabilities.map((capability) => (
          <div className="card" key={capability.id}>
            <div className="card-head">
              <h3>{capability.title}</h3>
              <span className={`pill ${STATE_PILL[capability.state] ?? 'idle'}`}>{capability.state}</span>
            </div>
            <p className="dim" style={{ margin: '0 0 8px', fontSize: 13.5 }}>{capability.summary}</p>
            {capability.blocks.length > 0 ? (
              <p className="faint" style={{ margin: '0 0 8px', fontSize: 12.5 }}>
                Blocked: {capability.blocks.join(', ')}
              </p>
            ) : null}
            {capability.remedy.length > 0 ? (
              <ul className="mono faint" style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
                {capability.remedy.map((line) => <li key={line}>{line}</li>)}
              </ul>
            ) : null}
          </div>
        ))}
      </div>

      <h2>Toolchain</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Component</th><th>State</th><th>Detail</th></tr></thead>
          <tbody>
            {[
              ['JDK', android.java],
              ['Gradle', android.gradle],
              ['Android SDK', android.sdk],
              ['Platform', android.platform],
              ['Build tools', android.buildTools],
              ['apksigner', android.apksigner],
              ['Signing keystore', android.keystore],
            ].map(([label, info]) => {
              const tool = info as { available: boolean; detail: string; version?: string };
              return (
                <tr key={label as string}>
                  <td>{label as string}</td>
                  <td><span className={`pill ${tool.available ? 'ok' : 'fail'}`}>{tool.available ? 'ready' : 'missing'}</span></td>
                  <td className="dim">{tool.detail}</td>
                </tr>
              );
            })}
            <tr>
              <td>Headless browser</td>
              <td><span className={`pill ${browser.available ? 'ok' : 'fail'}`}>{browser.available ? 'ready' : 'missing'}</span></td>
              <td className="dim">{browser.detail}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <div className="grid cols-3" style={{ marginTop: 22 }}>
        <div className="card tight">
          <div className="metric-label">Model routing</div>
          <div className="mono dim" style={{ fontSize: 12.5, marginTop: 6 }}>
            provider {models.provider} {models.configured ? '' : '(unconfigured)'}<br />
            fast {models.models.fast}<br />
            balanced {models.models.balanced}<br />
            deep {models.models.deep}
          </div>
        </div>
        <div className="card tight">
          <div className="metric-label">Cache</div>
          <div className="metric">{cache.l2Entries}</div>
          <div className="metric-note">{cache.totalHits} hits · {(cache.l2Bytes / 1_048_576).toFixed(1)} MB persisted</div>
        </div>
        <div className="card tight">
          <div className="metric-label">Error memory</div>
          <div className="metric">{memory.resolved}/{memory.total}</div>
          <div className="metric-note">
            remedies verified · {memory.recurrences} recurrences · reused {memory.reuse} times
          </div>
        </div>
      </div>

      <h2>Output quality</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <tbody>
            {Object.entries(quality)
              .filter(([key]) => key !== 'capturedAt')
              .map(([key, value]) => (
                <tr key={key}>
                  <td className="dim">{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</td>
                  <td className="mono">{typeof value === 'number' ? value.toLocaleString() : String(value)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>

      {proposals.length > 0 ? (
        <>
          <h2>Self-improvement proposals</h2>
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead><tr><th>Improvement</th><th>Area</th><th>Risk</th><th>Status</th></tr></thead>
              <tbody>
                {proposals.map((proposal) => (
                  <tr key={proposal.id}>
                    <td>{proposal.title}<div className="faint" style={{ fontSize: 12 }}>{proposal.expectedGain}</div></td>
                    <td className="mono dim">{proposal.area}</td>
                    <td className="mono dim">{proposal.risk}</td>
                    <td><span className={`pill ${proposal.status === 'applied' ? 'ok' : proposal.status === 'rejected' ? 'fail' : 'warn'}`}>{proposal.status}</span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : null}

      {circuits.some((c) => c.state !== 'closed') ? (
        <>
          <h2>Circuit breakers</h2>
          <div className="notice">
            {circuits.filter((c) => c.state !== 'closed').map((c) => `${c.target}: ${c.state} after ${c.failures} failures`).join(' · ')}
          </div>
        </>
      ) : null}

      <h2>Recent log</h2>
      <div className="log">
        {recentLogs(60, 'info').map((entry) => `${entry.ts} ${entry.level.toUpperCase().padEnd(5)} [${entry.scope}] ${entry.msg}`).join('\n') || 'No log entries yet.'}
      </div>
    </>
  );
}
