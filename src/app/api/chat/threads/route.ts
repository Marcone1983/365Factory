import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertCsrf, requireUser } from '@/lib/security/auth';
import { consumeDefault, RateLimitError } from '@/lib/security/ratelimit';
import { createThread, listThreads } from '@/lib/chat/agent';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CreateBody = z.object({ title: z.string().min(1).max(120).optional() });

export async function GET(): Promise<NextResponse> {
  const session = await requireUser('chat:use');
  return NextResponse.json({ threads: listThreads(session.user.id) });
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await requireUser('chat:use');
  assertCsrf(session, request);

  const limit = consumeDefault(`chat-thread:${session.user.id}`);
  if (!limit.allowed) {
    return NextResponse.json({ error: new RateLimitError(limit).message }, { status: 429 });
  }

  const parsed = CreateBody.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }

  return NextResponse.json({ thread: createThread(session.user.id, parsed.data.title) }, { status: 201 });
}
