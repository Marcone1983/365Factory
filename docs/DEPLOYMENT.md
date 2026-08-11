# Deployment

## Docker

```bash
docker build -t app-factory .

docker run -d --name app-factory \
  -p 3000:3000 \
  -v factory-data:/data \
  -e SESSION_SECRET="$(openssl rand -hex 48)" \
  -e ANTHROPIC_API_KEY=... \
  -e SEARCH_PROVIDER=brave -e BRAVE_API_KEY=... \
  -e BOOTSTRAP_ADMIN_EMAIL=you@example.com \
  -e BOOTSTRAP_ADMIN_PASSWORD='…' \
  app-factory
```

The image ships Chromium (runtime validation boots every product it builds) and
a JDK. The Android SDK is **not** bundled — its licence requires acceptance —
so mount it and point `ANDROID_SDK_ROOT` at it if you want APKs. Without it the
build reports `TOOLCHAIN_MISSING` and produces no artifact.

`/data` holds both the database and the workspaces. It must be a persistent
volume: without it, every restart loses the platform's accumulated knowledge.

### Compose

```yaml
services:
  factory:
    build: .
    ports: ["127.0.0.1:3000:3000"]
    volumes:
      - factory-data:/data
      - /opt/android-sdk:/opt/android-sdk:ro   # optional
    environment:
      SESSION_SECRET: ${SESSION_SECRET:?set this}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY}
      SEARCH_PROVIDER: brave
      BRAVE_API_KEY: ${BRAVE_API_KEY}
      ANDROID_SDK_ROOT: /opt/android-sdk
      SCHEDULER_ENABLED: "true"
      AUTONOMY_MODE: semi
      LLM_DAILY_COST_BUDGET_USD: "25"
    restart: unless-stopped
volumes:
  factory-data:
```

Bind the published port to loopback and put TLS in front of it.

## The egress requirement

**This is not optional, and the platform cannot enforce it from inside itself.**

The sandbox scrubs the environment, blackholes proxy-aware clients and forces
package managers offline, but a child process can still open a raw socket. The
real boundary is the container's network policy.

Give the container an egress policy that permits only what the platform needs —
the AI providers, the search provider, and the sites the researcher crawls —
and denies everything else. On Kubernetes that is a `NetworkPolicy`; on a single
host, an iptables rule on the container's user or network namespace.

## Reverse proxy

```nginx
server {
    listen 443 ssl http2;
    server_name factory.example.com;

    ssl_certificate     /etc/letsencrypt/live/factory.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/factory.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host              $host;
        proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;

        # A chat turn that starts a factory run legitimately takes minutes, and
        # the event stream must not be buffered or it arrives all at once.
        proxy_read_timeout 900s;
        proxy_buffering    off;
    }
}
```

## Without Docker

```bash
npm ci
npm run build
npm run migrate
npm run admin:create
NODE_ENV=production npm start
```

Requirements: Node 20.11+, a build toolchain for better-sqlite3, Chromium for
runtime validation, and optionally a JDK and the Android SDK.

Run it under a supervisor (systemd, pm2) with an unprivileged user, a writable
`DATA_DIR` and `WORKSPACES_DIR`, and a restart policy.

## Environment

`.env.example` documents everything. The minimum:

| Variable | Why |
|---|---|
| `SESSION_SECRET` | Required in production; the process refuses to start without it |
| `ANTHROPIC_API_KEY` *or* `OPENAI_API_KEY` | Without a model, nothing reasons |
| `SEARCH_PROVIDER` + its key | Without search, nothing is researched |
| `DATA_DIR`, `WORKSPACES_DIR` | Persistent paths |

Strongly recommended in production:

| Variable | Value |
|---|---|
| `SCHEDULER_ENABLED` | `true` — otherwise nothing is autonomous |
| `AUTONOMY_MODE` | `semi` to start |
| `LLM_DAILY_COST_BUDGET_USD` | A real limit |
| `RESEARCH_ALLOW_PRIVATE_HOSTS` | `false` |
| `SANDBOX_ALLOW_NETWORK` | `false` |

## First run

1. Sign in as the bootstrap administrator and change the password.
2. Check **System health** — every capability should be ready, or you should
   know why it is not.
3. Start a short run: objective plus `--stop-after=selection`. Watch the
   activity stream.
4. Check **Discovery** — the gaps should carry quotes and source links.
5. Check **Cost & cache** — confirm the spend is what you expected.
6. Enable the scheduler once you are satisfied.

## Health check

`GET /login` returns 200 when the process is serving. `GET /api/status` needs a
session and reports capability detail — use the former for liveness and the
latter for a human check.

## Scaling

There is nothing to scale horizontally, by design: the work is sequential and
the state is a single SQLite file. Scale **up** — more CPU shortens builds, more
memory helps Chromium and the 3D generators. If you need more products per day,
run separate instances with separate data directories and separate objectives.
