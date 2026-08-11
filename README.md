# Autonomous Daily App Factory

A platform that researches the web for unmet software needs, scores the
opportunities it finds, invents a product, generates its code and 3D assets,
builds it, verifies it by running it, and packages it as an Android application
— on a schedule, without an operator.

It is an operating console, not a demo. Every number it shows is read from
something that actually happened.

---

## The one rule this codebase is built around

**Nothing is ever simulated.**

There is no mock data, no placeholder market research, no fake preview, no
stub APK. When a capability is not configured, the platform says so and refuses
the steps that depend on it. It never produces a plausible-looking result in
place of a real one.

Concretely:

| If… | The platform does this | It never does this |
|---|---|---|
| No LLM key is set | Reports the capability as unavailable; the chat API returns 503 naming the missing key | Return a canned answer |
| No search key is set | Refuses to start a run that needs research, listing the remedy | Invent market signals |
| The Android SDK is absent | Reports `TOOLCHAIN_MISSING` and produces no artifact | Write a file named `.apk` |
| No research has run | Shows "No research has been performed yet" | Show sample trends |
| No API calls were made | Shows `$0.00` and says nothing was recorded | Show a projected cost |
| A generated model fails validation | Records the problems and warns | Ship it anyway |

This is enforced by tests: the end-to-end suite asserts that an empty factory
reports itself as empty, and that a chat turn with no provider configured
returns an error rather than a reply.

---

## What it does

1. **Research** — expands an objective into search queries, fetches results
   while honouring `robots.txt` (RFC 9309), extracts readable content, and
   stores each document with its provenance. Every extracted signal carries a
   verbatim quote that is verified against the fetched page before it is saved.
2. **Trends** — clusters signals by embedding similarity and measures momentum
   over a time window.
3. **Gaps** — synthesises unmet needs from clustered evidence, with a
   multiplicative evidence gate: a gap without enough independent sources cannot
   pass regardless of how good it sounds.
4. **Competition** — maps who already serves the need, at what price, and what
   their users complain about.
5. **Selection** — scores opportunities on a documented weighted model and picks
   the strongest one above the acceptance threshold.
6. **Invention** — turns the opportunity into an original product concept, and
   revises it when it scores too close to an incumbent.
7. **Assets** — generates brand identity, raster art, PBR textures and 3D models.
8. **Architecture & implementation** — designs the file plan and writes the
   source, with a repair loop driven by recorded failures.
9. **Build** — bundles the web product with esbuild; generates a real Android
   Gradle project and signs the APK with `apksigner`.
10. **QA** — boots the product in headless Chromium and observes it: scene load,
    WebGL context, draw calls, input response, save/load round-trip, frame rate,
    offline shell.
11. **Security** — scans the generated code and artifacts.
12. **Package & learn** — persists artifacts and consolidates what was learned.

## The 3D pipeline

Generated games are 3D, and the geometry is genuinely modelled rather than
assembled from primitives:

- **Mesh kernel** — Catmull-Clark subdivision with edge and vertex creasing,
  lofting through cross-sections, surfaces of revolution, superellipse profiles,
  Newell face normals, angle-threshold vertex splitting, vertex-clustering LOD.
- **Model generators** — characters built from anthropometric fractions with a
  skeleton and baked idle/walk/run/attack animations; vehicles lofted
  longitudinally with an opaque greenhouse and inset glass; race tracks with a
  racing line, checkpoints and corner data; weapons.
- **Materials** — one height field drives albedo, a Sobel-derived tangent-space
  normal map and a packed ORM texture. Car paint gets clearcoat, glass gets
  transmission, lights get emissive strength — via the standard glTF extensions.
- **Container** — a from-scratch glTF 2.0 GLB writer: multi-primitive meshes,
  embedded textures, skins with inverse bind matrices, keyframe animations.

The runtime SDK copied into every generated product covers vehicle dynamics
(raycast suspension, a simplified Pacejka tyre model, friction circle, torque
curve, automatic gearbox, Ackermann steering, anti-roll bars, downforce),
combat (armour and resistance, i-frames, melee arcs, swept-sphere ballistics,
hitscan with falloff and penetration), a virtual gamepad (floating sticks, a
self-centring steering wheel, analogue pedals, haptics, safe-area layout), and
rendering (PMREM image-based lighting, bloom, split-tone grading, SMAA).

## Cost control

Cutting API spend is a first-class concern, not an afterthought:

- **L1** in-process LRU → **L2** SQLite → **L3** semantic similarity, so
  "best market gaps today" and "top market gaps for today" collapse into one
  research run.
- **L4** HTTP conditional caching, **L7** embedding cache.
- Identical concurrent lookups are coalesced into a single computation.
- Each task is routed to a model tier with its own cache policy: cheap
  repetitive work runs fast and caches for hours; invention runs deep and is
  never cached, because reusing an invention produces the same product twice.
- Token and cost budgets are enforced per day, before the call is made.

The cost page shows what was spent and what caching avoided, summed from
recorded calls.

## Learning from failure

Every failure is recorded with a normalised signature, so the same *kind* of
error collapses to one memory whatever the identifiers were this time. When a
fix is verified, it is attached to that memory and injected into future repair
prompts.

The repair policy is explicit and enforced: a repair that deletes a feature,
weakens a test, or replaces a hard problem with a simpler one is rejected. The
directive is included verbatim in every code-generation prompt.

The self-improvement engine measures platform quality, reads the recorded
evidence, and proposes changes to the platform's own source — restricted to an
allow-list of directories and blocked from touching protected patterns.

---

## Getting started

```bash
npm install
cp .env.example .env          # then set at least one LLM provider key
npm run migrate               # create and migrate the database
npm run admin:create          # create an administrator
npm run build
npm start                     # console on http://localhost:3000
```

Run one cycle from the command line instead:

```bash
npm run factory:run -- "Find unmet needs in small-team project tooling"
npm run factory:run -- "…" --stop-after=selection    # research and score only
```

### Verify

```bash
npm run verify     # typecheck + lint + tests
```

159 tests run against real SQLite databases, real spawned processes, real
generated GLB files and a real browser driving the real production build.
Nothing is stubbed.

## Configuration

`.env.example` documents every variable. The minimum to do anything useful is
one LLM provider key and one web search provider key; everything else has a
working default. The **System health** page reports exactly which capabilities
are ready, degraded or unavailable, and what to set to fix each one.

## Documentation

| Document | Covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | Module map, data flow, the orchestrator |
| [SECURITY.md](docs/SECURITY.md) | Sandbox, secrets, the AI trust boundary, deployment requirements |
| [DATABASE.md](docs/DATABASE.md) | Schema and migrations |
| [AI-ARCHITECTURE.md](docs/AI-ARCHITECTURE.md) | Providers, router, budgets, caching, agents |
| [MARKET-INTELLIGENCE.md](docs/MARKET-INTELLIGENCE.md) | Crawling, extraction, scoring, provenance |
| [BUILD-SYSTEM.md](docs/BUILD-SYSTEM.md) | Web and Android pipelines, preview, runtime validation |
| [3D-PIPELINE.md](docs/3D-PIPELINE.md) | Mesh kernel, texture synthesis, glTF, the runtime engine |
| [API.md](docs/API.md) | HTTP endpoints |
| [OPERATIONS.md](docs/OPERATIONS.md) | Running it: scheduling, budgets, backups, troubleshooting |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | Docker, environment, egress policy |

## Licence

UNLICENSED — private.
