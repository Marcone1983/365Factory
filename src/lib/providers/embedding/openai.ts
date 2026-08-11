import { config } from '@/lib/config/env';
import { request } from '../http';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type EmbeddingProvider,
  type EmbeddingResult,
  type ProviderStatus,
} from '../types';

interface EmbeddingBody {
  data?: Array<{ embedding: number[]; index: number }>;
  model?: string;
  usage?: { prompt_tokens?: number };
  error?: { message?: string };
}

const REQUIRES = ['OPENAI_API_KEY'] as const;
const BATCH = 96;

export class OpenAiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly dims: number;

  constructor() {
    this.dims = config().EMBEDDING_DIMENSIONS;
  }

  status(): ProviderStatus {
    const configured = Boolean(config().OPENAI_API_KEY);
    return {
      name: this.name,
      kind: 'embedding',
      configured,
      detail: configured
        ? `OpenAI embeddings (${config().EMBEDDING_MODEL}, ${this.dims} dimensions)`
        : 'OPENAI_API_KEY is not set; remote embeddings are refused.',
      requires: REQUIRES,
    };
  }

  async embed(texts: readonly string[], signal?: AbortSignal): Promise<EmbeddingResult> {
    const cfg = config();
    const apiKey = cfg.OPENAI_API_KEY;
    if (!apiKey) throw new ProviderNotConfiguredError(this.name, REQUIRES);

    const vectors: Float32Array[] = [];
    let tokens = 0;

    for (let offset = 0; offset < texts.length; offset += BATCH) {
      const batch = texts.slice(offset, offset + BATCH);
      const raw = await request({
        provider: this.name,
        limiterKey: 'openai-embeddings',
        url: `${cfg.OPENAI_BASE_URL.replace(/\/$/, '')}/embeddings`,
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({ model: cfg.EMBEDDING_MODEL, input: batch, dimensions: this.dims }),
        timeoutMs: 60_000,
        maxAttempts: 3,
        signal,
      });
      const parsed = JSON.parse(raw.body.toString('utf8')) as EmbeddingBody;
      if (!parsed.data) {
        throw new ProviderRequestError(this.name, raw.status, parsed.error?.message ?? 'no embedding data', false);
      }
      const ordered = [...parsed.data].sort((a, b) => a.index - b.index);
      for (const item of ordered) vectors.push(Float32Array.from(item.embedding));
      tokens += parsed.usage?.prompt_tokens ?? 0;
    }

    return { vectors, model: cfg.EMBEDDING_MODEL, dims: this.dims, tokens };
  }
}
