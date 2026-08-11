# Database

SQLite via better-sqlite3, one file at `DATA_DIR/factory.db` (override with
`DATABASE_PATH`).

SQLite is the right choice here and not a compromise: the workload is a single
long-running process doing sequential work, the largest tables are bounded by
how much the platform can afford to research, and a database that is one file
makes backup, snapshot and rollback trivial. better-sqlite3 is synchronous,
which removes an entire class of interleaving bug from code that is already
juggling long-running async work.

## Pragmas

| Pragma | Value | Why |
|---|---|---|
| `journal_mode` | `WAL` | Readers never block the writer — the console stays responsive during a run |
| `foreign_keys` | `ON` | Cascades are relied on; an orphan row is a bug |
| `synchronous` | `NORMAL` | Durable enough under WAL; `FULL` would cost a fsync per step |
| `busy_timeout` | `10000` | The scheduler and a console request can collide briefly |
| `temp_store` | `MEMORY` | Sorting and FTS scratch stays off disk |

## Migrations

Append-only and checksummed (`src/lib/db/migrations.ts`). Each migration is
recorded with a SHA-256 of its text; if a previously applied migration's text
changes, startup fails rather than silently diverging from what the database
actually has. Migrations run inside a transaction.

**Never edit an applied migration.** Add a new one.

| Migration | Contents |
|---|---|
| `M001` | Core schema — 38 tables |
| `M002` | FTS5 virtual tables and their sync triggers |
| `M003` | Error memory, improvement proposals, repair audits |

Run them explicitly with `npm run migrate`; the server also migrates at boot.

## Tables by area

### Identity and access
`users` · `sessions` · `audit_logs` · `rate_limits`

Sessions store a hash of the token, never the token. `audit_logs` records actor,
action, target and metadata for every consequential operation.

### Research
`research_sources` · `research_documents` · `market_signals`

`research_documents` holds the fetched page with its canonical URL, content
hash, extraction confidence and fetch time. Deduplication is by canonical URL
*and* by content hash, because the same article appears at many URLs.
`market_signals` carries the verbatim quote that was verified against the
document.

### Market intelligence
`trends` · `trend_signals` · `market_gaps` · `gap_evidence` · `opportunities` ·
`competitors`

`gap_evidence` is the provenance join: gap → signal → document. It is what lets
the console show a quote and a source link next to a score rather than asking
anyone to trust the number.

### Products
`product_concepts` · `projects` · `project_versions` · `project_file_index` ·
`assets` · `asset_generations`

`project_versions` stores a full snapshot path plus per-file changes and diff
statistics, which is what makes rollback exact. `project_file_index` is the
index the coding agent and the IDE both read — one view of the project, not two.

### Build and delivery
`builds` · `build_artifacts` · `previews` · `test_runs` · `security_scans`

`build_artifacts` records the SHA-256 and signature verification state of every
artifact. An unsigned or unverified APK is recorded as such.

### Agents and runs
`agents` · `factory_runs` · `agent_runs` · `agent_messages` · `tasks`

`factory_runs` holds the checkpoint: current step, inputs and outputs so far.
This is what makes a run resumable and what reconciliation reads at boot.

### Chat
`chat_threads` · `chat_messages`

Messages store the tool calls that produced them, so a thread is an audit record
of what the agent actually consulted.

### Knowledge and learning
`knowledge_items` · `embeddings` · `error_memories` · `improvement_proposals` ·
`repair_audits`

`error_memories` is keyed by a normalised signature: paths, positions, hashes,
quoted identifiers and numbers-with-units are collapsed, so the same *kind* of
failure is one memory however it presented itself. A verified fix is attached to
the memory and injected into later repair prompts.

### Cost and cache
`cache_entries` · `http_cache` · `api_usage` · `metrics`

`api_usage` is the source of truth for every cost figure the console displays.
Nothing is estimated from it.

### Automation
`schedules`

A schedule names a job and carries a JSON payload. It never carries code.

## Full-text search

FTS5 over `research_documents` and `knowledge_items`, kept in sync by triggers
rather than by application code, so a document inserted by any path is indexed.

## Vectors

`embeddings` stores vectors as a float32 blob with dimensions and precomputed
norm. Similarity is cosine, computed in process. There is no vector extension
dependency: at the scale this platform reaches — thousands of documents, not
millions — a linear scan over precomputed norms is faster than the round trip to
a separate service, and it keeps the deployment to one file.

## Retention

The maintenance job purges expired cache and HTTP entries, expired sessions, and
metrics older than thirty days, then runs `wal_checkpoint(TRUNCATE)`.

Research documents, market data, projects and error memories are **not** purged:
they are the platform's accumulated knowledge, and the whole point is that it
does not have to relearn them.

## Backup

Stop the process and copy `DATA_DIR`, or use SQLite's online backup:

```bash
sqlite3 var/factory.db ".backup 'backup/factory-$(date +%F).db'"
```

Back up `WORKSPACES_DIR` alongside it: the database references version snapshots
and artifacts that live on disk.
