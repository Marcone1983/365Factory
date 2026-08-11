import { replay, subscribe, type FactoryEvent } from '@/lib/observability/events';
import { requireUser } from '@/lib/security/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Live activity stream.
 *
 * Server-Sent Events rather than WebSockets: the feed is one-directional, SSE
 * reconnects on its own, and it survives proxies that mishandle upgrades. New
 * subscribers receive the recent buffer first so the panel is never empty.
 */
export async function GET(request: Request): Promise<Response> {
  await requireUser('system:read');
  const url = new URL(request.url);
  const since = Number.parseInt(url.searchParams.get('since') ?? '0', 10) || 0;
  const runId = url.searchParams.get('runId') ?? undefined;
  const projectId = url.searchParams.get('projectId') ?? undefined;

  const encoder = new TextEncoder();
  let unsubscribe: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: FactoryEvent): void => {
        try {
          controller.enqueue(encoder.encode(`id: ${event.id}\nevent: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
        } catch {
          /* the client disconnected mid-write */
        }
      };
      for (const event of replay(since, { runId, projectId })) send(event);
      unsubscribe = subscribe((event) => {
        if (runId && event.runId !== runId) return;
        if (projectId && event.projectId !== projectId) return;
        send(event);
      });
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
        } catch {
          /* closed */
        }
      }, 25_000);
    },
    cancel() {
      unsubscribe?.();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
