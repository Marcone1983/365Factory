import { db, fromJson, newId, nowIso, toJson } from '@/lib/db/client';
import { complete } from '@/lib/ai/router';
import { getLlmProvider } from '@/lib/providers/registry';
import { emitEvent } from '@/lib/observability/events';
import { createLogger } from '@/lib/observability/logger';
import { counter } from '@/lib/observability/metrics';
import type { LLMMessage } from '@/lib/providers/types';
import type { Permission } from '@/lib/security/rbac';
import { executeTool, toolDefinitions, type ToolResult } from './tools';

const log = createLogger('chat.agent');

/**
 * The natural-language interface to the factory.
 *
 * The agent answers from real platform state. It has no ability to invent one:
 * every fact it can state comes from a tool call against the database, the
 * workspace or the configuration, and the system prompt forbids it from
 * answering from memory when a tool exists for the question. If a capability is
 * not configured, the honest answer is that it is not configured — the agent is
 * told explicitly that this is the required answer, not a fallback.
 */

const MAX_TOOL_ROUNDS = 6;

const SYSTEM_PROMPT = `You are the operating console for the Autonomous Daily App Factory: a platform that researches the web for unmet software needs, scores opportunities, invents products, generates code and 3D assets, builds them, and packages Android applications.

You are talking to the operator who runs this platform. Be direct and concise. Write like an engineer reporting state, not like a marketing page.

GROUNDING — this is absolute:
- Every factual claim about this platform's state MUST come from a tool call. Never answer from memory or assumption about what the factory has researched, found, built, spent or scheduled.
- If you have not called a tool, you do not know. Call it.
- Never invent an opportunity, a trend, a research source, a project, a cost figure or a build result. If the tools return nothing, say that nothing has been recorded yet.
- If a capability is unconfigured, say so plainly and name what is missing. Never imply a service works when it does not, and never present a hypothetical result as a real one.
- Quote real numbers from tool output. Do not round them into vagueness or estimate them.

ACTIONS:
- Tools that start work (start_factory_run, trigger_schedule, run_improvement_cycle) spend real API budget and take minutes. Call them only when the operator has clearly asked for the work to be done, not to satisfy curiosity about what would happen.
- If the operator asks for something that needs a run, and it is ambiguous whether they want it started now, ask first.
- If a tool is refused for lack of permission, report that plainly.

When you have the facts, answer the question that was asked. Do not pad the answer with what you could do next unless the operator asked.`;

export interface ChatThread {
  readonly id: string;
  readonly userId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ChatToolCallRecord {
  readonly name: string;
  readonly input: Record<string, unknown>;
  readonly summary: string;
  readonly data?: Record<string, unknown>;
  readonly durationMs: number;
}

export interface ChatMessage {
  readonly id: string;
  readonly threadId: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly content: string;
  readonly toolCalls: readonly ChatToolCallRecord[];
  readonly metadata: Record<string, unknown>;
  readonly createdAt: string;
}

interface ThreadRow {
  id: string;
  user_id: string;
  title: string;
  created_at: string;
  updated_at: string;
}

interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string;
  tool_calls: string;
  metadata: string;
  created_at: string;
}

function toThread(row: ThreadRow): ChatThread {
  return { id: row.id, userId: row.user_id, title: row.title, createdAt: row.created_at, updatedAt: row.updated_at };
}

function toMessage(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    threadId: row.thread_id,
    role: row.role as ChatMessage['role'],
    content: row.content,
    toolCalls: fromJson<ChatToolCallRecord[]>(row.tool_calls, []),
    metadata: fromJson<Record<string, unknown>>(row.metadata, {}),
    createdAt: row.created_at,
  };
}

export function createThread(userId: string, title = 'New conversation'): ChatThread {
  const id = newId('thr');
  db()
    .prepare('INSERT INTO chat_threads (id, user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, userId, title, nowIso(), nowIso());
  const thread = getThread(id);
  if (!thread) throw new Error('thread vanished immediately after being created');
  return thread;
}

export function getThread(id: string): ChatThread | null {
  const row = db().prepare<[string], ThreadRow>('SELECT * FROM chat_threads WHERE id = ?').get(id);
  return row ? toThread(row) : null;
}

export function listThreads(userId: string, limit = 30): ChatThread[] {
  return db()
    .prepare<[string, number], ThreadRow>(
      'SELECT * FROM chat_threads WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?',
    )
    .all(userId, limit)
    .map(toThread);
}

export function listMessages(threadId: string, limit = 200): ChatMessage[] {
  return db()
    .prepare<[string, number], MessageRow>(
      'SELECT * FROM chat_messages WHERE thread_id = ? ORDER BY created_at ASC, rowid ASC LIMIT ?',
    )
    .all(threadId, limit)
    .map(toMessage);
}

export function deleteThread(id: string, userId: string): boolean {
  return db().prepare('DELETE FROM chat_threads WHERE id = ? AND user_id = ?').run(id, userId).changes > 0;
}

function appendMessage(input: {
  threadId: string;
  role: ChatMessage['role'];
  content: string;
  toolCalls?: readonly ChatToolCallRecord[];
  metadata?: Record<string, unknown>;
}): ChatMessage {
  const id = newId('msg');
  db()
    .prepare(
      'INSERT INTO chat_messages (id, thread_id, role, content, tool_calls, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .run(id, input.threadId, input.role, input.content, toJson(input.toolCalls ?? []), toJson(input.metadata ?? {}), nowIso());
  db().prepare('UPDATE chat_threads SET updated_at = ? WHERE id = ?').run(nowIso(), input.threadId);

  const row = db().prepare<[string], MessageRow>('SELECT * FROM chat_messages WHERE id = ?').get(id);
  if (!row) throw new Error('message vanished immediately after being written');
  return toMessage(row);
}

/** Titles a thread from its first instruction so the list is navigable. */
function titleFrom(instruction: string): string {
  const cleaned = instruction.replace(/\s+/g, ' ').trim();
  return cleaned.length <= 60 ? cleaned : `${cleaned.slice(0, 57)}…`;
}

export interface SendMessageInput {
  readonly threadId: string;
  readonly userId: string;
  readonly permissions: readonly Permission[];
  readonly content: string;
  readonly signal?: AbortSignal;
}

export interface SendMessageResult {
  readonly userMessage: ChatMessage;
  readonly assistantMessage: ChatMessage;
}

/**
 * Runs one turn: the operator's instruction, any tool calls the model makes to
 * ground its answer, and the reply. Both messages are persisted, tool calls
 * included, so the thread is a complete audit trail of what was consulted.
 */
export async function sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
  const provider = getLlmProvider();
  const status = provider.status();
  if (!status.configured) {
    // Refusing here is the honest behaviour: without a provider there is no
    // answer to give, and a canned reply would be exactly the pretence the
    // platform must never produce.
    throw new Error(
      `The chat needs a language model provider. ${provider.name} is not configured — ${status.detail ?? 'set its API key in the environment'}.`,
    );
  }

  const thread = getThread(input.threadId);
  if (!thread) throw new Error(`no chat thread ${input.threadId}`);
  if (thread.userId !== input.userId) throw new Error('that conversation belongs to another account');

  const history = listMessages(input.threadId);
  if (history.length === 0) {
    db().prepare('UPDATE chat_threads SET title = ? WHERE id = ?').run(titleFrom(input.content), input.threadId);
  }

  const userMessage = appendMessage({ threadId: input.threadId, role: 'user', content: input.content });
  emitEvent({ type: 'chat.message', scope: 'chat', message: 'operator instruction received', data: { threadId: input.threadId } });

  const messages: LLMMessage[] = [
    ...history.map((m) => ({ role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const), content: m.content })),
    { role: 'user' as const, content: input.content },
  ];

  const tools = toolDefinitions(input.permissions);
  const controller = new AbortController();
  input.signal?.addEventListener('abort', () => controller.abort(), { once: true });

  const performed: ChatToolCallRecord[] = [];
  let reply = '';
  let rounds = 0;

  try {
    for (; rounds < MAX_TOOL_ROUNDS; rounds += 1) {
      const response = await complete({
        task: rounds === 0 ? 'chat_orchestration' : 'chat_reply',
        system: SYSTEM_PROMPT,
        messages,
        tools,
        signal: controller.signal,
      });

      if (response.toolCalls.length === 0) {
        reply = response.text.trim();
        break;
      }

      // Record what the model asked for before running it, so a tool that hangs
      // or throws still leaves evidence of what was attempted.
      const observations: string[] = [];
      for (const call of response.toolCalls) {
        const started = Date.now();
        const result: ToolResult = await executeTool(call.name, call.input, {
          userId: input.userId,
          permissions: input.permissions,
          signal: controller.signal,
        });
        const record: ChatToolCallRecord = {
          name: call.name,
          input: call.input,
          summary: result.summary,
          data: result.data,
          durationMs: Date.now() - started,
        };
        performed.push(record);
        counter('chat.tool', { tool: call.name });
        emitEvent({
          type: 'chat.message',
          scope: 'chat',
          message: `tool: ${call.name}`,
          data: { threadId: input.threadId, tool: call.name },
        });
        observations.push(`Result of ${call.name}:\n${result.summary}`);
      }

      messages.push({ role: 'assistant', content: response.text || `Calling: ${response.toolCalls.map((c) => c.name).join(', ')}` });
      messages.push({ role: 'user', content: observations.join('\n\n') });
    }

    if (!reply) {
      reply =
        performed.length > 0
          ? `I gathered the following but did not reach a conclusion within ${MAX_TOOL_ROUNDS} tool rounds:\n\n${performed.map((p) => p.summary).join('\n\n')}`
          : 'The model returned no answer.';
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn('chat turn failed', { threadId: input.threadId, error: message });
    const assistantMessage = appendMessage({
      threadId: input.threadId,
      role: 'assistant',
      content: `That turn failed: ${message}`,
      toolCalls: performed,
      metadata: { failed: true },
    });
    return { userMessage, assistantMessage };
  }

  const assistantMessage = appendMessage({
    threadId: input.threadId,
    role: 'assistant',
    content: reply,
    toolCalls: performed,
    metadata: { toolRounds: rounds },
  });

  emitEvent({ type: 'chat.message', scope: 'chat', message: 'reply sent', data: { threadId: input.threadId, tools: performed.length } });
  return { userMessage, assistantMessage };
}
