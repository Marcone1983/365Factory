import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from './helpers/env';
import { runSandboxed, SandboxViolationError } from '@/lib/workspace/sandbox';

let env: TestEnvironment;
let jail: string;

beforeEach(() => {
  env = createTestEnvironment();
  jail = path.join(env.dir, 'jail');
  fs.mkdirSync(path.join(jail, 'inner'), { recursive: true });
});

afterEach(() => {
  env.cleanup();
});

/**
 * These tests exercise the boundary the platform depends on: AI-authored code is
 * never evaluated in the platform process, and the child process it does get
 * cannot leave the workspace, cannot see platform secrets, and cannot outlive
 * its timeout. Each of these is asserted against a real spawned process.
 */

describe('executable allow-list', () => {
  it('refuses an executable that is not allow-listed', async () => {
    await expect(
      runSandboxed({
        executable: 'curl' as unknown as 'node',
        args: ['https://example.com'],
        cwd: jail,
        jailRoot: jail,
      }),
    ).rejects.toThrow(SandboxViolationError);
  });

  it('refuses arguments containing a NUL byte', async () => {
    await expect(
      runSandboxed({ executable: 'node', args: ['-e', 'x\0y'], cwd: jail, jailRoot: jail }),
    ).rejects.toThrow(/NUL-free/);
  });
});

describe('workspace jail', () => {
  it('refuses a working directory outside the jail', async () => {
    await expect(
      runSandboxed({ executable: 'node', args: ['-e', ''], cwd: env.dir, jailRoot: jail }),
    ).rejects.toThrow(/outside the workspace jail/);
  });

  it('refuses a traversal that resolves outside the jail', async () => {
    await expect(
      runSandboxed({
        executable: 'node',
        args: ['-e', ''],
        cwd: path.join(jail, 'inner', '..', '..'),
        jailRoot: jail,
      }),
    ).rejects.toThrow(SandboxViolationError);
  });

  it('accepts a directory nested inside the jail', async () => {
    const result = await runSandboxed({
      executable: 'node',
      args: ['-e', 'process.stdout.write("inside")'],
      cwd: path.join(jail, 'inner'),
      jailRoot: jail,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('inside');
  });
});

describe('environment scrubbing', () => {
  it('does not leak platform secrets into the child', async () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-must-not-leak';
    process.env.SESSION_SECRET = 'b'.repeat(64);

    const result = await runSandboxed({
      executable: 'node',
      args: ['-e', 'process.stdout.write(JSON.stringify(Object.keys(process.env).sort()))'],
      cwd: jail,
      jailRoot: jail,
    });

    expect(result.exitCode).toBe(0);
    const keys = JSON.parse(result.stdout) as string[];
    expect(keys).not.toContain('ANTHROPIC_API_KEY');
    expect(keys).not.toContain('SESSION_SECRET');
    expect(keys).not.toContain('DATABASE_PATH');
    // The allow-list is what the child does get.
    expect(keys).toContain('PATH');
    expect(keys).toContain('HOME');
  });

  it('refuses to forward a secret-looking variable the caller passes in', async () => {
    await expect(
      runSandboxed({
        executable: 'node',
        args: ['-e', ''],
        cwd: jail,
        jailRoot: jail,
        env: { MY_API_KEY: 'leak' },
      }),
    ).rejects.toThrow(/refusing to pass secret-looking variable/);

    await expect(
      runSandboxed({ executable: 'node', args: ['-e', ''], cwd: jail, jailRoot: jail, env: { DB_PASSWORD: 'x' } }),
    ).rejects.toThrow(SandboxViolationError);
  });

  it('forwards a non-secret variable the caller asks for', async () => {
    const result = await runSandboxed({
      executable: 'node',
      args: ['-e', 'process.stdout.write(process.env.BUILD_TARGET ?? "unset")'],
      cwd: jail,
      jailRoot: jail,
      env: { BUILD_TARGET: 'web' },
    });
    expect(result.stdout).toBe('web');
  });

  it('gives the child a private HOME and TMPDIR, not the platform\'s', async () => {
    const result = await runSandboxed({
      executable: 'node',
      args: ['-e', 'process.stdout.write(process.env.HOME + "|" + process.env.TMPDIR)'],
      cwd: jail,
      jailRoot: jail,
    });
    const [home = '', tmp = ''] = result.stdout.split('|');
    expect(home).toContain('adaf-sbx-');
    expect(tmp).toBe(home);
    expect(home).not.toBe(process.env.HOME);
  });
});

describe('resource bounds', () => {
  it('kills a process that exceeds its timeout', async () => {
    const result = await runSandboxed({
      executable: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: jail,
      jailRoot: jail,
      timeoutMs: 1_500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeLessThan(20_000);
  });

  it('truncates runaway output instead of buffering it without bound', async () => {
    const result = await runSandboxed({
      executable: 'node',
      args: ['-e', 'for (let i = 0; i < 20000; i++) console.log("x".repeat(200))'],
      cwd: jail,
      jailRoot: jail,
      maxOutputBytes: 32_000,
      timeoutMs: 30_000,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.length).toBeLessThan(200_000);
    expect(result.stdout).toContain('[output truncated at 32000 bytes]');
  });

  it('reports a non-zero exit without throwing, so callers can read the diagnostics', async () => {
    const result = await runSandboxed({
      executable: 'node',
      args: ['-e', 'console.error("boom"); process.exit(3)'],
      cwd: jail,
      jailRoot: jail,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stderr).toContain('boom');
  });

  it('can be aborted by its caller', async () => {
    const controller = new AbortController();
    const pending = runSandboxed({
      executable: 'node',
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: jail,
      jailRoot: jail,
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    const result = await pending;
    expect(result.exitCode).not.toBe(0);
    expect(result.durationMs).toBeLessThan(30_000);
  });
});

describe('network isolation', () => {
  it('points proxy-aware clients at a blackhole by default', async () => {
    const result = await runSandboxed({
      executable: 'node',
      args: ['-e', 'process.stdout.write(process.env.HTTPS_PROXY + "|" + process.env.npm_config_offline)'],
      cwd: jail,
      jailRoot: jail,
    });
    // Process-level blackholing is a defence in depth measure, not a substitute
    // for kernel egress policy — SECURITY.md states that requirement plainly.
    expect(result.stdout).toBe('http://127.0.0.1:1|true');
  });
});
