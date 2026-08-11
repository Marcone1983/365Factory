import { EventEmitter } from 'node:events';

/**
 * In-process pub/sub used to stream live platform activity to the browser over
 * Server-Sent Events. Every emitted event is also retained in a bounded replay
 * buffer so a client that connects mid-run immediately sees recent history
 * instead of an empty panel.
 */

export type FactoryEventType =
  | 'factory.run.started'
  | 'factory.run.step'
  | 'factory.run.finished'
  | 'factory.run.failed'
  | 'agent.started'
  | 'agent.progress'
  | 'agent.finished'
  | 'agent.failed'
  | 'research.query'
  | 'research.document'
  | 'project.created'
  | 'project.updated'
  | 'file.changed'
  | 'build.started'
  | 'build.log'
  | 'build.finished'
  | 'test.finished'
  | 'preview.status'
  | 'asset.generated'
  | 'api.call'
  | 'cache.hit'
  | 'chat.message'
  | 'scheduler.tick'
  | 'log';

export interface FactoryEvent {
  readonly id: number;
  readonly ts: string;
  readonly type: FactoryEventType;
  readonly scope: string;
  readonly runId?: string;
  readonly projectId?: string;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

const emitter = new EventEmitter();
emitter.setMaxListeners(200);

const BUFFER_SIZE = 400;
const buffer: FactoryEvent[] = [];
let seq = 0;

export function emitEvent(event: Omit<FactoryEvent, 'id' | 'ts'>): FactoryEvent {
  seq += 1;
  const full: FactoryEvent = { ...event, id: seq, ts: new Date().toISOString() };
  buffer.push(full);
  if (buffer.length > BUFFER_SIZE) buffer.splice(0, buffer.length - BUFFER_SIZE);
  emitter.emit('event', full);
  return full;
}

export function subscribe(listener: (event: FactoryEvent) => void): () => void {
  emitter.on('event', listener);
  return () => emitter.off('event', listener);
}

export function replay(since = 0, filter?: { runId?: string; projectId?: string }): FactoryEvent[] {
  return buffer.filter(
    (e) =>
      e.id > since &&
      (!filter?.runId || e.runId === filter.runId) &&
      (!filter?.projectId || e.projectId === filter.projectId),
  );
}

export function lastEventId(): number {
  return seq;
}
