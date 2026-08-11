import fs from 'node:fs';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { config } from '@/lib/config/env';
import { createLogger } from '@/lib/observability/logger';

const log = createLogger('qa.browser');

/**
 * Headless browser access.
 *
 * The platform validates every generated product by actually loading its build
 * in Chromium: booting it, capturing console output and unhandled errors,
 * driving input, measuring frame times and taking screenshots. This is what
 * makes "the preview works" a verified statement rather than a claim.
 *
 * The browser binary is discovered from configuration or from the standard
 * install locations. When none is present, runtime validation reports itself as
 * unavailable — it never reports a pass it did not observe.
 */

const CANDIDATE_PATHS = [
  process.env.BROWSER_EXECUTABLE_PATH,
  process.env.CHROME_PATH,
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
];

function fromPlaywrightCache(): string | null {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!root || !fs.existsSync(root)) return null;
  const entries = fs
    .readdirSync(root)
    .filter((name) => name.startsWith('chromium-'))
    .sort()
    .reverse();
  for (const entry of entries) {
    const candidate = path.join(root, entry, 'chrome-linux', 'chrome');
    if (fs.existsSync(candidate)) return candidate;
  }
  const shells = fs
    .readdirSync(root)
    .filter((name) => name.startsWith('chromium_headless_shell-'))
    .sort()
    .reverse();
  for (const entry of shells) {
    const candidate = path.join(root, entry, 'chrome-linux', 'headless_shell');
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function findBrowserExecutable(): string | null {
  const configured = config().BROWSER_EXECUTABLE_PATH;
  if (configured && fs.existsSync(configured)) return configured;
  const cached = fromPlaywrightCache();
  if (cached) return cached;
  for (const candidate of CANDIDATE_PATHS) {
    if (candidate && fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export interface BrowserStatus {
  readonly available: boolean;
  readonly executablePath: string | null;
  readonly detail: string;
}

export function browserStatus(): BrowserStatus {
  const executablePath = findBrowserExecutable();
  return {
    available: Boolean(executablePath),
    executablePath,
    detail: executablePath
      ? `Headless Chromium at ${executablePath}`
      : 'No Chromium/Chrome binary found. Set BROWSER_EXECUTABLE_PATH to enable runtime validation, preview screenshots and the observe-and-fix loop.',
  };
}

export class BrowserUnavailableError extends Error {
  readonly code = 'BROWSER_UNAVAILABLE';
  readonly status = 503;
  constructor(detail: string) {
    super(detail);
    this.name = 'BrowserUnavailableError';
  }
}

function launchArgs(): string[] {
  const args = [
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu-sandbox',
    '--disable-background-timer-throttling',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  if (config().BROWSER_SOFTWARE_GL) {
    // SwiftShader gives a conformant WebGL 2.0 context on GPU-less servers.
    args.push('--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--enable-webgl', '--ignore-gpu-blocklist');
  }
  return args;
}

export interface BrowserSession {
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly page: Page;
  close(): Promise<void>;
}

export interface OpenPageOptions {
  readonly viewport?: { width: number; height: number };
  readonly deviceScaleFactor?: number;
  readonly isMobile?: boolean;
  readonly userAgent?: string;
  /** Disallows every network request outside the preview origin. */
  readonly allowedOrigin?: string;
}

export async function openPage(options: OpenPageOptions = {}): Promise<BrowserSession> {
  const status = browserStatus();
  if (!status.available || !status.executablePath) throw new BrowserUnavailableError(status.detail);

  const browser = await chromium.launch({
    headless: config().BROWSER_HEADLESS,
    executablePath: status.executablePath,
    args: launchArgs(),
    timeout: config().BROWSER_TIMEOUT_MS,
  });

  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 412, height: 892 },
    deviceScaleFactor: options.deviceScaleFactor ?? 2,
    isMobile: options.isMobile ?? true,
    hasTouch: options.isMobile ?? true,
    userAgent: options.userAgent,
    permissions: [],
    serviceWorkers: 'block',
  });

  // Generated code is untrusted: it must not reach anything but its own bundle.
  if (options.allowedOrigin) {
    await context.route('**/*', (route) => {
      const url = route.request().url();
      if (url.startsWith(options.allowedOrigin as string) || url.startsWith('data:') || url.startsWith('blob:')) {
        void route.continue();
        return;
      }
      log.debug('blocked outbound request from generated product', { url: url.slice(0, 160) });
      void route.abort('blockedbyclient');
    });
  }

  const page = await context.newPage();
  page.setDefaultTimeout(config().BROWSER_TIMEOUT_MS);

  return {
    browser,
    context,
    page,
    async close(): Promise<void> {
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    },
  };
}
