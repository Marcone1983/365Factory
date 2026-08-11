# Market intelligence

The part of the platform that is easiest to fake, and therefore the part built
most carefully. Everything here exists to make one claim defensible: *this
opportunity is real, and here is the page that says so.*

## Pipeline

```
objective
   │  query expansion (LLM, cached 6h)
   ▼
search queries ──▶ provider (Brave / Tavily / Serper / SearXNG)
   │
   │  robots.txt check · SSRF guard · size and time bounds
   ▼
fetched pages ──▶ readability-style extraction ──▶ research_documents
   │                                                (canonical URL, content hash,
   │                                                 extraction confidence)
   │  signal extraction (LLM) + verbatim quote verification
   ▼
market_signals ──▶ embedding clustering ──▶ trends (momentum)
   │
   │  gap synthesis + multiplicative evidence gate
   ▼
market_gaps ──▶ gap_evidence (gap → signal → document)
   │
   │  competitive research
   ▼
opportunities (weighted score + confidence discount)
```

## Crawling politely

`robots.txt` is fetched, cached, and parsed per **RFC 9309** — longest-match
rule precedence, correct wildcard and `$` handling, `crawl-delay` honoured. A
disallowed URL is not fetched. There is no override.

Requests carry an identifying user agent, respect per-host concurrency limits
and a global rate limit, and are bounded in response size and time.

### SSRF

Hostnames are resolved and the **resolved addresses** are checked against
private, loopback, link-local, unique-local and CGNAT ranges before connecting.
Checking a hostname alone is defeated by a DNS record pointing at `127.0.0.1`,
so the check happens after resolution and again at every redirect hop.

`RESEARCH_ALLOW_PRIVATE_HOSTS` exists only to point the crawler at local test
fixtures. It must stay off in production.

## Extraction

A readability-style algorithm scores candidate containers on text density, link
density, paragraph count and semantic tags, then extracts the winner as text.
Boilerplate — navigation, footers, cookie banners — is dropped. An extraction
confidence is recorded and low-confidence documents are down-weighted rather
than discarded, because a thin page is still evidence, just weaker.

## Deduplication

Two mechanisms, because they catch different things:

- **Canonical URL** — tracking parameters stripped, `rel=canonical` honoured.
  Catches the same page reached by different links.
- **Content hash** — catches syndicated copies of the same article at genuinely
  different URLs, which would otherwise inflate an evidence count with what is
  really one source.

## Signals, and the quote rule

A signal is a claim about the market with:

- the **verbatim quote** that supports it,
- the document it came from,
- a type (complaint, request, praise, pricing, gap, trend),
- intensity and confidence.

**The quote is verified against the fetched document before the signal is
stored.** If the model paraphrased, the quote will not be found, and no signal
is created. This single check is what stops the entire downstream chain from
resting on something a model made up, and it is why the discovery page can show
a quotation next to a score.

## Trends

Signals are clustered by embedding similarity using leader clustering — one pass,
a similarity threshold, no fixed cluster count. Momentum is computed over a
90-day window with exponential recency weighting, weighting each signal by
`confidence × (0.5 + 0.5 × intensity)`, so a recent burst of high-confidence
complaints outweighs a long tail of weak mentions.

## Gaps and the evidence gate

Gap synthesis proposes unmet needs from a cluster. Each proposed gap must then
pass a **multiplicative** gate before it can be scored:

- a minimum number of **independent sources** — independent by domain, not by
  URL, so ten pages from one site count once;
- a minimum aggregate signal confidence;
- at least one **first-hand** report rather than only commentary.

It is multiplicative on purpose. Additive scoring lets a gap with overwhelming
enthusiasm from a single blog outrank one with modest evidence from six
independent sources. Here, a zero on any factor is a zero overall: no amount of
apparent enthusiasm substitutes for corroboration.

## Opportunity scoring

Eight weighted components, all normalised to 0–1
(`src/lib/market/scoring.ts`, version `opportunity-v1`):

| Component | Weight | What it measures |
|---|---:|---|
| `demand` | 0.20 | Volume and breadth of independent signals |
| `pain` | 0.18 | Severity, from complaint density and negative sentiment in first-hand reports |
| `growth` | 0.12 | Momentum of the underlying trend |
| `competitionInverse` | 0.14 | Head-room left by incumbents |
| `monetization` | 0.10 | Plausibility of a durable revenue model |
| `feasibility` | 0.12 | Buildability in one cycle on the available toolchain |
| `originality` | 0.08 | Distance from the closest discovered product |
| `timing` | 0.06 | Why now: technology, platform shift, regulation, seasonality |

The weighted sum is then **discounted by data confidence**:

```
score = 100 × Σ(componentᵢ × weightᵢ) × dataConfidence^0.5
```

The exponent is 0.5 rather than 1.0 deliberately. A linear discount makes
thin evidence collapse a score so hard that nothing is ever comparable; no
discount at all lets a confident-sounding guess rank alongside a
well-evidenced finding. The square root penalises weak evidence noticeably
without making it worthless.

Thresholds:

| Setting | Default | Effect |
|---|---:|---|
| `acceptanceThreshold` | 58 | Below this, archived rather than built |
| `minimumDataConfidence` | 0.35 | Below this, never auto-built regardless of score |
| `maximumSimilarity` | 0.86 | At or above this similarity to an incumbent, the concept must be revised |

The full breakdown — every component, its weight and its contribution — is
stored with the opportunity, so a score can be taken apart rather than taken on
trust. The model can be overridden by a JSON file without a code change, and
weights that do not sum to 1 are normalised with a warning.

## Competitive intelligence

For a selected gap, the platform researches existing products: what they do,
pricing, positioning, and what their users complain about. This feeds
`competitionInverse` and `originality`, and it gates invention — a concept
scoring at or above `maximumSimilarity` to an incumbent is sent back for
revision rather than built as a clone.

## Provenance in the console

The **Discovery** page shows, for each gap: the statement, the verbatim quote,
a link to the source page, the source category and the evidence weight. An
operator can check any claim against the page it came from without leaving the
console. That is the whole design goal of this subsystem.
