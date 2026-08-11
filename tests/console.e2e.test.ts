import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { findBrowserExecutable } from '@/lib/qa/browser';

/**
 * End-to-end verification of the operator console.
 *
 * This boots the real production build, serves it, and drives it with a real
 * browser: every page is loaded as a signed-in operator and checked for content
 * and for console errors. It is the difference between "the build compiled" and
 * "the console works" — a page that throws while rendering compiles perfectly.
 *
 * The suite skips itself, loudly, when the production build or a browser is
 * missing, rather than passing vacuously.
 */

const ADMIN_EMAIL = 'e2e-operator@example.test';
const ADMIN_PASSWORD = 'Console-E2E-Passw0rd';

let server: ChildProcess | null = null;
let browser: Browser | null = null;
let session: BrowserContext | null = null;
let baseUrl = '';
let workDir = '';
let skipReason: string | null = null;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { redirect: 'manual' });
      if (response.status > 0) return true;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

beforeAll(async () => {
  if (!fs.existsSync(path.join(process.cwd(), '.next', 'BUILD_ID'))) {
    skipReason = 'no production build present — run `npm run build` first';
    return;
  }
  const executable = findBrowserExecutable();
  if (!executable) {
    skipReason = 'no Chromium executable found';
    return;
  }

  workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adaf-e2e-'));
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'production',
    PORT: String(port),
    DATA_DIR: path.join(workDir, 'var'),
    WORKSPACES_DIR: path.join(workDir, 'workspaces'),
    DATABASE_PATH: path.join(workDir, 'var', 'e2e.db'),
    SESSION_SECRET: 'e'.repeat(96),
    LOG_LEVEL: 'error',
    SCHEDULER_ENABLED: 'false',
    METRICS_ENABLED: 'false',
    EMBEDDING_PROVIDER: 'local',
    BOOTSTRAP_ADMIN_EMAIL: ADMIN_EMAIL,
    BOOTSTRAP_ADMIN_PASSWORD: ADMIN_PASSWORD,
  };

  // The child gets an explicitly built environment; the cast is needed because
  // the Node typings insist ProcessEnv always carries NODE_ENV.
  const child = spawn('npx', ['next', 'start', '-p', String(port)], {
    env: env as NodeJS.ProcessEnv,
    cwd: process.cwd(),
    stdio: 'pipe',
  });
  server = child;
  let serverLog = '';
  child.stdout?.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));
  child.stderr?.on('data', (chunk: Buffer) => (serverLog += chunk.toString()));

  if (!(await waitForServer(baseUrl, 90_000))) {
    skipReason = `the console server did not start within 90s:\n${serverLog.slice(-2000)}`;
    return;
  }

  browser = await chromium.launch({ executablePath: executable, headless: true, args: ['--no-sandbox'] });

  // Sign in exactly once. The login endpoint is rate limited on purpose, and a
  // suite that logs in per test would be testing the limiter rather than the
  // console — and would start failing as soon as it grew past the limit.
  session = await browser.newContext();
  const response = await session.request.post(`${baseUrl}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  if (!response.ok()) {
    skipReason = `login failed with ${response.status()}: ${await response.text()}`;
  }
}, 180_000);

afterAll(async () => {
  await session?.close();
  await browser?.close();
  if (server?.pid) {
    try {
      process.kill(server.pid, 'SIGTERM');
    } catch {
      /* already gone */
    }
  }
  if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
});

interface Visit {
  readonly page: Page;
  readonly errors: readonly string[];
  readonly text: string;
  readonly status: number;
}

/** A fresh tab in the one signed-in session; the caller closes the page. */
async function signedInPage(): Promise<Page> {
  if (!session) throw new Error('no signed-in session');
  return session.newPage();
}

async function visit(page: Page, route: string): Promise<Visit> {
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', (error) => errors.push(error.message));

  const response = await page.goto(`${baseUrl}${route}`, { waitUntil: 'networkidle', timeout: 45_000 });
  const text = await page.locator('body').innerText();
  return { page, errors, text, status: response?.status() ?? 0 };
}

describe.skipIf(!!process.env.SKIP_E2E)('operator console', () => {
  it('has a running server and a browser', () => {
    if (skipReason) {
      // A skipped E2E run must be visible, not silent.
      console.warn(`[console.e2e] skipped: ${skipReason}`);
    }
    expect(skipReason ?? 'ready').toBe('ready');
  });

  it('redirects an anonymous visitor to the sign-in page', async () => {
    if (skipReason || !browser) return;
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`${baseUrl}/`, { waitUntil: 'networkidle' });
    expect(page.url()).toContain('/login');
    await context.close();
  });

  it.each([
    ['/', 'Factory overview'],
    ['/chat', 'Chat'],
    ['/discovery', 'Discovery'],
    ['/projects', 'Products'],
    ['/schedules', 'Automation'],
    ['/costs', 'Cost'],
    ['/health', 'health'],
  ])('renders %s without a client error', async (route, expected) => {
    if (skipReason) return;
    const page = await signedInPage();
    try {
      const result = await visit(page, route);
      expect(result.status).toBeLessThan(400);
      expect(result.text).toContain(expected);
      expect(result.errors).toEqual([]);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('reports honestly that no research has been performed on an empty database', async () => {
    if (skipReason) return;
    const page = await signedInPage();
    try {
      const result = await visit(page, '/discovery');
      // The whole point: an empty factory says it is empty. It must never show
      // invented opportunities or placeholder trends.
      expect(result.text).toContain('No research has been performed yet');
      expect(result.text).toContain('No opportunity has been scored yet');
    } finally {
      await page.close();
    }
  }, 60_000);

  it('reports that no API calls have been recorded rather than showing invented cost', async () => {
    if (skipReason) return;
    const page = await signedInPage();
    try {
      const result = await visit(page, '/costs');
      expect(result.text).toContain('No API calls have been recorded');
      expect(result.text).toContain('$0.00');
    } finally {
      await page.close();
    }
  }, 60_000);

  it('shows the six automation jobs and says the scheduler is disabled', async () => {
    if (skipReason) return;
    const page = await signedInPage();
    try {
      const result = await visit(page, '/schedules');
      expect(result.text).toContain('The scheduler is disabled');
      for (const job of [
        'daily_market_scan',
        'gap_analysis',
        'opportunity_selection',
        'product_generation',
        'self_improvement',
        'maintenance',
      ]) {
        expect(result.text).toContain(job);
      }
    } finally {
      await page.close();
    }
  }, 60_000);

  it('refuses a chat turn when no language model is configured, instead of fabricating a reply', async () => {
    if (skipReason) return;
    const page = await signedInPage();
    try {
      const created = await page.request.post(`${baseUrl}/api/chat/threads`, {
        data: {},
        headers: { 'x-csrf-token': await csrf(page) },
      });
      expect(created.ok()).toBe(true);
      const { thread } = (await created.json()) as { thread: { id: string } };

      const turn = await page.request.post(`${baseUrl}/api/chat/threads/${thread.id}`, {
        data: { content: 'What opportunities have you found?' },
        headers: { 'x-csrf-token': await csrf(page) },
      });
      // No provider key is set in this environment, so the honest outcome is a
      // 503 naming the missing configuration — never a plausible answer.
      expect(turn.status()).toBe(503);
      const body = (await turn.json()) as { error: string };
      expect(body.error).toMatch(/not configured/i);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('rejects a mutating request that does not carry the CSRF token', async () => {
    if (skipReason) return;
    const page = await signedInPage();
    try {
      const response = await page.request.post(`${baseUrl}/api/chat/threads`, { data: {} });
      expect(response.status()).toBeGreaterThanOrEqual(400);
    } finally {
      await page.close();
    }
  }, 60_000);

  it('serves the PWA manifest and service worker', async () => {
    if (skipReason) return;
    const page = await signedInPage();
    try {
      const manifest = await page.request.get(`${baseUrl}/manifest.webmanifest`);
      expect(manifest.ok()).toBe(true);
      const parsed = (await manifest.json()) as { name?: string; icons?: unknown[] };
      expect(parsed.name).toBeTruthy();
      expect((parsed.icons ?? []).length).toBeGreaterThan(0);

      const worker = await page.request.get(`${baseUrl}/sw.js`);
      expect(worker.ok()).toBe(true);
    } finally {
      await page.close();
    }
  }, 60_000);
});

async function csrf(page: Page): Promise<string> {
  const cookies = await page.context().cookies(baseUrl);
  return cookies.find((c) => c.name === 'adaf_csrf')?.value ?? '';
}
