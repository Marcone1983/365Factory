# Architecture

## Shape

One Next.js application. The console, the API and the factory itself run in the
same Node process, against one SQLite file and one workspace directory. There is
no message broker, no worker fleet and no second datastore, because the work is
long-running and sequential rather than high-throughput, and a single process
that can be reasoned about is worth more here than horizontal scale that is
never exercised.

```
                     ┌──────────────────────────────────────┐
   browser ─────────▶│  Next.js App Router                  │
                     │   pages · API routes · middleware    │
                     └───────────────┬──────────────────────┘
                                     │
        ┌────────────────────────────┼────────────────────────────┐
        │                            │                            │
  ┌─────▼──────┐            ┌────────▼────────┐          ┌────────▼────────┐
  │ orchestr.  │            │  chat agent     │          │   scheduler     │
  │ 14 steps   │            │  14 tools       │          │   6 jobs        │
  └─────┬──────┘            └────────┬────────┘          └────────┬────────┘
        │                            │                            │
        └────────────────────────────┼────────────────────────────┘
                                     │
   ┌──────────┬──────────┬───────────┼───────────┬──────────┬──────────┐
   │ research │  market  │  agents   │ generation│  build   │   qa     │
   │  fetch   │ trends   │  base     │  assets   │  web     │ browser  │
   │  extract │ gaps     │  coding   │  models   │  android │ security │
   │  store   │ scoring  │  product  │  pbr      │  preview │          │
   └────┬─────┴────┬─────┴─────┬─────┴─────┬─────┴────┬─────┴────┬─────┘
        │          │           │           │          │          │
   ┌────▼──────────▼───────────▼───────────▼──────────▼──────────▼─────┐
   │  ai router · providers · cache (L1-L8) · knowledge · improvement  │
   ├───────────────────────────────────────────────────────────────────┤
   │  db (SQLite + migrations) · workspace (jailed fs + sandbox)       │
   └───────────────────────────────────────────────────────────────────┘
```

## Module map

| Path | Responsibility |
|---|---|
| `src/app` | Console pages and API routes |
| `src/lib/config` | Environment schema, capability reporting |
| `src/lib/db` | Connection, checksummed migrations, reference data |
| `src/lib/security` | Auth, sessions, RBAC, CSRF, rate limits, audit |
| `src/lib/providers` | LLM, embedding, search, image, 3D, storage abstractions |
| `src/lib/ai` | Task router, model tiers, budgets, JSON contracts, usage |
| `src/lib/cache` | Multi-level cache and request coalescing |
| `src/lib/research` | Fetching, robots, extraction, dedup, document store |
| `src/lib/market` | Signals, trends, gaps, competition, scoring |
| `src/lib/agents` | Agent base, research/product/coding/delivery agents, repair policy |
| `src/lib/orchestrator` | The 14-step pipeline with checkpoints |
| `src/lib/generation` | Asset briefs, texture synthesis, model catalogue |
| `src/lib/graphics` | Mesh kernel, glTF writer, PNG, raster, colour |
| `src/lib/workspace` | Project records, jailed filesystem, versions, sandbox |
| `src/lib/build` | Web bundling, Android Gradle, toolchain detection, artifacts |
| `src/lib/preview` | Static preview server for built output |
| `src/lib/qa` | Headless browser runtime validation |
| `src/lib/ide` | Repo index, symbols, dependency graph, relevance ranking |
| `src/lib/knowledge` | Embeddings, knowledge items, error memory |
| `src/lib/improvement` | Quality measurement and self-improvement proposals |
| `src/lib/schedule` | Cron parser and scheduler |
| `src/lib/chat` | Chat agent and its tool registry |
| `src/lib/observability` | Logger, metrics, event bus |
| `src/runtime/engine` | The 3D SDK copied into every generated product |

## The pipeline

`src/lib/orchestrator/factory.ts` runs fourteen steps:

```
research → trends → gaps → competition → selection → invention → assets
        → architecture → implementation → build → qa → security → package → learning
```

Each step writes a checkpoint before it starts, recording its inputs, outputs,
cost and duration. A run can be stopped after any step, which is how the chat
distinguishes "find gaps" from "build it", and how the four discovery schedules
share one pipeline: the morning scan stops after `trends`, the gap analysis
resumes from the database rather than re-crawling, and so on.

A run interrupted by a restart is reconciled at boot rather than left `RUNNING`
forever.

## Data flow, and why provenance survives it

```
search result ─▶ fetch (robots-checked) ─▶ extract ─▶ research_documents
                                                         │
                                     signal + verbatim quote (verified)
                                                         ▼
                                                   market_signals
                                                         │
                                       embedding clustering by leader
                                                         ▼
                                                       trends
                                                         │
                                            synthesis + evidence gate
                                                         ▼
                                                    market_gaps ──▶ gap_evidence
                                                         │
                                                     scoring
                                                         ▼
                                                   opportunities
```

`gap_evidence` links each gap back to the signal *and* the document it came
from, so the discovery page can show the quote and a link to the page it was
fetched from. Nothing in the chain is summarised into an unattributable claim.

## Concurrency

better-sqlite3 is synchronous, so database access needs no locking discipline
inside the process. Long work — a factory run, a build, a browser session — is
async and cancellable through an `AbortSignal` threaded from the caller.

Two things are deliberately serialised:

- **Scheduled jobs.** Two concurrent factory runs would compete for the same
  daily budget and the same workspace, and neither would finish sooner. A due
  job whose previous occurrence is still running is skipped and recorded as
  such.
- **Cache computation.** Identical concurrent lookups coalesce into one
  computation; the rest await it.

## State

| Where | What |
|---|---|
| SQLite (`DATA_DIR`) | Everything relational: runs, research, market data, projects, versions, cache, usage, knowledge, error memory, schedules |
| Workspace (`WORKSPACES_DIR`) | Per-project `source/ assets/ build/ preview/ artifacts/ logs/ metadata/ versions/` |
| Process memory | L1 cache, event replay buffer, rate limit counters |

Process memory is disposable by design: a restart loses the event buffer and the
hot cache, and nothing else.

## Extending it

**A new provider** implements the interface in `src/lib/providers/types.ts` and
registers in `registry.ts`. Its `status()` must report honestly whether it is
configured — that is what the health page and the capability gate read.

**A new agent** extends the base in `src/lib/agents/base.ts`, which supplies
budget checks, retries, JSON contract enforcement, event emission and run
accounting.

**A new chat tool** is added to `CHAT_TOOLS` in `src/lib/chat/tools.ts` with a
Zod schema and, if it does anything expensive or destructive, a permission.

**A new scheduled job** is added to the `HANDLERS` map in
`src/lib/schedule/scheduler.ts`. Schedules reference jobs by name; nothing
stored in the database is ever executed.
