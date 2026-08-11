import { redirect } from 'next/navigation';
import { getSession } from '@/lib/security/auth';
import { listProjects } from '@/lib/workspace/project';
import { listArtifacts } from '@/lib/build/store';

export const dynamic = 'force-dynamic';

const PILL: Record<string, string> = { READY: 'ok', FAILED: 'fail', BUILDING: 'run', TESTING: 'run', GENERATING: 'run' };

export default async function ProjectsPage(): Promise<React.ReactElement> {
  const session = await getSession();
  if (!session) redirect('/login');
  const projects = listProjects({ limit: 100 });

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Products</h1>
          <p className="lede">Every product the factory has generated, with its build artifacts and current state.</p>
        </div>
      </div>

      {projects.length === 0 ? (
        <div className="empty">No products yet. Start a run from the overview.</div>
      ) : (
        <div className="grid cols-2">
          {projects.map((project) => {
            const artifacts = listArtifacts(project.id);
            const apk = artifacts.find((a) => a.kind === 'apk');
            return (
              <div className="card" key={project.id}>
                <div className="card-head">
                  <h3><a href={`/projects/${project.id}`}>{project.name}</a></h3>
                  <span className={`pill ${PILL[project.status] ?? 'idle'}`}>{project.status}</span>
                </div>
                <p className="dim" style={{ margin: '0 0 10px', fontSize: 13.5 }}>{project.description}</p>
                <div className="mono faint" style={{ fontSize: 12 }}>
                  {project.kind} · v{project.versionName} · {project.applicationId}
                </div>
                {apk ? (
                  <div className="mono dim" style={{ fontSize: 12, marginTop: 8 }}>
                    APK {(apk.bytes / 1_048_576).toFixed(1)} MB · sha256 {apk.sha256.slice(0, 16)}…
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}
