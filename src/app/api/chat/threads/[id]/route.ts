import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertCsrf, requireUser } from '@/lib/security/auth';
import { consumeDefault, RateLimitError } from '@/lib/security/ratelimit';
import { audit } from '@/lib/security/audit';
import { deleteThread, getThread, listMessages, sendMessage } from '@/lib/chat/agent';
import { createLogger } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api.chat');

const SendBody = z.object({ content: z.string().min(1).max(8000) });

type Params = { params: Promise<{ id: string }> };

export async function GET(_request: Request, { params }: Params): Promise<NextResponse> {
  const session = await requireUser('chat:use');
  const { id } = await params;

  const thread = getThread(id);
  if (!thread || thread.userId !== session.user.id) {
    return NextResponse.json({ error: 'no such conversation' }, { status: 404 });
  }
  return NextResponse.json({ thread, messages: listMessages(id) });
}

/**
 * Runs one chat turn.
 *
 * This request is held open for the whole turn because the answer depends on the
 * tool calls the agent makes; a turn that starts a factory run can take minutes,
 * and the activity feed carries the progress in the meantime.
 */
export async function POST(request: Request, { params }: Params): Promise<NextResponse> {
  const session = await requireUser('chat:use');
  assertCsrf(session, request);
  const { id } = await params;

  const limit = consumeDefault(`chat:${session.user.id}`);
  if (!limit.allowed) {
    return NextResponse.json({ error: new RateLimitError(limit).message }, { status: 429 });
  }

  const thread = getThread(id);
  if (!thread || thread.userId !== session.user.id) {
    return NextResponse.json({ error: 'no such conversation' }, { status: 404 });
  }

  const parsed = SendBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }

  try {
    const result = await sendMessage({
      threadId: id,
      userId: session.user.id,
      permissions: session.user.permissions,
      content: parsed.data.content,
      signal: request.signal,
    });
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('chat turn rejected', { threadId: id, error: message });
    // A missing provider is a configuration problem, not a server fault: it is
    // reported as such so the console can point at what to configure.
    const status = /not configured/.test(message) ? 503 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}

export async function DELETE(request: Request, { params }: Params): Promise<NextResponse> {
  const session = await requireUser('chat:use');
  assertCsrf(session, request);
  const { id } = await params;

  const removed = deleteThread(id, session.user.id);
  if (!removed) return NextResponse.json({ error: 'no such conversation' }, { status: 404 });

  audit({ actorType: 'user', actorId: session.user.id, action: 'chat.thread.delete', metadata: { threadId: id } });
  return NextResponse.json({ deleted: true });
}
