# HTTP API

All routes run on the Node runtime and are dynamic. Every route except
`/api/auth/login` requires a session cookie; every mutating route additionally
requires the `x-csrf-token` header, whose value is the readable `adaf_csrf`
cookie issued at login.

Errors are `{ "error": "…" }` with a meaningful status. A missing provider is
`503`, not `500`: it is a configuration problem, and the response says which key
to set.

---

## Authentication

### `POST /api/auth/login`
```json
{ "email": "operator@example.com", "password": "…" }
```
Sets `adaf_session` (HttpOnly) and `adaf_csrf` (readable). Returns `{ user }`.
Rate limited more strictly than other routes.

### `POST /api/auth/logout`
Revokes the session and clears both cookies. Requires CSRF.

---

## Status

### `GET /api/status`
Permission: `system:read`

Capability report, provider status, budget state and platform health. This is
the endpoint that tells the truth about what is configured — it never claims a
service works because a key is merely present.

---

## Runs

### `GET /api/runs`
Permission: `system:read` — the 30 most recent runs.

### `POST /api/runs`
Permission: `factory:run` · CSRF

```json
{
  "objective": "Find unmet needs in small-team project tooling",
  "constraints": ["no crypto"],
  "includeGames": true,
  "stopAfter": "selection",
  "maxDocuments": 60
}
```

Returns `202` immediately and runs detached; progress arrives on `/api/events`.
If a required capability is unavailable the response is `503` listing each
blocker and its remedy — the run is not started and no budget is spent.

---

## Events

### `GET /api/events`
Permission: `system:read`

Server-Sent Events. Optional `?since=<id>` replays from the buffer, so a client
connecting mid-run sees recent history rather than an empty panel. Filterable by
`runId` and `projectId`.

---

## Chat

### `GET /api/chat/threads` · `POST /api/chat/threads`
Permission: `chat:use` · CSRF on POST

List or create a conversation. Threads are per user.

### `GET /api/chat/threads/{id}`
The thread and its messages, each with the tool calls that produced it.

### `POST /api/chat/threads/{id}`
Permission: `chat:use` · CSRF

```json
{ "content": "What opportunities have you found?" }
```

Runs one turn: the instruction, the agent's tool calls, and the reply. The
request is held open for the whole turn, which can be minutes if the agent
starts a run. Returns `{ userMessage, assistantMessage }`.

With no language model configured this returns **`503`** naming the missing
configuration. It never returns a fabricated reply.

### `DELETE /api/chat/threads/{id}`
Permission: `chat:use` · CSRF

---

## Projects

### `GET /api/projects/{id}/files?path=<path>`
Permission: `ide:read`

One source file. The path is resolved by the workspace layer, which refuses
anything escaping the project root.

### `PUT /api/projects/{id}/files`
Permission: `ide:write` · CSRF

```json
{ "path": "src/main.ts", "content": "…", "summary": "optional" }
```

Writes the file and **commits a version**, exactly as an agent edit does.
Returns the new version number and a unified diff. An unchanged write is
reported as `{ "saved": false }` rather than creating an empty version.

### `GET /api/projects/{id}/versions`
Permission: `ide:read` — version history with diff statistics.

### `POST /api/projects/{id}/versions`
Permission: `ide:write` · CSRF

```json
{ "action": "diff", "version": 4, "path": "src/main.ts" }
{ "action": "rollback", "version": 4 }
```

A rollback is committed as a new version rather than rewriting history.

### `GET /api/projects/{id}/preview/{...path}`
Permission: `preview:read`

Serves the project's real build output with correct MIME types and byte-range
support. If there is no build output there is no preview.

---

## Artifacts

### `GET /api/artifacts/{id}`
Permission: `build:read`

Downloads an artifact by id — never by a client-supplied path. Serves with the
recorded content type and hash.

---

## Schedules

### `GET /api/schedules`
Permission: `schedule:read`

Scheduler state and every schedule, each with a plain-language description of
its cron expression.

### `POST /api/schedules`
Permission: `schedule:write` · CSRF

```json
{ "action": "enable",  "name": "product generation", "enabled": false }
{ "action": "retime",  "name": "gap analysis", "cron": "0 9 * * 1-5" }
{ "action": "trigger", "name": "maintenance" }
```

`retime` validates the expression and recomputes the next occurrence; an
unparseable expression is rejected rather than stored as a schedule that never
fires. `trigger` additionally requires `factory:run` and returns `202`.

---

## Permissions

| Role | Permissions |
|---|---|
| `viewer` | read-only across research, discovery, projects, builds, previews, schedules, system |
| `operator` | viewer, plus `factory:run`, `project:*`, `ide:*`, `build:run`, `preview:control`, `schedule:write`, `chat:use` |
| `admin` | everything, plus `system:admin` and `user:manage` |
