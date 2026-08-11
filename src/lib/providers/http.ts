import { ProviderRequestError } from './types';
import { createLogger } from '@/lib/observability/logger';
import { counter, observe } from '@/lib/observability/metrics';

const log = createLogger('providers.http');

// ------------------------------------------------------------ circuit breaker --

type BreakerState = 'closed' | 'open' | 'half_open';

interface Breaker {
  state: BreakerState;
  failures: number;
  openedAt: number;
  successesInHalfOpen: number;
}

const FAILURE_THRESHOLD = 5;
const OPEN_DURATION_MS = 30_000;
const HALF_OPEN_SUCCESSES = 2;

const breakers = new Map<string, Breaker>();

function breakerFor(key: string): Breaker {
  let b = breakers.get(key);
  if (!b) {
    b = { state: 'closed', failures: 0, openedAt: 0, successesInHalfOpen: 0 };
    breakers.set(key, b);
  }
  return b;
}

export class CircuitOpenError extends Error {
  readonly code = 'CIRCUIT_OPEN';
  readonly status = 503;
  constructor(readonly target: string, readonly retryAfterMs: number) {
    super(`Circuit breaker open for ${target}; retry in ${Math.ceil(retryAfterMs / 1000)}s`);
    this.name = 'CircuitOpenError';
  }
}

function assertClosed(key: string): void {
  const b = breakerFor(key);
  if (b.state === 'open') {
    const elapsed = Date.now() - b.openedAt;
    if (elapsed < OPEN_DURATION_MS) throw new CircuitOpenError(key, OPEN_DURATION_MS - elapsed);
    b.state = 'half_open';
    b.successesInHalfOpen = 0;
  }
}

function recordSuccess(key: string): void {
  const b = breakerFor(key);
  if (b.state === 'half_open') {
    b.successesInHalfOpen += 1;
    if (b.successesInHalfOpen >= HALF_OPEN_SUCCESSES) {
      b.state = 'closed';
      b.failures = 0;
    }
    return;
  }
  b.failures = 0;
  b.state = 'closed';
}

function recordFailure(key: string): void {
  const b = breakerFor(key);
  b.failures += 1;
  if (b.state === 'half_open' || b.failures >= FAILURE_THRESHOLD) {
    b.state = 'open';
    b.openedAt = Date.now();
    counter('circuit.opened', { target: key });
    log.warn('circuit breaker opened', { target: key, failures: b.failures });
  }
}

export function breakerSnapshot(): Array<{ target: string; state: BreakerState; failures: number }> {
  return [...breakers.entries()].map(([target, b]) => ({ target, state: b.state, failures: b.failures }));
}

export function resetBreakers(): void {
  breakers.clear();
}

// ------------------------------------------------------------- rate limiting --

interface Limiter {
  tokens: number;
  lastRefill: number;
  capacity: number;
  refillPerMs: number;
  queue: Array<() => void>;
}

const limiters = new Map<string, Limiter>();

/** Token-bucket limiter shared by every caller of the same key. */
export function configureRateLimit(key: string, requestsPerMinute: number, burst = requestsPerMinute): void {
  limiters.set(key, {
    tokens: burst,
    capacity: burst,
    lastRefill: Date.now(),
    refillPerMs: requestsPerMinute / 60_000,
    queue: [],
  });
}

async function acquire(key: string): Promise<void> {
  const limiter = limiters.get(key);
  if (!limiter) return;
  for (;;) {
    const now = Date.now();
    limiter.tokens = Math.min(limiter.capacity, limiter.tokens + (now - limiter.lastRefill) * limiter.refillPerMs);
    limiter.lastRefill = now;
    if (limiter.tokens >= 1) {
      limiter.tokens -= 1;
      return;
    }
    const waitMs = Math.ceil((1 - limiter.tokens) / limiter.refillPerMs);
    await sleep(Math.min(waitMs, 5_000));
  }
}

// -------------------------------------------------------------------- retry --

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

export interface RequestOptions {
  readonly url: string;
  readonly method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  readonly headers?: Record<string, string>;
  readonly body?: string | Buffer;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly provider: string;
  /** Rate-limit / circuit-breaker key. Defaults to the provider name. */
  readonly limiterKey?: string;
  readonly signal?: AbortSignal;
  readonly acceptStatuses?: readonly number[];
}

export interface RawResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly body: Buffer;
  readonly attempts: number;
  readonly latencyMs: number;
}

function backoffDelay(attempt: number, retryAfterHeader: string | null): number {
  if (retryAfterHeader) {
    const seconds = Number.parseFloat(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000);
    const date = Date.parse(retryAfterHeader);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 60_000);
  }
  const base = Math.min(1000 * 2 ** (attempt - 1), 30_000);
  return base + Math.floor(Math.random() * 250);
}

/**
 * Performs an HTTP request with timeout, exponential backoff with jitter,
 * token-bucket rate limiting and a per-target circuit breaker.
 */
export async function request(options: RequestOptions): Promise<RawResponse> {
  const {
    url,
    method = 'GET',
    headers = {},
    body,
    timeoutMs = 60_000,
    maxAttempts = 3,
    provider,
    signal,
    acceptStatuses,
  } = options;
  const limiterKey = options.limiterKey ?? provider;
  const started = Date.now();
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    assertClosed(limiterKey);
    await acquire(limiterKey);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timeout after ${timeoutMs}ms`)), timeoutMs);
    const onAbort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    try {
      const response = await fetch(url, {
        method,
        headers,
        body: body as BodyInit | undefined,
        signal: controller.signal,
        redirect: 'follow',
      });
      const buffer = Buffer.from(await response.arrayBuffer());
      const ok = response.ok || acceptStatuses?.includes(response.status) === true;
      if (ok) {
        recordSuccess(limiterKey);
        observe('provider.http.latency', Date.now() - started, { provider, outcome: 'success' });
        return {
          status: response.status,
          headers: response.headers,
          body: buffer,
          attempts: attempt,
          latencyMs: Date.now() - started,
        };
      }

      const retryable = RETRYABLE_STATUS.has(response.status);
      const text = buffer.toString('utf8').slice(0, 2000);
      lastError = new ProviderRequestError(provider, response.status, response.statusText || 'request failed', retryable, text);
      if (!retryable || attempt === maxAttempts) {
        recordFailure(limiterKey);
        throw lastError;
      }
      const delay = backoffDelay(attempt, response.headers.get('retry-after'));
      counter('provider.http.retry', { provider, status: response.status });
      log.warn('retrying provider request', { provider, url: safeUrl(url), status: response.status, attempt, delay });
      await sleep(delay);
    } catch (error) {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error instanceof ProviderRequestError && !error.retryable) throw error;
      if (signal?.aborted) throw error;
      lastError = error as Error;
      if (attempt === maxAttempts) {
        recordFailure(limiterKey);
        observe('provider.http.latency', Date.now() - started, { provider, outcome: 'error' });
        throw lastError;
      }
      const delay = backoffDelay(attempt, null);
      counter('provider.http.retry', { provider, status: 0 });
      log.warn('retrying provider request after transport error', {
        provider,
        url: safeUrl(url),
        attempt,
        delay,
        error: (error as Error).message,
      });
      await sleep(delay);
      continue;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }
  }

  throw lastError ?? new Error(`Request to ${provider} failed`);
}

export async function requestJson<T>(options: RequestOptions): Promise<{ data: T; raw: RawResponse }> {
  const raw = await request(options);
  const text = raw.body.toString('utf8');
  try {
    return { data: JSON.parse(text) as T, raw };
  } catch {
    throw new ProviderRequestError(options.provider, raw.status, 'response was not valid JSON', false, text.slice(0, 500));
  }
}

function safeUrl(url: string): string {
  try {
    const u = new URL(url);
    u.search = '';
    return u.href;
  } catch {
    return '[unparseable-url]';
  }
}
