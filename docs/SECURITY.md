# Security

## The threat this platform actually has

Most applications worry about what a user might send them. This one runs code
that a language model wrote, against inputs fetched from arbitrary websites, and
it does so unattended on a schedule. The interesting boundary is not the browser
— it is the boundary between the platform and the artefacts it produces.

Three rules follow, and everything below implements them:

1. **AI output is data until something outside the model decides otherwise.**
2. **Generated code never runs in the platform process.**
3. **Fetched content is hostile.**

---

## 1. AI output is data

The model never supplies executable behaviour.

- **Chat tools.** The chat agent selects from a fixed registry
  (`src/lib/chat/tools.ts`). Each tool has a Zod schema; input that does not
  validate is reported back to the model as an error rather than executed on a
  best-effort reading. The model cannot name a tool that does not exist, pass a
  path that escapes a workspace, or supply a query that reaches a database.
- **Scheduled jobs.** A `schedules` row names a job; the job is looked up in a
  handler map. A row can never carry code, and a row naming an unknown job is
  deleted rather than guessed at.
- **JSON contracts.** Structured model output is parsed against a Zod schema
  with bounded repair rounds. A response that will not conform fails the step;
  it is never coerced into something the code will accept.
- **Self-improvement.** Proposed edits to the platform's own source are
  restricted to an allow-list of directories (`IMPROVABLE_ROOTS`) and refused if
  they touch protected patterns. Outside fully autonomous mode they are recorded
  as proposals and applied only on an explicit decision.

## 2. Generated code never runs in-process

There is no `eval`, no `new Function`, no dynamic `import()` of generated files
anywhere in the platform. Generated code is executed only as a child process
through `runSandboxed` (`src/lib/workspace/sandbox.ts`), which:

- accepts only an **allow-listed executable** (`node`, `npm`, `npx`, `java`,
  `gradle`, `keytool`, `apksigner`, `zipalign`, `sh`) — anything else throws;
- passes arguments as **argv, never through a shell**, and rejects any argument
  containing a NUL byte, so no metacharacter can reach a shell;
- **confines the working directory** to the project workspace, resolving symlinks
  first so a link cannot be used to escape;
- **scrubs the environment** — the child inherits nothing from the platform.
  It receives `PATH`, a private `HOME` and `TMPDIR`, locale, `CI`, and the
  toolchain paths. No platform secret is reachable. A caller trying to pass a
  variable whose name looks like a secret (`key`, `secret`, `token`, `password`,
  `credential`) is refused;
- **bounds resources** with `ulimit`: address space, file size, process count,
  no core dumps, plus a wall-clock timeout that kills the whole process group;
- **bounds output** so a runaway log cannot exhaust memory or disk;
- **blackholes proxy-aware clients** and forces package managers offline unless
  network is explicitly allowed.

Every one of these is covered by a test that spawns a real process.

> **Deployment requirement.** Process-level network blackholing is defence in
> depth, not isolation. A process can still open a raw socket. Run the platform
> in a container whose egress policy denies the build user, or on a host with an
> equivalent firewall rule. The platform cannot enforce this from inside itself
> and does not pretend to.

## 3. Fetched content is hostile

- **robots.txt** is fetched, parsed per RFC 9309 and honoured, including
  crawl-delay. A disallowed URL is not fetched.
- **SSRF guard.** Hostnames are resolved and the *resolved addresses* are checked
  against private, loopback, link-local and unique-local ranges before the
  connection is made — checking the hostname alone is defeated by DNS. Redirects
  are re-checked at each hop. `RESEARCH_ALLOW_PRIVATE_HOSTS` exists for local
  fixtures and must stay off in production.
- **Bounded responses.** Size caps, timeouts and content-type checks apply before
  a body is read into memory.
- **Extraction, not execution.** HTML is parsed with cheerio and reduced to text.
  Nothing fetched is rendered as markup in the console.
- **Verbatim verification.** A signal's supporting quote is checked against the
  fetched document before the signal is stored. A model that paraphrases a quote
  into something the page does not contain produces no signal.

---

## Authentication and authorisation

- Passwords are hashed with **scrypt** and a per-user salt; verification is
  constant-time. A password policy is enforced at creation.
- **Sessions** are opaque random tokens; only a SHA-256 hash is stored. The
  cookie is `HttpOnly`, `SameSite=Lax`, `Secure` in production, with an absolute
  expiry. Expired sessions are purged at boot and by the maintenance job.
- **CSRF.** A separate readable token is issued at login and required in the
  `x-csrf-token` header on every mutating request. This is asserted by an
  end-to-end test.
- **RBAC.** Three roles (`admin`, `operator`, `viewer`) map to a fixed permission
  set. Routes require a named permission; chat tools that spend money require
  `factory:run` and are refused — never silently downgraded — without it.
- **Rate limits** apply per user per route, with a stricter limit on login.
- **Audit.** Authentication, run starts, schedule changes, IDE writes and
  rollbacks are written to `audit_logs` with actor, action and metadata.

## Secrets

- Secrets live only in the environment and are read once through the validated
  schema in `src/lib/config/env.ts`.
- **No secret is ever sent to the browser.** The console receives provider
  *status* — configured or not, and what to set — never a key. `.env` and
  keystores are git-ignored; no private key is in the repository.
- `SESSION_SECRET` is required in production and the process refuses to start
  without it. Outside production a machine-local secret is generated once so
  developer sessions survive restarts.
- Logs redact secret-shaped values.

## The workspace boundary

`WorkspaceFs` resolves every path against the project root and refuses anything
that escapes it, before any filesystem call. Per-file and total quotas apply,
with a higher limit for binary assets than for source. The preview server serves
only from a project's `preview/` directory.

## Artifacts

APKs are signed with `apksigner` and the signature is **verified** afterwards. If
the Android SDK is absent the pipeline reports `TOOLCHAIN_MISSING` and produces
nothing — it never writes a file with an `.apk` extension that is not a signed
APK. Artifact downloads are permission-checked and served by id, not by path.

## Deployment checklist

- [ ] `SESSION_SECRET` set to 48+ random bytes
- [ ] `NODE_ENV=production`, TLS terminated in front of the app
- [ ] Container egress policy denies the build user
- [ ] `RESEARCH_ALLOW_PRIVATE_HOSTS=false`
- [ ] `SANDBOX_ALLOW_NETWORK=false`
- [ ] Data directory on a volume with backups
- [ ] Provider keys scoped to the minimum needed, with their own spend caps
- [ ] Daily token and cost budgets set to real limits

## Reporting

This is a private repository. Report security problems to the maintainer
directly rather than opening an issue.
