import { db } from '@/lib/db/client';
import { config } from '@/lib/config/env';

export interface RateLimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: number;
  readonly limit: number;
}

/**
 * Fixed-window rate limiter backed by SQLite so limits hold across all request
 * handlers in the process and survive restarts.
 */
export function consume(bucket: string, limit: number, windowSeconds: number): RateLimitResult {
  const now = Math.floor(Date.now() / 1000);
  const windowStart = now - (now % windowSeconds);
  const database = db();

  const tx = database.transaction((): { count: number } => {
    const row = database
      .prepare<[string], { window_start: number; count: number }>(
        'SELECT window_start, count FROM rate_limits WHERE bucket = ?',
      )
      .get(bucket);
    if (!row || row.window_start !== windowStart) {
      database
        .prepare(
          `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?, ?, 1)
           ON CONFLICT(bucket) DO UPDATE SET window_start = excluded.window_start, count = 1`,
        )
        .run(bucket, windowStart);
      return { count: 1 };
    }
    database.prepare('UPDATE rate_limits SET count = count + 1 WHERE bucket = ?').run(bucket);
    return { count: row.count + 1 };
  });

  const { count } = tx();
  return {
    allowed: count <= limit,
    remaining: Math.max(0, limit - count),
    resetAt: (windowStart + windowSeconds) * 1000,
    limit,
  };
}

export function consumeDefault(bucket: string): RateLimitResult {
  const cfg = config();
  return consume(bucket, cfg.RATE_LIMIT_MAX_REQUESTS, cfg.RATE_LIMIT_WINDOW_S);
}

export function consumeLogin(identifier: string): RateLimitResult {
  const cfg = config();
  return consume(`login:${identifier}`, cfg.RATE_LIMIT_LOGIN_MAX, cfg.RATE_LIMIT_WINDOW_S * 5);
}

export class RateLimitError extends Error {
  readonly status = 429;
  constructor(readonly result: RateLimitResult) {
    super('Rate limit exceeded');
    this.name = 'RateLimitError';
  }
}
