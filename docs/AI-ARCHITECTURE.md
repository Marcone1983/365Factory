# AI architecture

## Providers

Every external AI service sits behind an interface in
`src/lib/providers/types.ts`. The platform depends on the interface; swapping a
provider is a configuration change.

| Kind | Implementations | Env |
|---|---|---|
| LLM | Anthropic Messages API; any OpenAI-compatible endpoint (OpenRouter, local) | `LLM_PROVIDER`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `OPENAI_BASE_URL` |
| Embedding | Local hashed n-gram feature hashing; OpenAI | `EMBEDDING_PROVIDER`, `OPENAI_API_KEY` |
| Web search | Brave, Tavily, Serper, SearXNG | `SEARCH_PROVIDER` and its key |
| Image | Procedural synthesis; OpenAI; Stability | `IMAGE_PROVIDER` and its key |
| 3D | Meshy, Tripo3D | `MODEL3D_PROVIDER` and its key |
| Storage | Filesystem | `STORAGE_PROVIDER` |

Every provider implements `status()`, which reports whether it is configured and
what is missing. This is the single source of truth for the health page and for
the capability gate that refuses a run which cannot possibly succeed.

**The local embedding provider is real, not a fallback stub.** It is a hashed
n-gram feature extractor with L2 normalisation — a genuine (if less capable)
embedding. It exists so semantic caching and clustering work without an API key
at all, and the tests exercise it: the cache suite proves it collapses "best
market gaps for productivity software today" and "top market gaps for
productivity software today" into one computation.

## The router

`src/lib/ai/router.ts` is the only path to a model. It owns tier selection,
budget enforcement, caching, JSON contracts and usage accounting, so no caller
can accidentally bypass any of them.

### Tiers

Three tiers — `fast`, `balanced`, `deep` — map to concrete model ids per
provider. Callers name a **task**, never a model, so the whole platform can be
re-tiered from one table.

### Task policies

Each of the 19 tasks declares its tier, output cap, temperature, cache TTL and
whether semantic cache reuse is allowed:

| Task | Tier | Cache | Reasoning |
|---|---|---|---|
| `query_expansion` | fast | 6h, semantic | The same objective yields the same queries |
| `signal_extraction` | fast | 7d, exact | A document does not change |
| `gap_synthesis` | balanced | 12h, semantic | Same evidence, same gaps |
| `product_invention` | deep | **never** | Reusing an invention produces the same product twice |
| `code_generation` | deep | **never** | Context is unique per file |
| `code_repair` | deep | **never** | The error memory supplies the reuse instead |

The full table is on the **Cost & cache** page, rendered from the policies
themselves rather than duplicated in prose.

### Budgets

Daily token and cost budgets are checked *before* the call. Exceeding one throws
`BudgetExceededError`, which fails the step honestly rather than silently
degrading to a cheaper model and producing worse output that looks the same.

### JSON contracts

`completeJson` takes a Zod schema, asks for JSON, extracts it from whatever
wrapping arrived, and validates. On failure it re-prompts with the validation
errors, up to a bounded number of repair rounds, then throws
`JsonContractError`. Malformed output never becomes a silently-defaulted object.

## Caching

Eight layers, described in `src/lib/cache/index.ts`:

```
L1  in-process LRU            hot, per process
L2  SQLite                    survives restart
L3  semantic similarity       near-identical prompts reuse a result
L4  HTTP conditional          ETag / Last-Modified on fetched pages
L5  research results          namespace 'search' / 'document'
L6  LLM responses             namespace 'llm'
L7  embeddings                text → vector, keyed by content hash
L8  asset metadata            namespace 'asset'
```

A lookup walks L1 → L2 → L3 and only then computes. Identical concurrent
lookups coalesce into a single computation — the cache suite asserts eight
simultaneous callers produce exactly one.

Cache keys are namespaced SHA-256 over a **deterministic** serialisation with
sorted keys and `undefined` members dropped, so an absent option and an explicit
`undefined` produce the same key rather than two entries.

Failures are never cached: a bad minute must not poison a whole TTL.

## Agents

`src/lib/agents/base.ts` supplies budget checks, retries with backoff, JSON
contract enforcement, event emission and per-run accounting. Fourteen agents are
registered, from `research` through `coding` to `learning`.

### The no-regression policy

Every code-generation and repair prompt carries `NO_REGRESSION_DIRECTIVE`
verbatim. `assessRepair` then checks the produced diff and **rejects** repairs
that:

- delete a feature to make an error go away;
- weaken, skip or delete a test instead of fixing what it caught;
- replace a hard implementation with a simpler one that does less;
- stub something out and leave it unfinished.

Rejections are recorded in `repair_audits`. This is the mechanism behind the
project's standing rule that errors are solved rather than removed.

### Error memory

`recordFailure` normalises an error into a signature — collapsing paths (relative
as well as absolute), positions, hashes, quoted identifiers, and numbers with
unit suffixes — so `failed after 1240ms` and `failed after 87ms` are one lesson.
Error codes like `TS2339` survive normalisation deliberately, so genuinely
different diagnostics stay distinct.

`recordFix` attaches a remedy only after it has been *verified* by a typecheck,
build, runtime check or test. `recallSimilar` returns exact signature matches
first, then semantically similar resolved failures, and `renderMemoriesForPrompt`
injects them into the next repair prompt.

## Self-improvement

`src/lib/improvement/engine.ts` measures platform quality (build success rate,
first-pass typecheck rate, runtime pass rate, asset validation rate, mean FPS,
cost per product, cache hit rate, error recurrence rate, repair rejection rate),
gathers observations from recorded failures, and proposes source changes.

Proposals are constrained to `IMPROVABLE_ROOTS` and refused if they touch
`PROTECTED_PATTERNS`. Only in `AUTONOMY_MODE=auto` is the highest-priority
low-risk proposal applied automatically; otherwise it waits for a decision. Each
applied proposal's effect is measured afterwards against the same snapshot, so
an improvement that did not improve anything is visible.

## Cost accounting

Every provider call writes an `api_usage` row: provider, model, operation,
tokens, cost, cache outcome, latency, success. Cost comes from a per-model
pricing table (`src/lib/providers/pricing.ts`). A cache hit records what the
call *would* have cost as `saved_usd`.

Every figure on the Cost & cache page is summed from these rows. When there are
no rows, the page says so rather than showing a projection.
