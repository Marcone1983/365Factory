import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertCsrf, requireUser } from '@/lib/security/auth';
import { consumeDefault, RateLimitError } from '@/lib/security/ratelimit';
import { audit } from '@/lib/security/audit';
import { listRuns, runFactory, FACTORY_STEPS, type FactoryStep } from '@/lib/orchestrator/factory';
import { capabilityReport } from '@/lib/config/capabilities';
import { createLogger } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api.runs');

const StartBody = z.object({
  objective: z.string().min(6).max(400),
  constraints: z.array(z.string().max(200)).max(10).optional(),
  includeGames: z.boolean().optional(),
  stopAfter: z.enum(FACTORY_STEPS).optional(),
  maxDocuments: z.number().int().min(4).max(300).optional(),
});

export async function GET(): Promise<NextResponse> {
  await requireUser('system:read');
  return NextResponse.json({ runs: listRuns(30) });
}

/**
 * Starts a factory run.
 *
 * The run is long-lived, so the request returns as soon as it is accepted and
 * the client follows progress on the event stream. Prerequisites are checked
 * first: starting a run that cannot possibly reach its goal wastes budget and
 * produces a misleading failure.
 */
export async function POST(request: Request): Promise<NextResponse> {
  const session = await requireUser('factory:run');
  assertCsrf(session, request);

  const limit = consumeDefault(`run:${session.user.id}`);
  if (!limit.allowed) {
    return NextResponse.json({ error: new RateLimitError(limit).message }, { status: 429 });
  }

  const parsed = StartBody.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }

  const report = capabilityReport();
  const blocked = report.capabilities.filter(
    (capability) => capability.state === 'unavailable' && ['reasoning', 'web_research'].includes(capability.id),
  );
  if (blocked.length > 0) {
    return NextResponse.json(
      {
        error: 'The factory cannot run yet.',
        blocked: blocked.map((capability) => ({ capability: capability.title, reason: capability.summary, remedy: capability.remedy })),
      },
      { status: 503 },
    );
  }

  const stopAfter = parsed.data.stopAfter as FactoryStep | undefined;
  audit({
    actorType: 'user',
    actorId: session.user.id,
    action: 'factory.run.start',
    metadata: { objective: parsed.data.objective, stopAfter: stopAfter ?? 'learning' },
  });

  // Detached on purpose: the client follows /api/events rather than holding a
  // request open for the length of a full generation cycle.
  void runFactory({
    objective: parsed.data.objective,
    constraints: parsed.data.constraints,
    includeGames: parsed.data.includeGames,
    stopAfter,
    maxDocuments: parsed.data.maxDocuments,
    userId: session.user.id,
    trigger: 'manual',
  }).catch((error: unknown) => log.error('detached factory run failed', { error }));

  return NextResponse.json({ accepted: true, objective: parsed.data.objective, stopAfter: stopAfter ?? 'learning' }, { status: 202 });
}
