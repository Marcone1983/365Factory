import { NextResponse } from 'next/server';
import { z } from 'zod';
import { assertCsrf, requireUser } from '@/lib/security/auth';
import { consumeDefault, RateLimitError } from '@/lib/security/ratelimit';
import { audit } from '@/lib/security/audit';
import { schedulerStatus, setScheduleEnabled, triggerSchedule, upsertSchedule } from '@/lib/schedule/scheduler';
import { describeCron, isValidCron } from '@/lib/schedule/cron';
import { createLogger } from '@/lib/observability/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const log = createLogger('api.schedules');

const Body = z.discriminatedUnion('action', [
  z.object({ action: z.literal('enable'), name: z.string().min(1).max(80), enabled: z.boolean() }),
  z.object({ action: z.literal('trigger'), name: z.string().min(1).max(80) }),
  z.object({ action: z.literal('retime'), name: z.string().min(1).max(80), cron: z.string().min(5).max(120) }),
]);

export async function GET(): Promise<NextResponse> {
  await requireUser('schedule:read');
  const status = schedulerStatus();
  return NextResponse.json({
    ...status,
    schedules: status.schedules.map((schedule) => ({
      ...schedule,
      description: isValidCron(schedule.cron) ? describeCron(schedule.cron) : 'unparseable expression',
    })),
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const session = await requireUser('schedule:write');
  assertCsrf(session, request);

  const limit = consumeDefault(`schedule:${session.user.id}`);
  if (!limit.allowed) {
    return NextResponse.json({ error: new RateLimitError(limit).message }, { status: 429 });
  }

  const parsed = Body.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues.map((i) => i.message).join('; ') }, { status: 400 });
  }
  const body = parsed.data;

  try {
    if (body.action === 'enable') {
      const schedule = setScheduleEnabled(body.name, body.enabled);
      if (!schedule) return NextResponse.json({ error: 'no such schedule' }, { status: 404 });
      audit({
        actorType: 'user',
        actorId: session.user.id,
        action: 'schedule.enable',
        metadata: { name: body.name, enabled: body.enabled },
      });
      return NextResponse.json({ schedule });
    }

    if (body.action === 'retime') {
      const existing = schedulerStatus().schedules.find((s) => s.name === body.name);
      if (!existing) return NextResponse.json({ error: 'no such schedule' }, { status: 404 });
      const schedule = upsertSchedule({ ...existing, cron: body.cron });
      audit({
        actorType: 'user',
        actorId: session.user.id,
        action: 'schedule.retime',
        metadata: { name: body.name, cron: body.cron },
      });
      return NextResponse.json({ schedule });
    }

    // A manual trigger runs the real job, so it needs the same permission as
    // starting a run and is detached: some of these take minutes.
    if (!session.user.permissions.includes('factory:run')) {
      return NextResponse.json({ error: 'triggering a job requires the factory:run permission' }, { status: 403 });
    }
    audit({ actorType: 'user', actorId: session.user.id, action: 'schedule.trigger', metadata: { name: body.name } });
    void triggerSchedule(body.name).catch((error: unknown) =>
      log.error('manually triggered schedule failed', { name: body.name, error }),
    );
    return NextResponse.json({ accepted: true, name: body.name }, { status: 202 });
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : String(error) }, { status: 400 });
  }
}
