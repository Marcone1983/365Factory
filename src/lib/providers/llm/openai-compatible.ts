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

interface ChatChoice {
  message?: {
    content?: string | null;
    tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
  };
  finish_reason?: string;
}

interface ChatCompletionBody {
  model?: string;
  choices?: ChatChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
}

function mapFinish(reason: string | undefined): FinishReason {
  switch (reason) {
    case 'stop':
      return 'stop';
    case 'length':
      return 'length';
    case 'tool_calls':
    case 'function_call':
      return 'tool_use';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}

export interface OpenAiCompatibleOptions {
  readonly name: string;
  readonly requires: readonly string[];
  readonly baseUrl: () => string;
  readonly apiKey: () => string | undefined;
  readonly models: () => Record<ModelTier, string>;
  readonly extraHeaders?: () => Record<string, string>;
  readonly supportsJsonMode?: boolean;
}

/**
 * Shared implementation for every provider that speaks the OpenAI
 * `/chat/completions` dialect (OpenAI itself, OpenRouter, and self-hosted
 * gateways that mirror the same contract).
 */
export class OpenAiCompatibleProvider implements LLMProvider {
  readonly name: string;

  constructor(private readonly options: OpenAiCompatibleOptions) {
    this.name = options.name;
  }

  status(): ProviderStatus {
    const configured = Boolean(this.options.apiKey());
    return {
      name: this.name,
      kind: 'llm',
      configured,
      detail: configured
        ? `OpenAI-compatible chat completions at ${this.options.baseUrl()}`
        : `${this.options.requires.join(' / ')} is not set; ${this.name} calls are refused.`,
      requires: this.options.requires,
    };
  }

  modelFor(tier: ModelTier): string {
    return this.options.models()[tier];
  }

  async complete(req: LLMRequest, signal?: AbortSignal): Promise<LLMResponse> {
    const cfg = config();
    const apiKey = this.options.apiKey();
    if (!apiKey) throw new ProviderNotConfiguredError(this.name, this.options.requires);

    const model = req.model ?? this.modelFor(req.tier ?? 'balanced');
    const messages: Array<Record<string, unknown>> = [];
    if (req.system) messages.push({ role: 'system', content: req.system });
    for (const m of req.messages) {
      if (m.images && m.images.length > 0) {
        // OpenAI-compatible endpoints take images as data URLs in a parts array.
        messages.push({
          role: m.role,
          content: [
            ...m.images.flatMap((image) => [
              ...(image.caption ? [{ type: 'text', text: image.caption }] : []),
              {
                type: 'image_url',
                image_url: { url: `data:${image.mimeType};base64,${image.data.toString('base64')}` },
              },
            ]),
            { type: 'text', text: m.content },
          ],
        });
      } else {
        messages.push({ role: m.role, content: m.content });
      }
    }

    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: req.maxOutputTokens,
    };
    if (req.temperature !== undefined) body.temperature = req.temperature;
    if (req.stopSequences?.length) body.stop = [...req.stopSequences];
    if (req.tools?.length) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema },
      }));
    }
    if (req.jsonOutput && this.options.supportsJsonMode !== false && !req.tools?.length) {
      body.response_format = { type: 'json_object' };
    }

    const started = Date.now();
    const raw = await request({
      provider: this.name,
      url: `${this.options.baseUrl().replace(/\/$/, '')}/chat/completions`,
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${apiKey}`,
        ...(this.options.extraHeaders?.() ?? {}),
      },
      body: JSON.stringify(body),
      timeoutMs: cfg.LLM_TIMEOUT_MS,
      maxAttempts: cfg.LLM_MAX_ATTEMPTS,
      signal,
    });

    let parsed: ChatCompletionBody;
    try {
      parsed = JSON.parse(raw.body.toString('utf8')) as ChatCompletionBody;
    } catch {
      throw new ProviderRequestError(this.name, raw.status, 'malformed JSON response', false);
    }
    const choice = parsed.choices?.[0];
    if (!choice) {
      throw new ProviderRequestError(this.name, raw.status, parsed.error?.message ?? 'response contained no choices', false);
    }

    const toolCalls: LLMToolCall[] = (choice.message?.tool_calls ?? []).map((c) => {
      let input: Record<string, unknown> = {};
      try {
        input = JSON.parse(c.function.arguments || '{}') as Record<string, unknown>;
      } catch {
        input = { _unparsed: c.function.arguments };
      }
      return { id: c.id, name: c.function.name, input };
    });

    return {
      text: choice.message?.content ?? '',
      toolCalls,
      usage: {
        inputTokens: parsed.usage?.prompt_tokens ?? 0,
        outputTokens: parsed.usage?.completion_tokens ?? 0,
      },
      model: parsed.model ?? model,
      provider: this.name,
      finishReason: mapFinish(choice.finish_reason),
      latencyMs: Date.now() - started,
    };
  }
}

export function createOpenAiProvider(): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    name: 'openai',
    requires: ['OPENAI_API_KEY'],
    baseUrl: () => config().OPENAI_BASE_URL,
    apiKey: () => config().OPENAI_API_KEY,
    models: () => ({
      fast: config().OPENAI_MODEL_FAST,
      balanced: config().OPENAI_MODEL_BALANCED,
      deep: config().OPENAI_MODEL_DEEP,
    }),
  });
}

export function createOpenRouterProvider(): OpenAiCompatibleProvider {
  return new OpenAiCompatibleProvider({
    name: 'openrouter',
    requires: ['OPENROUTER_API_KEY'],
    baseUrl: () => config().OPENROUTER_BASE_URL,
    apiKey: () => config().OPENROUTER_API_KEY,
    models: () => ({
      fast: config().OPENROUTER_MODEL_FAST,
      balanced: config().OPENROUTER_MODEL_BALANCED,
      deep: config().OPENROUTER_MODEL_DEEP,
    }),
    extraHeaders: () => ({
      'http-referer': config().APP_URL,
      'x-title': 'Autonomous Daily App Factory',
    }),
    supportsJsonMode: true,
  });
}
