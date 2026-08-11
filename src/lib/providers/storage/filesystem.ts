import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '@/lib/config/env';
import { ensureDir, resolveInside } from '@/lib/workspace/paths';
import type { ProviderStatus, StorageProvider, StoredObject } from '../types';

/**
 * Local filesystem object store rooted at DATA_DIR/objects. Keys are treated as
 * untrusted relative paths and resolved through the workspace jail, so a key
 * can never escape the store.
 */
export class FilesystemStorageProvider implements StorageProvider {
  readonly name = 'filesystem';
  private readonly root: string;

  constructor(root?: string) {
    this.root = root ?? path.join(config().dataDir, 'objects');
    ensureDir(this.root);
  }

  status(): ProviderStatus {
    return {
      name: this.name,
      kind: 'storage',
      configured: true,
      detail: `Local object store at ${this.root}`,
      requires: [],
    };
  }

  private pathFor(key: string): string {
    return resolveInside(this.root, key);
  }

  async put(key: string, data: Buffer): Promise<StoredObject> {
    const target = this.pathFor(key);
    ensureDir(path.dirname(target));
    // Atomic publish: write to a sibling temp file then rename.
    const tmp = `${target}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    await fs.promises.writeFile(tmp, data, { mode: 0o640 });
    await fs.promises.rename(tmp, target);
    return {
      key,
      bytes: data.length,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
      path: target,
    };
  }

  async get(key: string): Promise<Buffer> {
    return fs.promises.readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.promises.access(this.pathFor(key), fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    await fs.promises.rm(this.pathFor(key), { force: true });
  }

  async stat(key: string): Promise<StoredObject | null> {
    const target = this.pathFor(key);
    try {
      const stats = await fs.promises.stat(target);
      const data = await fs.promises.readFile(target);
      return {
        key,
        bytes: stats.size,
        sha256: crypto.createHash('sha256').update(data).digest('hex'),
        path: target,
      };
    } catch {
      return null;
    }
  }
}

export function sha256(data: Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}
