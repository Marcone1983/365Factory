/**
 * Offline-first persistence for generated applications.
 *
 * A tiny typed repository over IndexedDB with an automatic localStorage
 * fallback, so a product keeps working in private-browsing modes and inside the
 * Android WebView where IndexedDB is occasionally restricted.
 */

export interface Entity {
  id: string;
  updatedAt: string;
  [key: string]: unknown;
}

export interface RepositoryOptions {
  readonly databaseName: string;
  readonly version: number;
  readonly stores: readonly string[];
}

export class Repository<T extends Entity> {
  private database: IDBDatabase | null = null;
  private readonly fallbackKey: string;
  private useFallback = false;

  constructor(
    private readonly options: RepositoryOptions,
    private readonly storeName: string,
  ) {
    this.fallbackKey = `${options.databaseName}:${storeName}`;
  }

  private open(): Promise<IDBDatabase> {
    if (this.database) return Promise.resolve(this.database);
    return new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB unavailable'));
        return;
      }
      const request = indexedDB.open(this.options.databaseName, this.options.version);
      request.onupgradeneeded = () => {
        const database = request.result;
        for (const store of this.options.stores) {
          if (!database.objectStoreNames.contains(store)) database.createObjectStore(store, { keyPath: 'id' });
        }
      };
      request.onsuccess = () => {
        this.database = request.result;
        resolve(request.result);
      };
      request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed'));
    });
  }

  private readFallback(): T[] {
    try {
      return JSON.parse(window.localStorage.getItem(this.fallbackKey) ?? '[]') as T[];
    } catch {
      return [];
    }
  }

  private writeFallback(items: readonly T[]): void {
    try {
      window.localStorage.setItem(this.fallbackKey, JSON.stringify(items));
    } catch {
      /* quota exceeded: the in-memory view remains authoritative for this session */
    }
  }

  private async transaction<R>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<R>): Promise<R> {
    const database = await this.open();
    return new Promise<R>((resolve, reject) => {
      const tx = database.transaction(this.storeName, mode);
      const request = run(tx.objectStore(this.storeName));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'));
    });
  }

  async all(): Promise<T[]> {
    if (this.useFallback) return this.readFallback();
    try {
      return (await this.transaction<T[]>('readonly', (store) => store.getAll() as IDBRequest<T[]>)) ?? [];
    } catch {
      this.useFallback = true;
      return this.readFallback();
    }
  }

  async get(id: string): Promise<T | undefined> {
    if (this.useFallback) return this.readFallback().find((item) => item.id === id);
    try {
      return await this.transaction<T | undefined>('readonly', (store) => store.get(id) as IDBRequest<T | undefined>);
    } catch {
      this.useFallback = true;
      return this.readFallback().find((item) => item.id === id);
    }
  }

  async put(item: T): Promise<T> {
    const record = { ...item, updatedAt: new Date().toISOString() } as T;
    if (this.useFallback) {
      const items = this.readFallback().filter((existing) => existing.id !== record.id);
      items.push(record);
      this.writeFallback(items);
      return record;
    }
    try {
      await this.transaction('readwrite', (store) => store.put(record) as IDBRequest<IDBValidKey>);
      return record;
    } catch {
      this.useFallback = true;
      return this.put(record);
    }
  }

  async remove(id: string): Promise<void> {
    if (this.useFallback) {
      this.writeFallback(this.readFallback().filter((item) => item.id !== id));
      return;
    }
    try {
      await this.transaction('readwrite', (store) => store.delete(id) as IDBRequest<undefined>);
    } catch {
      this.useFallback = true;
      await this.remove(id);
    }
  }

  async clear(): Promise<void> {
    if (this.useFallback) {
      this.writeFallback([]);
      return;
    }
    try {
      await this.transaction('readwrite', (store) => store.clear() as IDBRequest<undefined>);
    } catch {
      this.useFallback = true;
      this.writeFallback([]);
    }
  }

  /** Exports the store as JSON so users can take their data with them. */
  async exportJson(): Promise<string> {
    return JSON.stringify({ store: this.storeName, exportedAt: new Date().toISOString(), items: await this.all() }, null, 2);
  }

  async importJson(json: string): Promise<number> {
    const parsed = JSON.parse(json) as { items?: T[] };
    const items = parsed.items ?? [];
    for (const item of items) await this.put(item);
    return items.length;
  }
}

export function createId(prefix = 'id'): string {
  const random = typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID().replace(/-/g, '').slice(0, 16)
    : Math.random().toString(36).slice(2, 18);
  return `${prefix}_${random}`;
}
