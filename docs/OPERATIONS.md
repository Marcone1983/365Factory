# Operations

## Daily rhythm

With `SCHEDULER_ENABLED=true` the factory runs itself:

| UTC | Job | Does |
|---|---|---|
| 06:00 | `daily_market_scan` | Research through trend detection |
| 07:00 | `gap_analysis` | Gaps and competitive mapping |
| 08:00 | `opportunity_selection` | Scores and selects |
| 08:30 | `product_generation` | Invents, builds, verifies, packages |
| 03:00 | `self_improvement` | Measures quality, proposes source changes |
| 04:20 | `maintenance` | Purges expired data, checkpoints the database |

Times come from `DAILY_*_CRON`. `SCHEDULER_TIMEZONE_OFFSET_MINUTES` shifts the
calendar the expressions are evaluated against, so `0 6 * * *` with an offset of
`120` fires at 04:00 UTC.

The four discovery jobs are the same pipeline stopped at different points, which
is what makes the day resumable: the 07:00 job reads what the 06:00 job stored
rather than re-crawling.

### Missed windows

A job whose window passed while the platform was down fires **once** on the next
tick. It does not replay every occurrence it slept through — catching up on six
missed market scans would spend six days of budget to produce one day of value.

Two occurrences of the same job never overlap; the second is skipped and
recorded as `SKIPPED`.

## Autonomy modes

| `AUTONOMY_MODE` | Behaviour |
|---|---|
| `manual` | Nothing starts on its own |
| `semi` | Discovery runs automatically; building a product waits for approval; improvement proposals are recorded, not applied |
| `auto` | Full pipeline unattended; the highest-priority low-risk improvement proposal is applied automatically |

`semi` is the default and the right starting point. Move to `auto` once you have
watched a few cycles and trust the budget limits.

## Budgets

`LLM_DAILY_TOKEN_BUDGET` and `LLM_DAILY_COST_BUDGET_USD` are checked **before**
each call. Exceeding one fails the step with `BudgetExceededError` rather than
quietly switching to a cheaper model and producing worse output that looks the
same.

Set them to real numbers. Watch the **Cost & cache** page for the first week:
the "avoided" figure shows what caching is saving, and the per-operation
breakdown shows where the money actually goes — usually `code_generation` and
`product_invention`, which is why neither is cached.

To cut spend without cutting capability:

- raise `CACHE_SEMANTIC_THRESHOLD` slightly (more reuse, marginally more risk of
  reusing a near-miss);
- lower `RESEARCH_MAX_DOCUMENTS` — research cost is roughly linear in documents;
- keep the local embedding provider, which costs nothing and is sufficient for
  clustering and cache similarity.

## Monitoring

- **Overview** — live run state and the activity stream.
- **System health** — every capability's real state and what to configure.
- **Cost & cache** — spend, savings, budget headroom, provider failures.
- **Automation** — next and last run per job.

Logs are structured JSON (`LOG_PRETTY=true` for a readable console). Secrets are
redacted.

## Troubleshooting

**A run fails immediately with a capability error.** Working as intended: a
required provider is unconfigured. The error names it. Check **System health**.

**Builds fail with `TOOLCHAIN_MISSING`.** Java, Gradle or the Android SDK is
absent. The diagnostic lists exactly what is missing. Set `JAVA_HOME` and
`ANDROID_SDK_ROOT`. The platform will not produce a fake `.apk` in the meantime.

**The performance check reports a software rasteriser.** No GPU is available, so
Chromium is using SwiftShader. The check applies a 3 fps floor and becomes
non-blocking with an explicit note. This is expected on a server; it is not a
product defect.

**The scheduler shows jobs but nothing runs.** `SCHEDULER_ENABLED` is false. The
Automation page says so at the top. Set it and restart.

**Costs are higher than expected.** Check the per-operation breakdown. If
`signal_extraction` dominates, lower `RESEARCH_MAX_DOCUMENTS`. If cache hit rate
is near zero, confirm the embedding provider is working — semantic caching is
where most of the saving comes from.

**A run is stuck in `RUNNING` after a crash.** Restart. Interrupted runs are
reconciled at boot and marked failed.

**The database is locked.** WAL mode plus a 10-second busy timeout makes this
rare. If it persists, something else has the file open — check for a second
process pointed at the same `DATA_DIR`.

## Backups

Back up `DATA_DIR` and `WORKSPACES_DIR` **together**: the database references
version snapshots and artifacts that live on disk, and a database restored
without its workspace cannot roll a project back.

```bash
sqlite3 var/factory.db ".backup 'backup/factory-$(date +%F).db'"
tar czf backup/workspaces-$(date +%F).tar.gz workspaces/
```

Restore by stopping the process, replacing both, and starting it. Migrations
are idempotent and checksummed; a restored database from an older release
migrates forward on boot.

## Upgrading

1. Back up as above.
2. `git pull && npm install`
3. `npm run verify` — typecheck, lint, 159 tests.
4. `npm run build`
5. Restart. Migrations run at boot.

Never edit an applied migration; startup fails on a checksum mismatch, which is
the intended protection.

## Capacity

A full product-generation cycle takes 10–40 minutes, dominated by model latency
rather than compute. Research and build are I/O and CPU bound respectively.

Growth is driven by generated projects, not by rows: a project with 3D assets is
tens of megabytes. `MAX_WORKSPACE_BYTES` caps a single workspace at 1.5 GB.
Archive or prune old projects periodically — the database rows are cheap, the
workspaces are not.
