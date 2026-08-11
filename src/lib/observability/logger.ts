import crypto from 'node:crypto';
import { config } from '@/lib/config/env';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogFields {
  readonly [key: string]: unknown;
}

const REDACT_KEYS = /(?:api[_-]?key|secret|password|token|authorization|keystore|credential)/i;

/** Recursively redacts secret-looking values so logs are safe to ship. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[depth-limit]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > 4000 ? `${value.slice(0, 4000)}…` : value;
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 8).join('\n') };
  }
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

export interface LogRecord {
  readonly ts: string;
  readonly level: LogLevel;
  readonly msg: string;
  readonly scope: string;
  readonly traceId?: string;
  readonly [key: string]: unknown;
}

type Sink = (record: LogRecord) => void;

const sinks: Sink[] = [];

export function addLogSink(sink: Sink): () => void {
  sinks.push(sink);
  return () => {
    const i = sinks.indexOf(sink);
    if (i >= 0) sinks.splice(i, 1);
  };
}

/** Ring buffer of recent records, surfaced by the System Health page. */
const RING_SIZE = 500;
const ring: LogRecord[] = [];

export function recentLogs(limit = 200, minLevel: LogLevel = 'debug'): LogRecord[] {
  return ring
    .filter((r) => LEVEL_ORDER[r.level] >= LEVEL_ORDER[minLevel])
    .slice(-limit)
    .reverse();
}

export class Logger {
  constructor(
    private readonly scope: string,
    private readonly base: LogFields = {},
  ) {}

  child(scope: string, fields: LogFields = {}): Logger {
    return new Logger(`${this.scope}.${scope}`, { ...this.base, ...fields });
  }

  with(fields: LogFields): Logger {
    return new Logger(this.scope, { ...this.base, ...fields });
  }

  debug(msg: string, fields?: LogFields): void {
    this.emit('debug', msg, fields);
  }
  info(msg: string, fields?: LogFields): void {
    this.emit('info', msg, fields);
  }
  warn(msg: string, fields?: LogFields): void {
    this.emit('warn', msg, fields);
  }
  error(msg: string, fields?: LogFields): void {
    this.emit('error', msg, fields);
  }

  private emit(level: LogLevel, msg: string, fields?: LogFields): void {
    let min: LogLevel = 'info';
    let pretty = false;
    try {
      const cfg = config();
      min = cfg.LOG_LEVEL;
      pretty = cfg.LOG_PRETTY;
    } catch {
      /* configuration not loadable yet: fall back to defaults */
    }
    if (LEVEL_ORDER[level] < LEVEL_ORDER[min]) return;

    const record: LogRecord = {
      ts: new Date().toISOString(),
      level,
      msg,
      scope: this.scope,
      ...(redact({ ...this.base, ...fields }) as Record<string, unknown>),
    };

    ring.push(record);
    if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);

    const line = pretty
      ? `${record.ts} ${level.toUpperCase().padEnd(5)} [${this.scope}] ${msg} ${
          Object.keys(record).length > 4 ? JSON.stringify(omitBase(record)) : ''
        }`
      : JSON.stringify(record);

    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);

    for (const sink of sinks) {
      try {
        sink(record);
      } catch {
        /* a broken sink must never break the caller */
      }
    }
  }
}

function omitBase(record: LogRecord): Record<string, unknown> {
  const { ts: _ts, level: _level, msg: _msg, scope: _scope, ...rest } = record;
  return rest;
}

export function createLogger(scope: string, fields: LogFields = {}): Logger {
  return new Logger(scope, fields);
}

export function newTraceId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export const logger = createLogger('factory');
