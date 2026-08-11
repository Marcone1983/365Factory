import { config } from '@/lib/config/env';
import { AnthropicProvider } from './llm/anthropic';
import { createOpenAiProvider, createOpenRouterProvider } from './llm/openai-compatible';
import { LocalEmbeddingProvider } from './embedding/local';
import { OpenAiEmbeddingProvider } from './embedding/openai';
import {
  BraveSearchProvider,
  SearxngSearchProvider,
  SerperSearchProvider,
  TavilySearchProvider,
} from './search/web-search';
import { ProceduralImageProvider } from './image/procedural';
import { OpenAiImageProvider, StabilityImageProvider } from './image/remote';
import { FilesystemStorageProvider } from './storage/filesystem';
import { MeshyModel3DProvider, TripoModel3DProvider } from './model3d/generative';
import type {
  EmbeddingProvider,
  ImageGenerationProvider,
  LLMProvider,
  Model3DProvider,
  ProviderStatus,
  StorageProvider,
  WebSearchProvider,
} from './types';

/**
 * Provider registry.
 *
 * Selection is driven purely by configuration. Every getter also exposes a
 * setter: provider substitutability is a product requirement (an operator can
 * drop in a self-hosted gateway) and it is what lets the integration test suite
 * drive the whole factory against deterministic providers.
 */

interface Registry {
  llm: LLMProvider | null;
  embedding: EmbeddingProvider | null;
  search: WebSearchProvider | null;
  image: ImageGenerationProvider | null;
  model3d: Model3DProvider | null;
  storage: StorageProvider | null;
}

const overrides: Registry = { llm: null, embedding: null, search: null, image: null, model3d: null, storage: null };
const cache: Registry = { llm: null, embedding: null, search: null, image: null, model3d: null, storage: null };

// ---------------------------------------------------------------------- LLM --

function buildLlm(name: string): LLMProvider {
  switch (name) {
    case 'openai':
      return createOpenAiProvider();
    case 'openrouter':
      return createOpenRouterProvider();
    case 'anthropic':
    default:
      return new AnthropicProvider();
  }
}

export function allLlmProviders(): LLMProvider[] {
  return [new AnthropicProvider(), createOpenAiProvider(), createOpenRouterProvider()];
}

/**
 * Returns the configured LLM provider. If the configured one has no credentials
 * but another one does, the platform falls back to it and says so in the status
 * report rather than failing the whole run.
 */
export function getLlmProvider(): LLMProvider {
  if (overrides.llm) return overrides.llm;
  const preferred = buildLlm(config().LLM_PROVIDER);
  if (preferred.status().configured) return preferred;
  const fallback = allLlmProviders().find((p) => p.status().configured);
  return fallback ?? preferred;
}

export function setLlmProvider(provider: LLMProvider | null): void {
  overrides.llm = provider;
}

// ---------------------------------------------------------------- Embedding --

export function getEmbeddingProvider(): EmbeddingProvider {
  if (overrides.embedding) return overrides.embedding;
  if (cache.embedding) return cache.embedding;
  const name = config().EMBEDDING_PROVIDER;
  let provider: EmbeddingProvider = new LocalEmbeddingProvider();
  if (name === 'openai') {
    const remote = new OpenAiEmbeddingProvider();
    if (remote.status().configured) provider = remote;
  }
  cache.embedding = provider;
  return provider;
}

export function setEmbeddingProvider(provider: EmbeddingProvider | null): void {
  overrides.embedding = provider;
  cache.embedding = null;
}

// ------------------------------------------------------------------- Search --

export function allSearchProviders(): WebSearchProvider[] {
  return [new BraveSearchProvider(), new TavilySearchProvider(), new SerperSearchProvider(), new SearxngSearchProvider()];
}

function buildSearch(name: string): WebSearchProvider {
  switch (name) {
    case 'tavily':
      return new TavilySearchProvider();
    case 'serper':
      return new SerperSearchProvider();
    case 'searxng':
      return new SearxngSearchProvider();
    case 'brave':
    default:
      return new BraveSearchProvider();
  }
}

export function getSearchProvider(): WebSearchProvider {
  if (overrides.search) return overrides.search;
  const preferred = buildSearch(config().SEARCH_PROVIDER);
  if (preferred.status().configured) return preferred;
  const fallback = allSearchProviders().find((p) => p.status().configured);
  return fallback ?? preferred;
}

export function setSearchProvider(provider: WebSearchProvider | null): void {
  overrides.search = provider;
}

// -------------------------------------------------------------------- Image --

export function allImageProviders(): ImageGenerationProvider[] {
  return [new ProceduralImageProvider(), new OpenAiImageProvider(), new StabilityImageProvider()];
}

export function getImageProvider(): ImageGenerationProvider {
  if (overrides.image) return overrides.image;
  const name = config().IMAGE_PROVIDER;
  if (name === 'openai') {
    const p = new OpenAiImageProvider();
    if (p.status().configured) return p;
  }
  if (name === 'stability') {
    const p = new StabilityImageProvider();
    if (p.status().configured) return p;
  }
  return new ProceduralImageProvider();
}

/** Always available, deterministic, exact-size generator for platform assets. */
export function getProceduralImageProvider(): ImageGenerationProvider {
  return new ProceduralImageProvider();
}

export function setImageProvider(provider: ImageGenerationProvider | null): void {
  overrides.image = provider;
}

// ----------------------------------------------------------------- Model3D --

export function allModel3dProviders(): Model3DProvider[] {
  return [new MeshyModel3DProvider(), new TripoModel3DProvider()];
}

/**
 * Returns the configured generative-3D provider, or null when none is
 * available. Null is a supported state: the subdivision-surface generators
 * produce real models without it.
 */
export function getModel3dProvider(): Model3DProvider | null {
  if (overrides.model3d) return overrides.model3d;
  const name = config().MODEL3D_PROVIDER;
  if (name === 'none') return null;
  const provider = name === 'tripo' ? new TripoModel3DProvider() : new MeshyModel3DProvider();
  return provider.status().configured ? provider : null;
}

export function setModel3dProvider(provider: Model3DProvider | null): void {
  overrides.model3d = provider;
}

// ------------------------------------------------------------------ Storage --

export function getStorageProvider(): StorageProvider {
  if (overrides.storage) return overrides.storage;
  if (!cache.storage) cache.storage = new FilesystemStorageProvider();
  return cache.storage;
}

export function setStorageProvider(provider: StorageProvider | null): void {
  overrides.storage = provider;
  cache.storage = null;
}

export function resetRegistry(): void {
  overrides.llm = null;
  overrides.embedding = null;
  overrides.search = null;
  overrides.image = null;
  overrides.model3d = null;
  overrides.storage = null;
  cache.embedding = null;
  cache.storage = null;
}

// ------------------------------------------------------------------ status --

export function providerStatuses(): ProviderStatus[] {
  return [
    ...allLlmProviders().map((p) => p.status()),
    new LocalEmbeddingProvider().status(),
    new OpenAiEmbeddingProvider().status(),
    ...allSearchProviders().map((p) => p.status()),
    ...allImageProviders().map((p) => p.status()),
    ...allModel3dProviders().map((p) => p.status()),
    getStorageProvider().status(),
  ];
}
