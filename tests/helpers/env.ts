import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resetConfigCache } from '@/lib/config/env';
import { closeDatabase, db } from '@/lib/db/client';

/**
 * Test harness.
 *
 * Every suite that touches persistence runs against its own temporary DATA_DIR
 * and its own SQLite file, created by the real migrations. Nothing is stubbed:
 * a test that says the cache persisted a value has genuinely written it to a
 * database that went through M001-M003, so a schema mistake fails a test rather
 * than surviving until production.
 */

export interface TestEnvironment {
  readonly dir: string;
  readonly databasePath: string;
  cleanup(): void;
}

const ORIGINAL = { ...process.env };

/**
 * Points the process at a fresh workspace and returns a cleanup handle. The
 * environment is restored on cleanup so suites cannot leak configuration into
 * each other.
 */
export function createTestEnvironment(overrides: Record<string, string> = {}): TestEnvironment {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adaf-test-'));

  closeDatabase();
  for (const key of Object.keys(process.env)) {
    if (!(key in ORIGINAL)) delete process.env[key];
  }
  Object.assign(process.env, ORIGINAL);

  // The Node typings declare NODE_ENV readonly. A harness that points the
  // process at a scratch environment is exactly the case where writing it is
  // correct, so the assignment goes through a mutable view of the same object.
  const mutableEnv = process.env as Record<string, string | undefined>;
  mutableEnv.NODE_ENV = 'test';
  process.env.DATA_DIR = path.join(dir, 'var');
  process.env.WORKSPACES_DIR = path.join(dir, 'workspaces');
  process.env.DATABASE_PATH = path.join(dir, 'var', 'test.db');
  process.env.SESSION_SECRET = 'a'.repeat(64);
  // Suites assert on behaviour, not on log volume.
  process.env.LOG_LEVEL = 'error';
  process.env.METRICS_ENABLED = 'false';
  process.env.SCHEDULER_ENABLED = 'false';
  process.env.EMBEDDING_PROVIDER = 'local';
  Object.assign(process.env, overrides);

  resetConfigCache();

  return {
    dir,
    databasePath: process.env.DATABASE_PATH,
    cleanup(): void {
      closeDatabase();
      fs.rmSync(dir, { recursive: true, force: true });
      for (const key of Object.keys(process.env)) {
        if (!(key in ORIGINAL)) delete process.env[key];
      }
      Object.assign(process.env, ORIGINAL);
      resetConfigCache();
    },
  };
}

/** Opens (and migrates) the test database. */
export function testDb(): ReturnType<typeof db> {
  return db();
}
