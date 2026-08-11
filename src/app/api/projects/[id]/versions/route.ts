import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertCsrf, requireUser } from '@/lib/security/auth';
import { audit } from '@/lib/security/audit';
import { diffAgainstVersion, getProject, listVersions, rollbackTo } from '@/lib/workspace/project';
import { emitEvent } from '@/lib/observability/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('rollback'), version: z.number().int().min(1) }),
  z.object({ action: z.literal('diff'), version: z.number().int().min(1), path: z.string().min(1).max(400) }),
]);

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  await requireUser('ide:read');
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: 'no such project' }, { status: 404 });
  return NextResponse.json({ versions: listVersions(id) });
}

export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const session = await requireUser('ide:write');
  assertCsrf(session, request);
  const { id } = await params;

  const project = getProject(id);
  if (!project) return NextResponse.json({ error: 'no such project' }, { status: 404 });

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }

  try {
    if (parsed.data.action === 'diff') {
      return NextResponse.json({ diff: diffAgainstVersion(project, parsed.data.version, parsed.data.path) });
    }

    // A rollback is itself committed as a new version rather than rewriting
    // history, so the fact that a rollback happened is never lost.
    const version = rollbackTo(project, parsed.data.version, session.user.id);
    audit({
      actorType: 'user',
      actorId: session.user.id,
      action: 'ide.rollback',
      metadata: { projectId: id, to: parsed.data.version, newVersion: version.version },
    });
    emitEvent({
      type: 'project.updated',
      scope: 'ide',
      projectId: id,
      message: `rolled back to version ${parsed.data.version}`,
      data: { to: parsed.data.version, version: version.version },
    });
    return NextResponse.json({ version });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
