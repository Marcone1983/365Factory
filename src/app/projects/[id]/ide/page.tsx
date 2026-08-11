import { notFound, redirect } from 'next/navigation';
import { getSession } from '@/lib/security/auth';
import { getProject, listVersions } from '@/lib/workspace/project';
import { listIndexedFiles } from '@/lib/ide/repo-index';
import { IdeClient } from './ide-client';

export const dynamic = 'force-dynamic';

/**
 * The IDE.
 *
 * It reads the same index the coding agent uses, so what an operator sees and
 * what the agent reasons over are the same view of the project. An operator edit
 * commits a version exactly like an agent edit, which is what makes rollback
 * meaningful regardless of who made the change.
 */
export default async function IdePage({ params }: { params: Promise<{ id: string }> }): Promise<React.ReactElement> {
  const session = await getSession();
  if (!session) redirect('/login');
  if (!session.user.permissions.includes('ide:read')) redirect(`/projects/${(await params).id}`);

  const { id } = await params;
  const project = getProject(id);
  if (!project) notFound();

  const files = listIndexedFiles(project.id);
  const versions = listVersions(project.id);
  const canWrite = session.user.permissions.includes('ide:write');

  return (
    <>
      <div className="page-head">
        <div>
          <h1>{project.name}</h1>
          <p className="lede">
            {files.length} indexed files · {versions.length} versions ·{' '}
            <a href={`/projects/${project.id}`}>back to the product</a>
          </p>
        </div>
        {!canWrite ? <span className="pill idle">read only</span> : null}
      </div>

      {files.length === 0 ? (
        <div className="notice" style={{ marginBottom: 18 }}>
          <strong>This project has no indexed source.</strong> The index is written when the coding agent generates or
          modifies files; until a run has produced source, there is nothing to open.
        </div>
      ) : null}

      <IdeClient
        projectId={project.id}
        canWrite={canWrite}
        files={files.map((file) => ({
          path: file.path,
          language: file.language,
          size: file.size,
          summary: file.summary,
          symbols: file.symbols.map((s) => ({ name: s.name, kind: s.kind, line: s.line })),
        }))}
        versions={versions.map((version) => ({
          version: version.version,
          label: version.label,
          summary: version.summary,
          authorType: version.authorType,
          createdAt: version.createdAt,
          diffStats: version.diffStats,
        }))}
      />
    </>
  );
}
