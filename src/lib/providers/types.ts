/** Provider-neutral contracts. Every external capability is reached through one
 * of these interfaces so that no part of the platform is bound to a vendor. */

export type ModelTier = 'fast' | 'balanced' | 'deep';

export interface ProviderStatus {
  readonly name: string;
  readonly kind: ProviderKind;
  readonly configured: boolean;
  readonly detail: string;
  /** Environment variables the operator must set to enable this provider. */
  readonly requires: readonly string[];
}

export type ProviderKind = 'llm' | 'embedding' | 'search' | 'image' | 'model3d' | 'storage' | 'build';

export class ProviderNotConfiguredError extends Error {
  readonly status = 503;
  readonly code = 'PROVIDER_NOT_CONFIGURED';
  constructor(readonly provider: string, readonly requires: readonly string[]) {
    super(
      `Provider "${provider}" is not configured. Set ${requires.join(', ')} to enable it. ` +
        'The platform does not fabricate results for unconfigured providers.',
    );
    this.name = 'ProviderNotConfiguredError';
  }
}

export class ProviderRequestError extends Error {
  readonly code = 'PROVIDER_REQUEST_FAILED';
  constructor(
    readonly provider: string,
    readonly status: number,
    message: string,
    readonly retryable: boolean,
    readonly body?: string,
  ) {
    super(`[${provider}] ${status} ${message}`);
    this.name = 'ProviderRequestError';
  }
}

// ---------------------------------------------------------------------- LLM --

export type LLMRole = 'user' | 'assistant';

/**
 * An image attached to a message.
 *
 * Vision is not a convenience here: it is what lets the platform look at what
 * it produced. A generated asset can only be judged against its brief by
 * someone — or something — that can see the render.
 */
export interface LLMImage {
  /** Raw image bytes; encoded per provider at the call site. */
  readonly data: Buffer;
  readonly mimeType: 'image/png' | 'image/jpeg' | 'image/webp';
  /** Shown before the image, so the model knows what it is looking at. */
  readonly caption?: string;
}

export interface LLMMessage {
  readonly role: LLMRole;
  readonly content: string;
  /** Images accompanying this message. Ignored by providers without vision. */
  readonly images?: readonly LLMImage[];
}

export interface LLMToolDefinition {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

export interface LLMToolCall {
  readonly id: string;
  readonly name: string;
  readonly input: Record<string, unknown>;
}

export interface LLMRequest {
  readonly system?: string;
  readonly messages: readonly LLMMessage[];
  readonly tools?: readonly LLMToolDefinition[];
  readonly maxOutputTokens: number;
  readonly temperature?: number;
  readonly stopSequences?: readonly string[];
  /** Explicit model id. When absent the router resolves one from `tier`. */
  readonly model?: string;
  readonly tier?: ModelTier;
  /** Ask the model for a single JSON object as the whole response. */
  readonly jsonOutput?: boolean;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type FinishReason = 'stop' | 'length' | 'tool_use' | 'content_filter' | 'other';

export interface LLMResponse {
  readonly text: string;
  readonly toolCalls: readonly LLMToolCall[];
  readonly usage: TokenUsage;
  readonly model: string;
  readonly provider: string;
  readonly finishReason: FinishReason;
  readonly latencyMs: number;
}

export interface LLMProvider {
  readonly name: string;
  status(): ProviderStatus;
  modelFor(tier: ModelTier): string;
  complete(request: LLMRequest, signal?: AbortSignal): Promise<LLMResponse>;
}

// ---------------------------------------------------------------- Embedding --

export interface EmbeddingResult {
  readonly vectors: readonly Float32Array[];
  readonly model: string;
  readonly dims: number;
  readonly tokens: number;
}

export interface EmbeddingProvider {
  readonly name: string;
  readonly dims: number;
  status(): ProviderStatus;
  embed(texts: readonly string[], signal?: AbortSignal): Promise<EmbeddingResult>;
}

// ------------------------------------------------------------------- Search --

export interface SearchOptions {
  readonly count?: number;
  readonly freshness?: 'day' | 'week' | 'month' | 'year' | 'any';
  readonly language?: string;
  readonly country?: string;
  readonly site?: string;
}

export interface SearchResult {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly publishedAt?: string;
  readonly rank: number;
  readonly engine: string;
}

export interface SearchResponse {
  readonly query: string;
  readonly results: readonly SearchResult[];
  readonly provider: string;
  readonly latencyMs: number;
  readonly units: number;
}

export interface WebSearchProvider {
  readonly name: string;
  status(): ProviderStatus;
  search(query: string, options?: SearchOptions, signal?: AbortSignal): Promise<SearchResponse>;
}

// -------------------------------------------------------------------- Image --

export type ImagePurpose =
  | 'app_icon'
  | 'logo'
  | 'splash'
  | 'texture'
  | 'character'
  | 'environment'
  | 'prop'
  | 'ui'
  | 'promo'
  | 'screenshot_background';

export interface ImageRequest {
  readonly purpose: ImagePurpose;
  readonly prompt: string;
  readonly width: number;
  readonly height: number;
  /** Deterministic seed. Procedural generation is fully reproducible from it. */
  readonly seed: number;
  readonly palette?: readonly string[];
  readonly tileable?: boolean;
  readonly negativePrompt?: string;
}

export interface ImageResult {
  readonly data: Buffer;
  readonly mime: 'image/png';
  readonly width: number;
  readonly height: number;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly costUsd: number;
}

export interface ImageGenerationProvider {
  readonly name: string;
  status(): ProviderStatus;
  generate(request: ImageRequest, signal?: AbortSignal): Promise<ImageResult>;
}

// ------------------------------------------------------------------ Storage --

export interface StoredObject {
  readonly key: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly path: string;
}

export interface StorageProvider {
  readonly name: string;
  status(): ProviderStatus;
  put(key: string, data: Buffer): Promise<StoredObject>;
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  stat(key: string): Promise<StoredObject | null>;
}

// --------------------------------------------------------------- 3D models --

export type Model3DClass = 'character' | 'creature' | 'vehicle' | 'weapon' | 'prop' | 'structure' | 'environment';

export interface Model3DRequest {
  readonly prompt: string;
  readonly negativePrompt?: string;
  readonly modelClass: Model3DClass;
  /** Art direction passed to the service, e.g. "realistic" or "sculpture". */
  readonly style?: 'realistic' | 'sculpture' | 'stylised' | 'low_poly';
  /** Target triangle budget. Providers that support decimation honour it. */
  readonly targetTriangles?: number;
  /** Ask the service for PBR texture maps rather than a flat base colour. */
  readonly pbr?: boolean;
  readonly seed?: number;
  /** Deterministic reference image (PNG) for image-to-3D pipelines. */
  readonly referenceImage?: Buffer;
}

export interface Model3DResult {
  /** Binary glTF. Always validated before it is accepted into a project. */
  readonly glb: Buffer;
  readonly provider: string;
  readonly model: string;
  readonly latencyMs: number;
  readonly costUsd: number;
  readonly taskId: string;
}

/**
 * Generative 3D model service. Implementations wrap an asynchronous
 * text-to-3D / image-to-3D API: submit, poll, download the GLB.
 */
export interface Model3DProvider {
  readonly name: string;
  status(): ProviderStatus;
  generate(request: Model3DRequest, signal?: AbortSignal): Promise<Model3DResult>;
}
