# syntax=docker/dockerfile:1

# ---------------------------------------------------------------- deps stage --
# Dependencies are installed in their own stage so a source-only change does not
# reinstall them. better-sqlite3 compiles a native addon, which needs a
# toolchain here but not in the final image.
FROM node:22-bookworm-slim AS deps
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
      python3 make g++ ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json* ./
RUN npm ci --include=dev

# --------------------------------------------------------------- build stage --
FROM deps AS build
WORKDIR /app
COPY . .

# The build must not need real secrets. A placeholder session secret satisfies
# the production environment check during page-data collection; the running
# container supplies the real one.
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    SESSION_SECRET=build-time-placeholder-not-used-at-runtime-0000000000000000

RUN npm run build

# --------------------------------------------------------------- prune stage --
FROM deps AS prod-deps
WORKDIR /app
RUN npm prune --omit=dev

# --------------------------------------------------------------------- final --
FROM node:22-bookworm-slim AS runner
WORKDIR /app

# Chromium is required for runtime validation: the platform boots every product
# it builds and observes it. Without a browser that step cannot run, and the
# platform would have to report it as unavailable rather than skip it silently.
# A JDK is included so the Android pipeline has Java; the Android SDK itself is
# mounted or installed at deploy time because of its licence.
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium \
      openjdk-17-jdk-headless \
      ca-certificates fonts-liberation tini \
    && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    DATA_DIR=/data/var \
    WORKSPACES_DIR=/data/workspaces \
    BROWSER_EXECUTABLE_PATH=/usr/bin/chromium \
    BROWSER_SOFTWARE_GL=true \
    JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/next.config.mjs ./next.config.mjs
COPY --from=build /app/src ./src
COPY --from=build /app/scripts ./scripts

# The platform writes to its data directory and to project workspaces, and
# nothing else. It runs unprivileged; generated code runs as a child of this
# user, which is why the container's egress policy is the real network boundary.
RUN useradd --system --uid 10001 --home /app factory \
    && mkdir -p /data/var /data/workspaces \
    && chown -R factory:factory /app /data
USER factory

VOLUME ["/data"]
EXPOSE 3000

# tini reaps the sandbox's child processes; without an init, a killed Gradle or
# Chromium leaves zombies that eventually exhaust the process limit.
ENTRYPOINT ["/usr/bin/tini", "--"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/login').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["npm", "start"]
