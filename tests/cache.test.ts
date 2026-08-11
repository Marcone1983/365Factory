import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from './helpers/env';
import { cacheKey, stableStringify } from '@/lib/cache';

let env: TestEnvironment;

beforeEach(() => {
  env = createTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

/**
 * The cache is the platform's cost control. A key that is not stable across
 * equivalent inputs silently doubles the API bill, and a coalescer that lets two
 * identical requests through doubles it again, so both are asserted directly.
 */

describe('stableStringify', () => {
  it('produces the same string for objects that differ only in key order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }));
    expect(stableStringify({ x: { q: 1, p: 2 } })).toBe(stableStringify({ x: { p: 2, q: 1 } }));
  });

  it('preserves array order, which is meaningful', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]));
  });

  it('ignores undefined members so an absent option and an explicit undefined agree', () => {
    expect(stableStringify({ a: 1, b: undefined })).toBe(stableStringify({ a: 1 }));
  });

  it('distinguishes null from undefined and from the string "null"', () => {
    expect(stableStringify({ a: null })).not.toBe(stableStringify({ a: 'null' }));
    expect(stableStringify({ a: null })).not.toBe(stableStringify({}));
  });
});

describe('cacheKey', () => {
  it('is namespaced and deterministic', () => {
    const a = cacheKey('llm', { prompt: 'hello', temperature: 0.2 });
    const b = cacheKey('llm', { temperature: 0.2, prompt: 'hello' });
    expect(a).toBe(b);
    expect(a.startsWith('llm:')).toBe(true);
  });

  it('separates namespaces so a search result cannot satisfy an LLM lookup', () => {
    expect(cacheKey('llm', 'x')).not.toBe(cacheKey('search', 'x'));
  });

  it('changes when any input changes', () => {
    expect(cacheKey('llm', { prompt: 'a' })).not.toBe(cacheKey('llm', { prompt: 'b' }));
  });
});

describe('L1 and L2', () => {
  it('persists a value to SQLite and serves it back after the memory cache is cleared', async () => {
    const { cacheSet, cacheGet, clearMemoryCache } = await import('@/lib/cache');

    cacheSet('k1', 'test', { hello: 'world' }, 600);
    expect(cacheGet<{ hello: string }>('k1')).toEqual({ hello: 'world' });

    clearMemoryCache();
    // L1 is empty now, so a hit here proves the value really reached L2.
    expect(cacheGet<{ hello: string }>('k1')).toEqual({ hello: 'world' });
  });

  it('does not serve an expired entry', async () => {
    const { cacheSet, cacheGet, clearMemoryCache } = await import('@/lib/cache');
    const { db } = await import('@/lib/db/client');

    cacheSet('k2', 'test', 'value', 600);
    db()
      .prepare('UPDATE cache_entries SET expires_at = ? WHERE key = ?')
      .run(new Date(Date.now() - 1000).toISOString(), 'k2');
    clearMemoryCache();

    expect(cacheGet('k2')).toBeUndefined();
  });

  it('deletes from both levels', async () => {
    const { cacheSet, cacheGet, cacheDelete } = await import('@/lib/cache');
    cacheSet('k3', 'test', 'value', 600);
    cacheDelete('k3');
    expect(cacheGet('k3')).toBeUndefined();
  });

  it('invalidates a whole namespace', async () => {
    const { cacheSet, cacheGet, cacheInvalidateNamespace } = await import('@/lib/cache');
    cacheSet('a', 'alpha', 1, 600);
    cacheSet('b', 'alpha', 2, 600);
    cacheSet('c', 'beta', 3, 600);

    expect(cacheInvalidateNamespace('alpha')).toBe(2);
    expect(cacheGet('a')).toBeUndefined();
    expect(cacheGet('c')).toBe(3);
  });

  it('purges expired rows', async () => {
    const { cacheSet, purgeExpiredCache } = await import('@/lib/cache');
    const { db } = await import('@/lib/db/client');

    cacheSet('old', 'test', 1, 600);
    cacheSet('fresh', 'test', 2, 600);
    db()
      .prepare('UPDATE cache_entries SET expires_at = ? WHERE key = ?')
      .run(new Date(Date.now() - 1000).toISOString(), 'old');

    expect(purgeExpiredCache()).toBe(1);
  });
});

describe('cached()', () => {
  it('computes once and serves the second call from cache', async () => {
    const { cached } = await import('@/lib/cache');
    let computations = 0;
    const compute = async (): Promise<number> => {
      computations += 1;
      return 42;
    };

    const first = await cached({ q: 'x' }, { namespace: 'test' }, compute);
    const second = await cached({ q: 'x' }, { namespace: 'test' }, compute);

    expect(first.source).toBe('computed');
    expect(second.source).toBe('l1');
    expect(second.value).toBe(42);
    expect(computations).toBe(1);
  });

  it('coalesces identical concurrent lookups into one computation', async () => {
    const { cached } = await import('@/lib/cache');
    let computations = 0;
    const compute = async (): Promise<string> => {
      computations += 1;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return 'once';
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () => cached({ q: 'concurrent' }, { namespace: 'test' }, compute)),
    );

    expect(computations).toBe(1);
    expect(results.every((r) => r.value === 'once')).toBe(true);
    expect(results.filter((r) => r.source === 'coalesced')).toHaveLength(7);
  });

  it('reports the cost avoided so the savings figure is measured, not estimated after the fact', async () => {
    const { cached } = await import('@/lib/cache');
    const compute = async (): Promise<number> => 1;

    const miss = await cached({ q: 'cost' }, { namespace: 'test', estimatedCostUsd: 0.04 }, compute);
    const hit = await cached({ q: 'cost' }, { namespace: 'test', estimatedCostUsd: 0.04 }, compute);

    expect(miss.savedUsd).toBe(0);
    expect(hit.savedUsd).toBeCloseTo(0.04, 6);
  });

  it('recomputes when the caller asks to bypass', async () => {
    const { cached } = await import('@/lib/cache');
    let computations = 0;
    const compute = async (): Promise<number> => {
      computations += 1;
      return computations;
    };

    await cached({ q: 'bypass' }, { namespace: 'test' }, compute);
    const forced = await cached({ q: 'bypass' }, { namespace: 'test', bypass: true }, compute);

    expect(computations).toBe(2);
    expect(forced.source).toBe('computed');
  });

  it('propagates a computation failure instead of caching it', async () => {
    const { cached } = await import('@/lib/cache');
    let attempts = 0;
    const failing = async (): Promise<number> => {
      attempts += 1;
      throw new Error('provider unavailable');
    };

    await expect(cached({ q: 'fail' }, { namespace: 'test' }, failing)).rejects.toThrow('provider unavailable');
    // A cached failure would make one bad minute poison an entire TTL.
    await expect(cached({ q: 'fail' }, { namespace: 'test' }, failing)).rejects.toThrow('provider unavailable');
    expect(attempts).toBe(2);
  });
});

describe('semantic layer', () => {
  it('serves a near-identical query from an existing entry', async () => {
    const { cached } = await import('@/lib/cache');
    let computations = 0;
    const compute = async (): Promise<string> => {
      computations += 1;
      return 'market gap report';
    };

    const text = 'best market gaps for productivity software today';
    await cached({ q: text }, { namespace: 'semantic-test', semanticText: text, semanticThreshold: 0.8 }, compute);

    const similar = 'top market gaps for productivity software today';
    const hit = await cached(
      { q: similar },
      { namespace: 'semantic-test', semanticText: similar, semanticThreshold: 0.8 },
      compute,
    );

    expect(hit.source).toBe('semantic');
    expect(hit.value).toBe('market gap report');
    expect(hit.similarity).toBeGreaterThanOrEqual(0.8);
    expect(computations).toBe(1);
  });

  it('does not serve an unrelated query from the semantic layer', async () => {
    const { cached } = await import('@/lib/cache');
    const compute = async (): Promise<string> => 'result';

    await cached(
      { q: 'a' },
      { namespace: 'semantic-test-2', semanticText: 'kubernetes operator reconciliation loops', semanticThreshold: 0.85 },
      compute,
    );
    const other = await cached(
      { q: 'b' },
      { namespace: 'semantic-test-2', semanticText: 'sourdough starter hydration ratios', semanticThreshold: 0.85 },
      compute,
    );

    expect(other.source).toBe('computed');
  });
});

describe('cacheStats', () => {
  it('reports per-namespace entry counts', async () => {
    const { cacheSet, cacheStats } = await import('@/lib/cache');
    cacheSet('s1', 'alpha', 'a', 600);
    cacheSet('s2', 'alpha', 'b', 600);
    cacheSet('s3', 'beta', 'c', 600);

    const stats = cacheStats();
    expect(stats.l2Entries).toBe(3);
    expect(stats.namespaces.find((n) => n.namespace === 'alpha')?.entries).toBe(2);
    expect(stats.l2Bytes).toBeGreaterThan(0);
  });
});
