'use client';

import { useEffect, useRef, useState } from 'react';

interface FeedEvent {
  id: number;
  ts: string;
  type: string;
  scope: string;
  message: string;
}

/**
 * Live activity panel.
 *
 * Subscribes to the server-sent event stream and keeps a bounded window of the
 * most recent events. EventSource reconnects on its own, so a dropped
 * connection heals without the operator noticing.
 */
export function ActivityFeed(): React.ReactElement {
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const listRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const source = new EventSource('/api/events');
    source.onopen = (): void => setConnected(true);
    source.onerror = (): void => setConnected(false);
    source.onmessage = (message: MessageEvent<string>): void => {
      try {
        const event = JSON.parse(message.data) as FeedEvent;
        setEvents((current) => [...current.slice(-199), event]);
      } catch {
        /* a malformed frame must not break the panel */
      }
    };
    // Named events arrive with their own type, so they need explicit listeners.
    for (const type of ['factory.run.step', 'agent.started', 'agent.progress', 'agent.finished', 'agent.failed',
      'research.query', 'research.document', 'build.started', 'build.finished', 'test.finished',
      'asset.generated', 'file.changed', 'preview.status', 'project.created', 'project.updated', 'cache.hit']) {
      source.addEventListener(type, (message) => {
        try {
          const event = JSON.parse((message as MessageEvent<string>).data) as FeedEvent;
          setEvents((current) => [...current.slice(-199), event]);
        } catch {
          /* ignore */
        }
      });
    }
    return () => source.close();
  }, []);

  useEffect(() => {
    const node = listRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [events]);

  return (
    <div className="card" style={{ padding: 0 }}>
      <div className="card-head" style={{ padding: '12px 15px 8px', margin: 0 }}>
        <span className="metric-label">Event stream</span>
        <span className={`pill ${connected ? 'run' : 'idle'}`}>{connected ? 'connected' : 'reconnecting'}</span>
      </div>
      <div className="feed" ref={listRef}>
        {events.length === 0 ? (
          <div className="feed-row"><time>—</time><span className="dim">Waiting for activity…</span></div>
        ) : (
          events.map((event) => (
            <div className="feed-row" key={`${event.id}-${event.ts}`}>
              <time>{new Date(event.ts).toLocaleTimeString()}</time>
              <span>
                <span className="scope">{event.scope}</span> {event.message}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
