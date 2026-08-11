import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/security/auth';
import { getProject, listVersions } from '@/lib/workspace/project';
import { listArtifacts, listBuilds, readBuildLog } from '@/lib/build/store';
import { listAssets } from '@/lib/generation/assets';
import { listTestRuns } from '@/lib/qa/runtime';
import { isPreviewBuilt } from '@/lib/preview/server';
import { usageForProject } from '@/lib/ai/usage';
import { db, fromJson } from '@/lib/db/client';

export const dynamic = 'force-dynamic';

interface ConceptRow {
  decision_summary: string;
  similarity_report: string;
  originality_score: number;
  usp: string;
  core_problem: string;
}

/** The product artifact page: what was built, why, and proof that it works. */
export default async function ProjectPage({ params }: { params: Promise<{ id: string }> }): Promise<React.ReactElement> {
  const session = await getSession();
  if (!session) redirect('/login');

  const { id } = await params;
  const project = getProject(id);
  if (!project) notFound();

  const builds = listBuilds(project.id, 10);
  const artifacts = listArtifacts(project.id);
  const assets = listAssets(project.id);
  const tests = listTestRuns(project.id, 5);
  const versions = listVersions(project.id).slice(0, 8);
  const usage = usageForProject(project.id);
  const apk = artifacts.find((a) => a.kind === 'apk');
  const previewReady = isPreviewBuilt(project);
  const latestBuild = builds[0];
  const runtime = tests.find((t) => t.suite === 'runtime');

  const concept = project.conceptId
    ? db().prepare<[string], ConceptRow>('SELECT decision_summary, similarity_report, originality_score, usp, core_problem FROM product_concepts WHERE id = ?').get(project.conceptId)
    : undefined;
  const decisions = concept ? fromJson<Record<string, string>>(concept.decision_summary, {}) : {};
  const similarity = concept ? fromJson<Record<string, unknown>>(concept.similarity_report, {}) : {};

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{project.name}</h1>
          <p className="lede">{project.description}</p>
          <div className="mono faint" style={{ fontSize: 12, marginTop: 6 }}>
            {project.kind} · v{project.versionName} (build {project.version}) · {project.applicationId}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          {apk ? (
            <a className="button" data-variant="primary" href={`/api/artifacts/${apk.id}`}>Download APK</a>
          ) : null}
        </div>
      </div>

      <div className="grid cols-4">
        <div className="card tight">
          <div className="metric-label">Status</div>
          <div className="metric" style={{ fontSize: 18 }}>{project.status}</div>
        </div>
        <div className="card tight">
          <div className="metric-label">Runtime checks</div>
          <div className="metric" style={{ fontSize: 18 }}>{runtime ? `${runtime.passed}/${runtime.total}` : '—'}</div>
          <div className="metric-note">{runtime ? runtime.status : 'not run'}</div>
        </div>
        <div className="card tight">
          <div className="metric-label">Assets</div>
          <div className="metric" style={{ fontSize: 18 }}>{assets.length}</div>
          <div className="metric-note">{assets.filter((a) => a.validated).length} validated</div>
        </div>
        <div className="card tight">
          <div className="metric-label">Cost</div>
          <div className="metric" style={{ fontSize: 18 }}>${usage.costUsd.toFixed(2)}</div>
          <div className="metric-note">{usage.calls} API calls · {usage.cacheHits} cached</div>
        </div>
      </div>

      <h2>Live preview</h2>
      {previewReady ? (
        <div className="card" style={{ padding: 8 }}>
          <iframe
            title={`${project.name} preview`}
            src={`/api/projects/${project.id}/preview/index.html`}
            // The generated product is untrusted: it runs sandboxed, without
            // same-origin access to the console.
            sandbox="allow-scripts allow-pointer-lock"
            style={{ width: '100%', aspectRatio: project.kind === 'game' ? '16 / 9' : '9 / 16', maxHeight: '70vh', border: 0, borderRadius: 8, background: '#000' }}
          />
        </div>
      ) : (
        <div className="notice">No web build output yet, so there is nothing to preview. The preview always serves the real build — never a screenshot.</div>
      )}

      {concept ? (
        <>
          <h2>Why this product</h2>
          <div className="grid cols-2">
            <div className="card">
              <h3>Decisions</h3>
              {Object.entries(decisions).filter(([, value]) => value).map(([key, value]) => (
                <p key={key} style={{ margin: '0 0 10px', fontSize: 13.5 }}>
                  <span className="faint mono" style={{ fontSize: 11, display: 'block' }}>{key.replace(/([A-Z])/g, ' $1').toLowerCase()}</span>
                  {value}
                </p>
              ))}
            </div>
            <div className="card">
              <h3>Originality</h3>
              <div className="metric">{((concept.originality_score ?? 0) * 100).toFixed(0)}%</div>
              <p className="dim" style={{ fontSize: 13 }}>
                Measured against every incumbent found during competitive research and every product this factory has
                previously generated. Closest incumbent: <span className="mono">{String(similarity.closestCompetitor ?? '—')}</span>{' '}
                ({((Number(similarity.competitorSimilarity ?? 0)) * 100).toFixed(0)}%). Closest prior product:{' '}
                <span className="mono">{String(similarity.closestPriorConcept ?? '—')}</span>{' '}
                ({((Number(similarity.priorSimilarity ?? 0)) * 100).toFixed(0)}%).
              </p>
              <p className="dim" style={{ fontSize: 13 }}><strong>USP.</strong> {concept.usp}</p>
            </div>
          </div>
        </>
      ) : null}

      <h2>Builds and artifacts</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Target</th><th>Status</th><th>Duration</th><th>Artifact</th></tr></thead>
          <tbody>
            {builds.length === 0 ? (
              <tr><td colSpan={4} className="empty">No builds yet.</td></tr>
            ) : builds.map((build) => {
              const artifact = artifacts.find((a) => a.buildId === build.id);
              return (
                <tr key={build.id}>
                  <td className="mono">{build.target} <span className="faint">{build.mode}</span></td>
                  <td><span className={`pill ${build.status === 'SUCCEEDED' ? 'ok' : build.status === 'RUNNING' ? 'run' : 'fail'}`}>{build.status}</span>
                    {build.errorSummary ? <div style={{ fontSize: 12, color: 'var(--danger)' }}>{build.errorSummary}</div> : null}
                  </td>
                  <td className="mono dim">{(build.durationMs / 1000).toFixed(1)}s</td>
                  <td className="mono dim">
                    {artifact ? (
                      <a href={`/api/artifacts/${artifact.id}`}>{artifact.filename}</a>
                    ) : '—'}
                    {artifact ? <div className="faint" style={{ fontSize: 11 }}>sha256 {artifact.sha256}</div> : null}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {runtime ? (
        <>
          <h2>Runtime validation</h2>
          <div className="card" style={{ padding: 0 }}>
            <table>
              <thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead>
              <tbody>
                {(fromJson<Array<{ name: string; status: string; detail: string; critical: boolean }>>(JSON.stringify(runtime.report.checks ?? []), []))
                  .map((check) => (
                    <tr key={check.name}>
                      <td className="mono">{check.name}{check.critical ? '' : ' *'}</td>
                      <td><span className={`pill ${check.status === 'passed' ? 'ok' : check.status === 'failed' ? 'fail' : 'idle'}`}>{check.status}</span></td>
                      <td className="dim">{check.detail}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <p className="faint" style={{ fontSize: 12 }}>* non-blocking check</p>
        </>
      ) : null}

      <h2>Version history</h2>
      <div className="card" style={{ padding: 0 }}>
        <table>
          <thead><tr><th>Version</th><th>Change</th><th>Author</th><th>Files</th></tr></thead>
          <tbody>
            {versions.length === 0 ? (
              <tr><td colSpan={4} className="empty">No versions recorded.</td></tr>
            ) : versions.map((version) => (
              <tr key={version.id}>
                <td className="mono">v{version.version}</td>
                <td>{version.label}<div className="faint" style={{ fontSize: 12 }}>{version.summary}</div></td>
                <td className="mono dim">{version.authorType}:{version.authorId}</td>
                <td className="mono dim">{version.diffStats.files}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {latestBuild ? (
        <>
          <h2>Latest build log</h2>
          <div className="log">{readBuildLog(latestBuild.id, 60_000) || 'No log output.'}</div>
        </>
      ) : null}
    </>
  );
}
