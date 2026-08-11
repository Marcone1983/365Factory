import { config } from '@/lib/config/env';
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
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.stopSequences?.length) body.stop_sequences = [...req.stopSequences];
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.inputSchema,
      }));
    }

    const started = Date.now();
    const raw = await request({
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

    let parsed: AnthropicResponseBody;
    try {
      parsed = JSON.parse(raw.body.toString('utf8')) as AnthropicResponseBody;
    } catch {
      throw new ProviderRequestError(this.name, raw.status, 'malformed JSON response', false);
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
