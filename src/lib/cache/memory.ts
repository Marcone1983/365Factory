/**
 * L1: in-process LRU with TTL.
 *
 * Bounded by entry count and by an approximate byte budget so a burst of large
 * documents cannot exhaust the heap.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
  bytes: number;
}

export class LruCache<T> {
  private readonly map = new Map<string, Entry<T>>();
  private bytes = 0;

  constructor(
    private readonly maxEntries: number,
    private readonly maxBytes = 64 * 1024 * 1024,
  ) {}

  get(key: string): T | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt <= Date.now()) {
      this.map.delete(key);
      this.bytes -= entry.bytes;
      return undefined;
    }
    // Refresh recency.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: string, value: T, ttlSeconds: number, approximateBytes = 512): void {
    const existing = this.map.get(key);
    if (existing) this.bytes -= existing.bytes;
    this.map.delete(key);
    this.map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000, bytes: approximateBytes });
    this.bytes += approximateBytes;
    this.evict();
  }

  delete(key: string): void {
    const entry = this.map.get(key);
    if (entry) {
      this.bytes -= entry.bytes;
      this.map.delete(key);
    }
  }

  clear(): void {
    this.map.clear();
    this.bytes = 0;
  }

  get size(): number {
    return this.map.size;
  }

  get approximateBytes(): number {
    return this.bytes;
  }

  private evict(): void {
    while ((this.map.size > this.maxEntries || this.bytes > this.maxBytes) && this.map.size > 0) {
      const oldest = this.map.keys().next();
      if (oldest.done) return;
      const entry = this.map.get(oldest.value);
      if (entry) this.bytes -= entry.bytes;
      this.map.delete(oldest.value);
    }
  }
}
