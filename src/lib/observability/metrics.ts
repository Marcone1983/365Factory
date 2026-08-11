import { db, newId, nowIso, toJson } from '@/lib/db/client';
import { config } from '@/lib/config/env';

export interface Labels {
  readonly [key: string]: string | number | boolean;
}

interface Series {
  count: number;
  sum: number;
  min: number;
  max: number;
  last: number;
  lastTs: number;
}

const live = new Map<string, Series>();

function key(name: string, labels: Labels): string {
  const entries = Object.entries(labels).sort(([a], [b]) => a.localeCompare(b));
  return entries.length === 0 ? name : `${name}|${entries.map(([k, v]) => `${k}=${v}`).join(',')}`;
}

function record(name: string, value: number, labels: Labels, persist: boolean): void {
  const k = key(name, labels);
  const existing = live.get(k);
  if (existing) {
    existing.count += 1;
    existing.sum += value;
    existing.min = Math.min(existing.min, value);
    existing.max = Math.max(existing.max, value);
    existing.last = value;
    existing.lastTs = Date.now();
  } else {
    live.set(k, { count: 1, sum: value, min: value, max: value, last: value, lastTs: Date.now() });
  }
  if (!persist) return;
  try {
    if (!config().METRICS_ENABLED) return;
    db()
      .prepare('INSERT INTO metrics (id, ts, name, value, labels) VALUES (?, ?, ?, ?, ?)')
      .run(newId('met'), nowIso(), name, value, toJson(labels));
  } catch {
    /* metrics must never take down the caller */
  }
}

/** Monotonic event counter. Persisted so the dashboards survive restarts. */
export function counter(name: string, labels: Labels = {}, value = 1): void {
  record(name, value, labels, true);
}

/** Point-in-time value (queue depth, memory, cache size). Persisted. */
export function gauge(name: string, value: number, labels: Labels = {}): void {
  record(name, value, labels, true);
}

/** Latency/duration observation in milliseconds. Persisted. */
export function observe(name: string, ms: number, labels: Labels = {}): void {
  record(name, ms, labels, true);
}

/** High-frequency in-memory only observation (cache probes, per-token counts). */
export function track(name: string, value = 1, labels: Labels = {}): void {
  record(name, value, labels, false);
}

export async function timed<T>(name: string, labels: Labels, fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  try {
    const result = await fn();
    observe(name, Date.now() - started, { ...labels, outcome: 'success' });
    return result;
  } catch (error) {
    observe(name, Date.now() - started, { ...labels, outcome: 'error' });
    throw error;
  }
}

export interface SnapshotEntry {
  readonly key: string;
  readonly count: number;
  readonly sum: number;
  readonly avg: number;
  readonly min: number;
  readonly max: number;
  readonly last: number;
  readonly lastTs: number;
}

export function snapshot(): SnapshotEntry[] {
  return [...live.entries()]
    .map(([k, s]) => ({
      key: k,
      count: s.count,
      sum: s.sum,
      avg: s.count === 0 ? 0 : s.sum / s.count,
      min: s.min,
      max: s.max,
      last: s.last,
      lastTs: s.lastTs,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

export function resetMetrics(): void {
  live.clear();
}
