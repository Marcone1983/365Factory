'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

interface ToolCall {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly summary: string;
  readonly durationMs: number;
}

interface Message {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly toolCalls: readonly ToolCall[];
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

interface Thread {
  readonly id: string;
  readonly title: string;
  readonly updatedAt: string;
}

function csrfToken(): string {
  return document.cookie.split('; ').find((part) => part.startsWith('adaf_csrf='))?.split('=')[1] ?? '';
}

function headers(): Record<string, string> {
  return { 'content-type': 'application/json', 'x-csrf-token': csrfToken() };
}

/**
 * Renders assistant text.
 *
 * Fenced code blocks are rendered as code and everything else as paragraphs.
 * The content is inserted as text nodes, never as HTML: the model's output is
 * untrusted input like any other, and it must not be able to inject markup into
 * the console.
 */
function MessageBody({ content }: { content: string }): React.ReactElement {
  const segments = content.split(/```/);
  return (
    <>
      {segments.map((segment, index) =>
        index % 2 === 1 ? (
          <pre key={index} className="log" style={{ margin: '8px 0' }}>
            {segment.replace(/^[a-z]*\n/, '')}
          </pre>
        ) : (
          segment
            .split(/\n{2,}/)
            .filter((p) => p.trim().length > 0)
            .map((paragraph, pIndex) => (
              <p key={`${index}-${pIndex}`} style={{ margin: '0 0 8px', whiteSpace: 'pre-wrap' }}>
                {paragraph}
              </p>
            ))
        ),
      )}
    </>
  );
}

function ToolTrace({ calls }: { calls: readonly ToolCall[] }): React.ReactElement | null {
  const [open, setOpen] = useState(false);
  if (calls.length === 0) return null;

  return (
    <div style={{ marginTop: 8 }}>
      <button
        onClick={() => setOpen((v) => !v)}
        style={{ fontSize: 12, padding: '3px 9px', background: 'transparent' }}
      >
        {open ? '▾' : '▸'} {calls.length} tool {calls.length === 1 ? 'call' : 'calls'}:{' '}
        {calls.map((c) => c.name).join(', ')}
      </button>
      {open ? (
        <div style={{ marginTop: 6, display: 'grid', gap: 6 }}>
          {calls.map((call, index) => (
            <div key={index} className="card tight">
              <div className="mono faint" style={{ marginBottom: 4 }}>
                {call.name}({JSON.stringify(call.input)}) · {call.durationMs}ms
              </div>
              <div className="log" style={{ maxHeight: 200 }}>{call.summary}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChatClient({ initialThreads }: { initialThreads: readonly Thread[] }): React.ReactElement {
  const [threads, setThreads] = useState<readonly Thread[]>(initialThreads);
  const [activeId, setActiveId] = useState<string | null>(initialThreads[0]?.id ?? null);
  const [messages, setMessages] = useState<readonly Message[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endRef = useRef<HTMLDivElement>(null);

  const loadThread = useCallback(async (id: string): Promise<void> => {
    setError(null);
    const response = await fetch(`/api/chat/threads/${id}`);
    if (!response.ok) {
      setError('That conversation could not be loaded.');
      return;
    }
    const body = (await response.json()) as { messages: Message[] };
    setMessages(body.messages);
  }, []);

  useEffect(() => {
    if (activeId) void loadThread(activeId);
    else setMessages([]);
  }, [activeId, loadThread]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [messages, busy]);

  async function newThread(): Promise<Thread | null> {
    const response = await fetch('/api/chat/threads', { method: 'POST', headers: headers(), body: '{}' });
    if (!response.ok) {
      setError('A new conversation could not be started.');
      return null;
    }
    const body = (await response.json()) as { thread: Thread };
    setThreads((current) => [body.thread, ...current]);
    setActiveId(body.thread.id);
    setMessages([]);
    return body.thread;
  }

  async function send(): Promise<void> {
    const content = draft.trim();
    if (content.length === 0 || busy) return;

    let threadId = activeId;
    if (!threadId) {
      const created = await newThread();
      if (!created) return;
      threadId = created.id;
    }

    setBusy(true);
    setError(null);
    setDraft('');
    // Show the instruction immediately; the server echoes back the stored row.
    const pending: Message = {
      id: `pending-${Date.now()}`,
      role: 'user',
      content,
      toolCalls: [],
      metadata: {},
      createdAt: new Date().toISOString(),
    };
    setMessages((current) => [...current, pending]);

    try {
      const response = await fetch(`/api/chat/threads/${threadId}`, {
        method: 'POST',
        headers: headers(),
        body: JSON.stringify({ content }),
      });
      const body = (await response.json()) as { error?: string; userMessage?: Message; assistantMessage?: Message };

      if (!response.ok || !body.assistantMessage) {
        setError(body.error ?? 'That turn failed.');
        setMessages((current) => current.filter((m) => m.id !== pending.id));
        setDraft(content);
        return;
      }
      setMessages((current) => [
        ...current.filter((m) => m.id !== pending.id),
        body.userMessage as Message,
        body.assistantMessage as Message,
      ]);
      void refreshThreads();
    } catch {
      setError('The console could not reach the server.');
      setMessages((current) => current.filter((m) => m.id !== pending.id));
      setDraft(content);
    } finally {
      setBusy(false);
    }
  }

  async function refreshThreads(): Promise<void> {
    const response = await fetch('/api/chat/threads');
    if (!response.ok) return;
    const body = (await response.json()) as { threads: Thread[] };
    setThreads(body.threads);
  }

  async function remove(id: string): Promise<void> {
    const response = await fetch(`/api/chat/threads/${id}`, { method: 'DELETE', headers: headers() });
    if (!response.ok) return;
    setThreads((current) => current.filter((t) => t.id !== id));
    if (activeId === id) setActiveId(null);
  }

  return (
    <div className="chat-layout">
      <aside className="chat-threads">
        <button data-variant="primary" style={{ width: '100%', marginBottom: 10 }} onClick={() => void newThread()}>
          New conversation
        </button>
        {threads.length === 0 ? (
          <div className="faint" style={{ fontSize: 13, padding: '8px 4px' }}>No conversations yet.</div>
        ) : (
          threads.map((thread) => (
            <div key={thread.id} className={`chat-thread${thread.id === activeId ? ' active' : ''}`}>
              <button className="chat-thread-open" onClick={() => setActiveId(thread.id)}>
                {thread.title}
              </button>
              <button className="chat-thread-remove" aria-label="Delete conversation" onClick={() => void remove(thread.id)}>
                ×
              </button>
            </div>
          ))
        )}
      </aside>

      <section className="chat-main">
        <div className="chat-log">
          {messages.length === 0 && !busy ? (
            <div className="empty">
              Ask about what the factory has found, what it has built, what it has spent, or tell it what to
              investigate. Every answer is read from real platform state.
            </div>
          ) : null}

          {messages.map((message) => (
            <div key={message.id} className={`chat-message ${message.role}`}>
              <div className="chat-role">{message.role === 'user' ? 'You' : 'Factory'}</div>
              <div className="chat-content">
                <MessageBody content={message.content} />
                <ToolTrace calls={message.toolCalls} />
              </div>
            </div>
          ))}

          {busy ? (
            <div className="chat-message assistant">
              <div className="chat-role">Factory</div>
              <div className="chat-content faint">Working — consulting platform state…</div>
            </div>
          ) : null}
          <div ref={endRef} />
        </div>

        {error ? (
          <div className="notice error" style={{ margin: '0 0 10px' }}>
            {error}
          </div>
        ) : null}

        <div className="chat-composer">
          <textarea
            value={draft}
            placeholder="Ask the factory, or tell it what to do…"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                event.preventDefault();
                void send();
              }
            }}
            rows={3}
          />
          <button data-variant="primary" disabled={busy || draft.trim().length === 0} onClick={() => void send()}>
            {busy ? 'Working…' : 'Send'}
          </button>
        </div>
        <div className="faint" style={{ fontSize: 12, marginTop: 6 }}>
          Ctrl/⌘ + Enter to send. Answers are grounded in tool calls against this platform — the tool trace under each
          reply shows exactly what was consulted.
        </div>
      </section>
    </div>
  );
}
