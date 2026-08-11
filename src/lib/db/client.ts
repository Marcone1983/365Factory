import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from '@/lib/config/env';
import { MIGRATIONS, type Migration } from './migrations';

export type Db = Database.Database;

let instance: Db | null = null;

function checksum(sql: string): string {
  return crypto.createHash('sha256').update(sql.trim()).digest('hex').slice(0, 32);
}

function ensureMigrationTable(db: Db): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      checksum   TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

export interface MigrationResult {
  readonly applied: number[];
  readonly current: number;
}

export function runMigrations(db: Db, migrations: readonly Migration[] = MIGRATIONS): MigrationResult {
  ensureMigrationTable(db);
  const rows = db
    .prepare<[], { version: number; name: string; checksum: string }>(
      'SELECT version, name, checksum FROM schema_migrations ORDER BY version',
    )
    .all();
  const applied = new Map(rows.map((r) => [r.version, r]));

  for (const row of rows) {
    const known = migrations.find((m) => m.version === row.version);
    if (!known) {
      throw new Error(
        `Database contains migration ${row.version} (${row.name}) unknown to this build. ` +
          'Deploying an older build over a newer schema is not supported.',
      );
    }
    if (checksum(known.sql) !== row.checksum) {
      throw new Error(
        `Migration ${row.version} (${row.name}) has been modified after it was applied. ` +
          'Migrations are append-only; add a new migration instead.',
      );
    }
  }

  const ordered = [...migrations].sort((a, b) => a.version - b.version);
  const appliedNow: number[] = [];
  const insert = db.prepare(
    'INSERT INTO schema_migrations (version, name, checksum, applied_at) VALUES (?, ?, ?, ?)',
  );

  for (const migration of ordered) {
    if (applied.has(migration.version)) continue;
    const tx = db.transaction(() => {
      db.exec(migration.sql);
      insert.run(migration.version, migration.name, checksum(migration.sql), new Date().toISOString());
    });
    tx();
    appliedNow.push(migration.version);
  }

  const current = ordered.length > 0 ? (ordered[ordered.length - 1] as Migration).version : 0;
  return { applied: appliedNow, current };
}

export interface OpenOptions {
  readonly file?: string;
  readonly migrate?: boolean;
  readonly readonly?: boolean;
}

export function openDatabase(options: OpenOptions = {}): Db {
  const cfg = config();
  const file = options.file ?? cfg.databasePath;
  if (file !== ':memory:') {
    fs.mkdirSync(path.dirname(file), { recursive: true });
  }
  const db = new Database(file, { readonly: options.readonly ?? false });
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 10000');
  db.pragma('temp_store = MEMORY');
  db.function('uuid', () => crypto.randomUUID());
  if (options.migrate !== false && !options.readonly) {
    runMigrations(db);
  }
  return db;
}

/** Process-wide singleton connection. better-sqlite3 is synchronous and safe to share. */
export function db(): Db {
  if (!instance) {
    instance = openDatabase();
    seedReferenceData(instance);
  }
  return instance;
}

export function closeDatabase(): void {
  if (instance) {
    instance.close();
    instance = null;
  }
}

/**
 * Reference data that the platform itself owns (the agent registry). These are
 * configuration rows describing the platform's own components, not fabricated
 * market data.
 */
export function seedReferenceData(database: Db): void {
  const now = new Date().toISOString();
  const agentRows: ReadonlyArray<[string, string, string, string]> = [
    ['research', 'Web research and source verification', 'Formulates queries, fetches and cross-checks sources, maintains provenance.', 'fast'],
    ['trend', 'Trend detection', 'Clusters market signals into trends and measures momentum.', 'fast'],
    ['gap', 'Gap detection', 'Derives unmet needs and market gaps from clustered signals.', 'balanced'],
    ['competitive', 'Competitive intelligence', 'Maps competitors, pricing, complaints and differentiation.', 'balanced'],
    ['inventor', 'Product invention', 'Turns a scored opportunity into an original product concept.', 'deep'],
    ['architect', 'Product architecture', 'Designs the technical architecture and file plan.', 'deep'],
    ['asset', 'Asset generation', 'Generates brand identity, raster art, textures and 3D meshes.', 'fast'],
    ['threed', '3D world and gameplay', 'Synthesises 3D scenes, gameplay systems and tuning.', 'deep'],
    ['coding', 'Software implementation', 'Reads, writes and refactors project source; drives the fix loop.', 'deep'],
    ['qa', 'Quality assurance', 'Runs and interprets automated tests and runtime validation.', 'balanced'],
    ['build', 'Build engineering', 'Runs the web and Android build pipelines and signs artifacts.', 'fast'],
    ['security', 'Security review', 'Scans generated code and artifacts for security defects.', 'balanced'],
    ['performance', 'Performance engineering', 'Analyses runtime metrics and applies optimisations.', 'balanced'],
    ['learning', 'Knowledge consolidation', 'Persists outcomes and lessons into the knowledge layer.', 'fast'],
  ];
  const insertAgent = database.prepare(
    `INSERT INTO agents (id, name, role, description, default_model_tier, enabled, created_at)
     VALUES (?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT(name) DO UPDATE SET role = excluded.role, description = excluded.description`,
  );
  // Schedules are deliberately *not* seeded here. They are owned by
  // schedule/scheduler.ts, which is the only place that knows the job registry
  // and can compute next_run_at from the cron expression; a row written without
  // one would sit in the table looking configured and never fire.
  const tx = database.transaction(() => {
    for (const [name, role, description, tier] of agentRows) {
      insertAgent.run(`agent_${name}`, name, role, description, tier, now);
    }
  });
  tx();
}

// ------------------------------------------------------------------ helpers --

export function nowIso(): string {
  return new Date().toISOString();
}

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function toJson(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function fromJson<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}
