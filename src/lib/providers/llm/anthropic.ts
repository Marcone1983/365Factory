import { config } from '@/lib/config/env';
import { createLogger } from '@/lib/observability/logger';
import { request } from '../http';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type FinishReason,
  type LLMProvider,
  type LLMRequest,
  type LLMResponse,
  type LLMToolCall,
  type ModelTier,
  type ProviderStatus,
} from '../types';

interface AnthropicContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
}

interface AnthropicResponseBody {
  id: string;
  model: string;
  content: AnthropicContentBlock[];
  stop_reason: string | null;
  usage: { input_tokens: number; output_tokens: number };
}

interface AnthropicErrorBody {
  error?: { type?: string; message?: string };
}

const REQUIRES = ['ANTHROPIC_API_KEY'] as const;

function mapFinish(reason: string | null): FinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'max_tokens':
      return 'length';
    case 'tool_use':
      return 'tool_use';
    case 'refusal':
      return 'content_filter';
    default:
      return 'other';
  }
}

/**
 * Models that reject a parameter rather than ignoring it, learned at runtime.
 *
 * Process-local on purpose: it is a fact about the endpoint this build is
 * talking to, not about the user's data, so it costs one failed request per
 * process and needs no storage.
 */
const UNSUPPORTED_TEMPERATURE = new Set<string>();

const log = createLogger('providers.anthropic');

/** Whether an error is the API refusing a named parameter. */
function isDeprecatedParameterError(error: unknown, parameter: string): boolean {
  if (!(error instanceof ProviderRequestError) || error.status !== 400) return false;
  const body = (error.body ?? '').toLowerCase();
  return body.includes(parameter) && (body.includes('deprecated') || body.includes('unsupported') || body.includes('not supported'));
}

/**
 * Reassembles a server-sent event stream into the message it describes.
 *
 * The streaming API delivers the same message as the buffered one, in pieces:
 * `message_start` carries the model and the input token count, a series of
 * `content_block_delta` events carry the text a fragment at a time, and
 * `message_delta` carries the stop reason and the final output token count.
 * Collecting them back into one object keeps every caller unaware that anything
 * changed.
 */
function parseEventStream(payload: string): AnthropicResponseBody {
  // An error is returned as a plain JSON body rather than as a stream.
  if (!payload.includes('event:') && payload.trim().startsWith('{')) {
    return JSON.parse(payload) as AnthropicResponseBody;
  }

  const blocks: Array<{ type: string; text?: string; id?: string; name?: string; input?: unknown; partialJson?: string }> = [];
  let model = '';
  let stopReason: string | null = null;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const line of payload.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue;
    const data = line.slice(5).trim();
    if (data === '' || data === '[DONE]') continue;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }

    switch (event.type) {
      case 'message_start': {
        const message = event.message as { model?: string; usage?: { input_tokens?: number } } | undefined;
        model = message?.model ?? model;
        inputTokens = message?.usage?.input_tokens ?? inputTokens;
        break;
      }
      case 'content_block_start': {
        const block = event.content_block as { type?: string; id?: string; name?: string; input?: unknown } | undefined;
        blocks.push({ type: block?.type ?? 'text', text: '', id: block?.id, name: block?.name, input: block?.input, partialJson: '' });
        break;
      }
      case 'content_block_delta': {
        const current = blocks[blocks.length - 1];
        if (!current) break;
        const delta = event.delta as { type?: string; text?: string; partial_json?: string } | undefined;
        if (typeof delta?.text === 'string') current.text = (current.text ?? '') + delta.text;
        // Tool arguments stream as JSON fragments rather than as text.
        if (typeof delta?.partial_json === 'string') current.partialJson = (current.partialJson ?? '') + delta.partial_json;
        break;
      }
      case 'message_delta': {
        const delta = event.delta as { stop_reason?: string | null } | undefined;
        stopReason = delta?.stop_reason ?? stopReason;
        outputTokens = (event.usage as { output_tokens?: number } | undefined)?.output_tokens ?? outputTokens;
        break;
      }
      case 'error': {
        const error = event.error as { message?: string } | undefined;
        throw new Error(error?.message ?? 'the provider reported an error mid-stream');
      }
      default:
        break;
    }
  }

  if (blocks.length === 0 && model === '') throw new Error('the response stream carried no message');

  return {
    content: blocks.map((block) => ({
      type: block.type,
      text: block.text,
      id: block.id,
      name: block.name,
      input: block.partialJson ? (safeJson(block.partialJson) ?? block.input) : block.input,
    })) as AnthropicResponseBody['content'],
    model,
    stop_reason: stopReason,
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  } as AnthropicResponseBody;
}

function safeJson(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class AnthropicProvider implements LLMProvider {
  readonly name = 'anthropic';

  status(): ProviderStatus {
    const configured = Boolean(config().ANTHROPIC_API_KEY);
    return {
      name: this.name,
      kind: 'llm',
      configured,
      detail: configured
        ? `Anthropic Messages API at ${config().ANTHROPIC_BASE_URL}`
        : 'ANTHROPIC_API_KEY is not set; Anthropic calls are refused.',
      requires: REQUIRES,
    };
  }

  modelFor(tier: ModelTier): string {
    const cfg = config();
    if (tier === 'fast') return cfg.ANTHROPIC_MODEL_FAST;
    if (tier === 'deep') return cfg.ANTHROPIC_MODEL_DEEP;
    return cfg.ANTHROPIC_MODEL_BALANCED;
  }

  async complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const cfg = config();
    const apiKey = cfg.ANTHROPIC_API_KEY;
    if (!apiKey) throw new ProviderNotConfiguredError(this.name, REQUIRES);

    const model = req.model ?? this.modelFor(req.tier ?? 'balanced');
    const system = req.jsonOutput
      ? `${req.system ? `${req.system}\n\n` : ''}Respond with a single JSON object and nothing else. Do not wrap it in Markdown fences.`
      : req.system;

    const body: Record<string, unknown> = {
      model,
      max_tokens: req.maxOutputTokens,
      // A message with images becomes a content-block array; one without stays
      // a plain string, which keeps the request identical to before for the
      // overwhelming majority of calls.
      messages: req.messages.map((m) =>
        m.images && m.images.length > 0
          ? {
              role: m.role,
              content: [
                ...m.images.flatMap((image) => [
                  ...(image.caption ? [{ type: 'text', text: image.caption }] : []),
                  {
                    type: 'image',
                    source: { type: 'base64', media_type: image.mimeType, data: image.data.toString('base64') },
                  },
                ]),
                { type: 'text', text: m.content },
              ],
            }
          : { role: m.role, content: m.content },
      ),
    };
    if (system) body.system = system;
    // Streamed, always.
    //
    // A non-streamed request sends nothing at all until the model has finished
    // writing, so a large answer looks identical to a hung connection: the HTTP
    // client's header timeout fires, the caller sees "fetch failed", and the
    // work has already been done and billed on the other side. Streaming makes
    // the headers arrive at once and the bytes arrive continuously, which is
    // also what Anthropic requires for long generations. The stream is still
    // buffered to completion here — nothing downstream wants it incrementally —
    // so the only thing that changes is that the connection stays alive.
    body.stream = true;
    // Newer models reject `temperature` outright rather than ignoring it, and
    // which ones do changes as models are released. Rather than carry a list
    // that goes stale, the provider learns it: the first 400 that names the
    // parameter records the model and every later request omits it.
    if (req.temperature !== undefined && !UNSUPPORTED_TEMPERATURE.has(model)) {
      body.temperature = req.temperature;
    }
    if (req.stopSequences?.length) body.stop_sequences = [...req.stopSequences];
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const started = Date.now();
    const send = async (): Promise<Awaited<ReturnType<typeof request>>> =>
      request({
        provider: this.name,
        url: `${cfg.ANTHROPIC_BASE_URL.replace(/\/$/, '')}/v1/messages`,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
        timeoutMs: cfg.LLM_TIMEOUT_MS,
        maxAttempts: cfg.LLM_MAX_ATTEMPTS,
        signal,
      });

    let raw: Awaited<ReturnType<typeof request>>;
    try {
      raw = await send();
    } catch (error) {
      // A parameter this model does not accept is a configuration mismatch, not
      // a failure of the request: drop it, remember, and send once more. Any
      // other 400 is a real error and is rethrown untouched.
      if (!isDeprecatedParameterError(error, 'temperature') || body.temperature === undefined) throw error;
      UNSUPPORTED_TEMPERATURE.add(model);
      delete body.temperature;
      log.info('this model rejects `temperature`; omitting it from now on', { model });
      raw = await send();
    }

    let parsed: AnthropicResponseBody;
    try {
      parsed = parseEventStream(raw.body.toString('utf8'));
    } catch (error) {
      throw new ProviderRequestError(this.name, raw.status, (error as Error).message, false);
    }
    if (!Array.isArray(parsed.content)) {
      const err = parsed as unknown as AnthropicErrorBody;
      throw new ProviderRequestError(this.name, raw.status, err.error?.message ?? 'unexpected response shape', false);
    }

    const text = parsed.content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('');
    const toolCalls: LLMToolCall[] = parsed.content
      .filter((b) => b.type === 'tool_use' && b.name)
      .map((b) => ({ id: b.id ?? '', name: b.name as string, input: (b.input ?? {}) as Record<string, unknown> }));

    return {
      text,
      toolCalls,
      usage: { inputTokens: parsed.usage?.input_tokens ?? 0, outputTokens: parsed.usage?.output_tokens ?? 0 },
      model: parsed.model || model,
      provider: this.name,
      finishReason: mapFinish(parsed.stop_reason),
      latencyMs: Date.now() - started,
    };
  }
}
