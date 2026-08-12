import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * Environment schema.
 *
 * Design rules:
 *  - Nothing that touches an external paid/remote service has a default. If the
 *    operator has not configured it, the capability reports itself as
 *    UNCONFIGURED and the feature refuses to run rather than fabricating output.
 *  - Everything that is purely local (paths, ports, tuning) has a sane default so
 *    the platform boots with zero configuration and is honest about what it can
 *    and cannot do.
 */

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(v)));

const int = (def: number, min?: number, max?: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseInt(v, 10)))
    .refine((v) => Number.isFinite(v), { message: 'must be an integer' })
    .refine((v) => (min === undefined ? true : v >= min), { message: `must be >= ${min}` })
    .refine((v) => (max === undefined ? true : v <= max), { message: `must be <= ${max}` });

const num = (def: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : Number.parseFloat(v)))
    .refine((v) => Number.isFinite(v), { message: 'must be a number' });

const csv = (def: string[]) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v === undefined || v.trim() === ''
        ? def
        : v
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean),
    );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_URL: z.string().url().default('http://localhost:3000'),
  PORT: int(3000, 1, 65535),

  // --- Security -----------------------------------------------------------
  // In production a real secret is mandatory. In development a machine-local
  // secret is derived and persisted (see resolveSessionSecret) so that sessions
  // survive restarts without the operator having to configure anything.
  SESSION_SECRET: z.string().min(32).optional(),
  SESSION_TTL_HOURS: int(12, 1, 24 * 30),
  BOOTSTRAP_ADMIN_EMAIL: z.string().email().optional(),
  BOOTSTRAP_ADMIN_PASSWORD: z.string().min(12).optional(),

  // --- Storage ------------------------------------------------------------
  DATA_DIR: z.string().default('./var'),
  WORKSPACES_DIR: z.string().default('./workspaces'),
  DATABASE_PATH: z.string().default(''),
  STORAGE_PROVIDER: z.enum(['filesystem']).default('filesystem'),

  // --- LLM providers ------------------------------------------------------
  LLM_PROVIDER: z.enum(['anthropic', 'openai', 'openrouter']).default('anthropic'),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  ANTHROPIC_BASE_URL: z.string().url().default('https://api.anthropic.com'),
  ANTHROPIC_MODEL_FAST: z.string().default('claude-haiku-4-5-20251001'),
  ANTHROPIC_MODEL_BALANCED: z.string().default('claude-sonnet-5'),
  ANTHROPIC_MODEL_DEEP: z.string().default('claude-opus-5'),

  OPENAI_API_KEY: z.string().min(1).optional(),
  OPENAI_BASE_URL: z.string().url().default('https://api.openai.com/v1'),
  OPENAI_MODEL_FAST: z.string().default('gpt-4o-mini'),
  OPENAI_MODEL_BALANCED: z.string().default('gpt-4o'),
  OPENAI_MODEL_DEEP: z.string().default('gpt-4o'),

  OPENROUTER_API_KEY: z.string().min(1).optional(),
  OPENROUTER_BASE_URL: z.string().url().default('https://openrouter.ai/api/v1'),
  OPENROUTER_MODEL_FAST: z.string().default('anthropic/claude-haiku-4.5'),
  OPENROUTER_MODEL_BALANCED: z.string().default('anthropic/claude-sonnet-4.5'),
  OPENROUTER_MODEL_DEEP: z.string().default('anthropic/claude-opus-4.1'),

  LLM_MAX_ATTEMPTS: int(3, 1, 8),
  LLM_TIMEOUT_MS: int(120_000, 5_000, 900_000),
  LLM_DAILY_TOKEN_BUDGET: int(4_000_000, 0),
  LLM_DAILY_COST_BUDGET_USD: num(25),

  // --- Embeddings ---------------------------------------------------------
  // `local` is a deterministic, dependency-free hashed n-gram embedding computed
  // in-process. It is a real embedding (not a stub): it powers semantic cache and
  // clustering without an external call. Remote providers give better recall.
  EMBEDDING_PROVIDER: z.enum(['local', 'openai']).default('local'),
  EMBEDDING_MODEL: z.string().default('text-embedding-3-small'),
  EMBEDDING_DIMENSIONS: int(512, 64, 4096),

  // --- Web search ---------------------------------------------------------
  SEARCH_PROVIDER: z.enum(['brave', 'tavily', 'serper', 'searxng']).default('brave'),
  BRAVE_SEARCH_API_KEY: z.string().min(1).optional(),
  TAVILY_API_KEY: z.string().min(1).optional(),
  SERPER_API_KEY: z.string().min(1).optional(),
  SEARXNG_BASE_URL: z.string().url().optional(),

  // --- Image / asset generation -------------------------------------------
  // `procedural` runs a real in-process raster generator (deterministic PNG
  // synthesis driven by the concept's brand parameters). Remote providers
  // produce higher-fidelity artwork when configured.
  IMAGE_PROVIDER: z.enum(['procedural', 'openai', 'stability']).default('procedural'),
  OPENAI_IMAGE_MODEL: z.string().default('gpt-image-1'),
  STABILITY_API_KEY: z.string().min(1).optional(),
  STABILITY_BASE_URL: z.string().url().default('https://api.stability.ai'),
  STABILITY_MODEL: z.string().default('sd3.5-medium'),

  // --- Generative 3D models -------------------------------------------------
  // When configured, hero assets (characters, vehicles, weapons, creatures) are
  // synthesised by a text-to-3D service and imported as GLB. When absent the
  // platform falls back to its own subdivision-surface generators, which are
  // real geometry, not a placeholder.
  // The platform's own authored-recipe pipeline: the model writes a brief and a
  // construction recipe, the interpreter builds it, and a vision critic checks
  // the render against the brief's acceptance criteria before it is accepted.
  // It is tried before any external text-to-3D service, because a recipe is
  // reusable, recolourable, auditable and free on the second request. Disable it
  // only to isolate a fault; the fallbacks below still produce real geometry.
  RECIPE_PIPELINE: bool(true),
  RECIPE_REVIEW_ROUNDS: int(2, 0, 5),
  RECIPE_PASS_MARK: int(82, 0, 100),

  MODEL3D_PROVIDER: z.enum(['none', 'meshy', 'tripo']).default('none'),
  MODEL3D_TIMEOUT_MS: int(900_000, 60_000, 3_600_000),
  MODEL3D_TRIANGLE_BUDGET: int(40_000, 1_000, 500_000),
  MESHY_API_KEY: z.string().min(1).optional(),
  MESHY_BASE_URL: z.string().url().default('https://api.meshy.ai'),
  MESHY_MODEL: z.string().default('meshy-5'),
  TRIPO_API_KEY: z.string().min(1).optional(),
  TRIPO_BASE_URL: z.string().url().default('https://api.tripo3d.ai'),
  TRIPO_MODEL: z.string().default('v2.5-20250123'),

  // --- Research / crawling -------------------------------------------------
  RESEARCH_USER_AGENT: z
    .string()
    .default('AutonomousDailyAppFactory/1.0 (+https://github.com/marcone1983/365factory)'),
  RESEARCH_MAX_CONCURRENCY: int(4, 1, 32),
  RESEARCH_PER_HOST_DELAY_MS: int(1500, 0, 60_000),
  RESEARCH_FETCH_TIMEOUT_MS: int(20_000, 1000, 120_000),
  RESEARCH_MAX_BYTES: int(2_500_000, 10_000),
  RESEARCH_RESPECT_ROBOTS: bool(true),
  RESEARCH_MAX_DOCS_PER_RUN: int(60, 1, 1000),
  RESEARCH_MAX_QUERY_ROUNDS: int(3, 1, 10),
  RESEARCH_ALLOWED_SCHEMES: csv(['https:', 'http:']),
  RESEARCH_HOST_DENYLIST: csv([]),
  /**
   * Allows the fetcher to reach loopback/private addresses. Off by default
   * because it removes the SSRF guard's strongest check; turn it on only for a
   * self-hosted SearXNG or an intranet knowledge source on a trusted network.
   */
  RESEARCH_ALLOW_PRIVATE_HOSTS: bool(false),

  // --- Cache ---------------------------------------------------------------
  CACHE_L1_MAX_ENTRIES: int(2000, 16),
  CACHE_DEFAULT_TTL_S: int(60 * 60 * 6, 1),
  CACHE_SEARCH_TTL_S: int(60 * 60 * 12, 1),
  CACHE_DOCUMENT_TTL_S: int(60 * 60 * 24 * 7, 1),
  CACHE_LLM_TTL_S: int(60 * 60 * 24 * 14, 1),
  CACHE_EMBEDDING_TTL_S: int(60 * 60 * 24 * 90, 1),
  CACHE_SEMANTIC_THRESHOLD: num(0.94),
  CACHE_SEMANTIC_ENABLED: bool(true),

  // --- Build ---------------------------------------------------------------
  BUILD_PROVIDER: z.enum(['local']).default('local'),
  ANDROID_SDK_ROOT: z.string().optional(),
  ANDROID_HOME: z.string().optional(),
  JAVA_HOME: z.string().optional(),
  GRADLE_BIN: z.string().optional(),
  ANDROID_COMPILE_SDK: int(35, 21, 40),
  ANDROID_MIN_SDK: int(24, 21, 40),
  ANDROID_TARGET_SDK: int(35, 21, 40),
  ANDROID_BUILD_TOOLS: z.string().default('35.0.0'),
  ANDROID_GRADLE_PLUGIN_VERSION: z.string().default('8.7.3'),
  ANDROID_KEYSTORE_PATH: z.string().optional(),
  ANDROID_KEYSTORE_PASSWORD: z.string().optional(),
  ANDROID_KEY_ALIAS: z.string().optional(),
  ANDROID_KEY_PASSWORD: z.string().optional(),
  BUILD_TIMEOUT_MS: int(900_000, 30_000, 3_600_000),
  BUILD_MAX_OUTPUT_BYTES: int(4_000_000, 10_000),

  // --- Sandbox -------------------------------------------------------------
  SANDBOX_MAX_PROCESS_MB: int(3072, 256),
  SANDBOX_MAX_FILE_MB: int(512, 1),
  SANDBOX_MAX_PROCESSES: int(512, 16),
  SANDBOX_DEFAULT_TIMEOUT_MS: int(300_000, 1000, 3_600_000),
  SANDBOX_ALLOW_NETWORK: bool(false),

  // --- Preview -------------------------------------------------------------
  PREVIEW_PORT: int(3110, 1, 65535),
  PREVIEW_HOST: z.string().default('127.0.0.1'),
  PREVIEW_PUBLIC_URL: z.string().url().optional(),

  // --- Headless runtime validation ------------------------------------------
  /** Chromium/Chrome binary used to boot generated products and observe them. */
  BROWSER_EXECUTABLE_PATH: z.string().optional(),
  BROWSER_HEADLESS: bool(true),
  BROWSER_TIMEOUT_MS: int(60_000, 5_000, 600_000),
  /** Software GL is required on servers without a GPU; disable on GPU hosts. */
  BROWSER_SOFTWARE_GL: bool(true),

  // --- Scheduler -----------------------------------------------------------
  SCHEDULER_ENABLED: bool(false),
  SCHEDULER_TIMEZONE_OFFSET_MINUTES: int(0, -840, 840),
  DAILY_MARKET_SCAN_CRON: z.string().default('0 6 * * *'),
  DAILY_GAP_ANALYSIS_CRON: z.string().default('0 7 * * *'),
  DAILY_SELECTION_CRON: z.string().default('0 8 * * *'),
  DAILY_GENERATION_CRON: z.string().default('30 8 * * *'),
  AUTONOMY_MODE: z.enum(['manual', 'semi', 'auto']).default('semi'),

  // --- Observability -------------------------------------------------------
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  LOG_PRETTY: bool(false),
  METRICS_ENABLED: bool(true),

  // --- Rate limiting -------------------------------------------------------
  RATE_LIMIT_WINDOW_S: int(60, 1),
  RATE_LIMIT_MAX_REQUESTS: int(240, 1),
  RATE_LIMIT_LOGIN_MAX: int(10, 1),
});

export type RawEnv = z.infer<typeof EnvSchema>;

export interface AppConfig extends RawEnv {
  readonly dataDir: string;
  readonly workspacesDir: string;
  readonly databasePath: string;
  readonly sessionSecret: string;
  readonly isProduction: boolean;
}

let cached: AppConfig | null = null;

function abs(p: string): string {
  return path.isAbsolute(p) ? p : path.resolve(process.cwd(), p);
}

/**
 * Resolves the session secret. Production requires SESSION_SECRET. Outside
 * production a persistent machine-local secret is generated once and stored in
 * DATA_DIR so that developer sessions survive process restarts.
 */
function resolveSessionSecret(parsed: RawEnv, dataDir: string): string {
  if (parsed.SESSION_SECRET) return parsed.SESSION_SECRET;
  if (parsed.NODE_ENV === 'production') {
    throw new Error(
      'SESSION_SECRET is required in production. Generate one with: openssl rand -hex 48',
    );
  }
  const file = path.join(dataDir, 'session-secret');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  } catch {
    /* generated below */
  }
  const secret = crypto.randomBytes(48).toString('hex');
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(file, secret, { mode: 0o600 });
  return secret;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`Invalid environment configuration:\n${issues}`);
  }
  const parsed = result.data;
  const dataDir = abs(parsed.DATA_DIR);
  const workspacesDir = abs(parsed.WORKSPACES_DIR);
  const databasePath = parsed.DATABASE_PATH
    ? abs(parsed.DATABASE_PATH)
    : path.join(dataDir, 'factory.db');

  return {
    ...parsed,
    dataDir,
    workspacesDir,
    databasePath,
    sessionSecret: resolveSessionSecret(parsed, dataDir),
    isProduction: parsed.NODE_ENV === 'production',
  };
}

export function config(): AppConfig {
  if (!cached) cached = loadConfig();
  return cached;
}

/** Test-only hook: forces the next config() call to re-read process.env. */
export function resetConfigCache(): void {
  cached = null;
}
