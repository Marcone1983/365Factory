import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertCsrf, requireUser } from '@/lib/security/auth';
import { consumeDefault, RateLimitError } from '@/lib/security/ratelimit';
import { audit } from '@/lib/security/audit';
import { commitVersion, getProject, workspaceFor } from '@/lib/workspace/project';
import { unifiedDiff } from '@/lib/workspace/filesystem';
import { emitEvent } from '@/lib/observability/events';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const WriteBody = z.object({
  path: z.string().min(1).max(400),
  content: z.string().max(4 * 1024 * 1024),
  summary: z.string().min(1).max(300).optional(),
});

type Params = { params: Promise<{ id: string }> };

/**
 * Reads one file from a project workspace.
 *
 * The path is resolved by the workspace layer, which refuses anything that
 * escapes the project root. This route never touches the filesystem directly.
 */
export async function GET(request: Request, { params }: Params): Promise<NextResponse> {
  await requireUser('ide:read');
  const { id } = await params;
  const project = getProject(id);
  if (!project) return NextResponse.json({ error: 'no such project' }, { status: 404 });

  const filePath = new URL(request.url).searchParams.get('path');
  if (!filePath) return NextResponse.json({ error: 'path is required' }, { status: 400 });

  try {
    const content = workspaceFor(project, 'source').readText(filePath);
    return NextResponse.json({ path: filePath, content, bytes: Buffer.byteLength(content, 'utf8') });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 404 });
  }
}

/**
 * Writes a file and commits a version.
 *
 * Every operator edit becomes a version with a diff, exactly like an agent edit,
 * so the history is complete and any change can be rolled back.
 */
export async function PUT(request: Request, { params }: Params): Promise<NextResponse> {
  const session = await requireUser('ide:write');
  assertCsrf(session, request);
  const { id } = await params;

  const limit = consumeDefault(`ide-write:${session.user.id}`);
  if (!limit.allowed) {
    return NextResponse.json({ error: new RateLimitError(limit).message }, { status: 429 });
  }

  const project = getProject(id);
  if (!project) return NextResponse.json({ error: 'no such project' }, { status: 404 });

  const parsed = WriteBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }
  const { path: filePath, content } = parsed.data;

  try {
    const workspace = workspaceFor(project, 'source');
    let before = '';
    let existed = true;
    try {
      before = workspace.readText(filePath);
    } catch {
      existed = false;
    }

    if (existed && before === content) {
      return NextResponse.json({ saved: false, reason: 'the file is unchanged' });
    }

    const change = workspace.write(filePath, Buffer.from(content, 'utf8'));

    const version = commitVersion(project, {
      label: `operator edit: ${filePath}`,
      summary: parsed.data.summary ?? `${session.user.email} edited ${filePath}`,
      authorType: 'user',
      authorId: session.user.id,
      changes: [change],
    });

    audit({
      actorType: 'user',
      actorId: session.user.id,
      action: 'ide.file.write',
      metadata: { projectId: id, path: filePath, version: version.version },
    });
    emitEvent({
      type: 'file.changed',
      scope: 'ide',
      projectId: id,
      message: `${filePath} edited by ${session.user.email}`,
      data: { path: filePath, version: version.version },
    });

    return NextResponse.json({
      saved: true,
      version: version.version,
      diff: unifiedDiff(before, content, filePath),
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 400 });
  }
}
