import crypto from 'node:crypto';
import { config } from '@/lib/config/env';
import type { EmbeddingProvider, EmbeddingResult, ProviderStatus } from '../types';

/**
 * Deterministic in-process text embedding based on feature hashing
 * (the "hashing trick", Weinberger et al. 2009) over word unigrams, word
 * bigrams and character 4-grams, with sub-linear term weighting and signed
 * hashing to keep the projection unbiased.
 *
 * This is a real vector space model, not a placeholder: it supports the
 * semantic cache, near-duplicate detection and signal clustering with zero
 * external calls and zero cost. A remote embedding provider gives better
 * recall on paraphrase; both satisfy the same interface.
 */

const WORD_RE = /[\p{L}\p{N}][\p{L}\p{N}'_-]*/gu;

function hash32(input: string, seed: number): number {
  // FNV-1a with a seed mixed into the offset basis.
  let h = (0x811c9dc5 ^ seed) >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD_RE) ?? []).filter((t) => t.length <= 40);
}

export function localEmbed(text: string, dims: number): Float32Array {
  const vector = new Float32Array(dims);
  const tokens = tokenize(text);
  const counts = new Map<string, number>();

  const bump = (feature: string, weight: number): void => {
    counts.set(feature, (counts.get(feature) ?? 0) + weight);
  };

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i] as string;
    bump(`w:${token}`, 1);
    const next = tokens[i + 1];
    if (next) bump(`b:${token}_${next}`, 0.6);
  }

  // Character 4-grams over the normalised text give resilience to morphology
  // and to spelling variation across sources.
  const compact = tokens.join(' ');
  for (let i = 0; i + 4 <= compact.length; i += 1) {
    bump(`c:${compact.slice(i, i + 4)}`, 0.25);
  }

  for (const [feature, rawCount] of counts) {
    const weight = 1 + Math.log(rawCount);
    const idx = hash32(feature, 1) % dims;
    const sign = (hash32(feature, 2) & 1) === 0 ? 1 : -1;
    vector[idx] = (vector[idx] as number) + sign * weight;
  }

  let norm = 0;
  for (let i = 0; i < dims; i += 1) norm += (vector[i] as number) ** 2;
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dims; i += 1) vector[i] = (vector[i] as number) / norm;
  }
  return vector;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local-hashed-ngram';
  readonly dims: number;

  constructor(dims = config().EMBEDDING_DIMENSIONS) {
    this.dims = dims;
  }

  status(): ProviderStatus {
    return {
      name: this.name,
      kind: 'embedding',
      configured: true,
      detail: `In-process hashed n-gram embeddings (${this.dims} dimensions, no external calls, no cost).`,
      requires: [],
    };
  }

  async embed(texts: readonly string[]): Promise<EmbeddingResult> {
    const vectors = texts.map((t) => localEmbed(t, this.dims));
    const tokens = texts.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
    return { vectors, model: this.name, dims: this.dims, tokens };
  }
}

export function textHash(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}
