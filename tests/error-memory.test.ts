import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from './helpers/env';
import { errorSignature } from '@/lib/knowledge/error-memory';

let env: TestEnvironment;

beforeEach(() => {
  env = createTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

/**
 * The error memory is what stops the factory relearning the same lesson every
 * day. Its whole value rests on one property: two occurrences of the same
 * *kind* of failure must collapse to one signature, and two genuinely different
 * failures must not.
 */

describe('errorSignature', () => {
  it('collapses positions, paths and identifiers so a recurring error has one signature', () => {
    const a = errorSignature(
      'typescript',
      "src/lib/foo/alpha.ts(42,17): error TS2339: Property 'width' does not exist on type 'Mesh'.",
      'src/lib/foo/alpha.ts',
    );
    const b = errorSignature(
      'typescript',
      "src/lib/bar/beta.ts(918,3): error TS2339: Property 'height' does not exist on type 'Node'.",
      'src/lib/bar/beta.ts',
    );
    expect(a).toBe(b);
  });

  it('collapses hashes and numeric literals', () => {
    const a = errorSignature('bundler', 'chunk 8f3a91be2c0d failed after 1240ms');
    const b = errorSignature('bundler', 'chunk 0011aabbccdd failed after 87ms');
    expect(a).toBe(b);
  });

  it('keeps genuinely different failures apart', () => {
    const missingProperty = errorSignature('typescript', "Property 'x' does not exist on type 'Y'.");
    const missingModule = errorSignature('typescript', "Cannot find module 'three' or its type declarations.");
    expect(missingProperty).not.toBe(missingModule);
  });

  it('separates the same message in different categories and file types', () => {
    expect(errorSignature('bundler', 'unexpected token')).not.toBe(errorSignature('runtime', 'unexpected token'));
    expect(errorSignature('bundler', 'unexpected token', 'a.ts')).not.toBe(
      errorSignature('bundler', 'unexpected token', 'a.glsl'),
    );
  });

  it('is stable across repeated calls', () => {
    const message = 'WebGL: INVALID_OPERATION: useProgram: program not valid';
    expect(errorSignature('runtime', message)).toBe(errorSignature('runtime', message));
  });
});

describe('failure recording and recall', () => {
  it('increments occurrences instead of storing a duplicate', async () => {
    const { recordFailure, listErrorMemories } = await import('@/lib/knowledge/error-memory');

    await recordFailure({
      category: 'typescript',
      phase: 'build',
      message: "src/a.ts(1,1): error TS2339: Property 'a' does not exist on type 'A'.",
      filePath: 'src/a.ts',
    });
    const second = await recordFailure({
      category: 'typescript',
      phase: 'build',
      message: "src/b.ts(9,4): error TS2339: Property 'b' does not exist on type 'B'.",
      filePath: 'src/b.ts',
    });

    expect(second.occurrences).toBe(2);
    expect(listErrorMemories()).toHaveLength(1);
  });

  it('recalls a recorded failure by exact signature with a verified remedy', async () => {
    const { recordFailure, recordFix, recallSimilar } = await import('@/lib/knowledge/error-memory');

    const memory = await recordFailure({
      category: 'runtime',
      phase: 'preview',
      message: 'THREE.WebGLRenderer: Context Lost.',
    });
    recordFix({
      signature: memory.signature,
      summary: 'Recreate the renderer on webglcontextrestored and re-upload GPU resources.',
      diff: '+ canvas.addEventListener("webglcontextrestored", rebuildRenderer);',
      rationale: 'The context can be lost at any time; recreating GPU state is the only correct recovery.',
      verifiedBy: 'runtime',
    });

    const recalled = await recallSimilar({ category: 'runtime', message: 'THREE.WebGLRenderer: Context Lost.' });
    expect(recalled.length).toBeGreaterThan(0);
    const hit = recalled[0];
    expect(hit?.matchedBy).toBe('signature');
    expect(hit?.relevance).toBe(1);
    expect(hit?.fixSummary).toContain('webglcontextrestored');
    expect(hit?.resolved).toBe(true);
    expect(hit?.verifiedBy).toBe('runtime');
  });

  it('renders recalled memories as prompt text that names the fix', async () => {
    const { recordFailure, recordFix, recallSimilar, renderMemoriesForPrompt } = await import(
      '@/lib/knowledge/error-memory'
    );

    const memory = await recordFailure({
      category: 'bundler',
      phase: 'build',
      message: 'Module not found: Can\'t resolve "node:fs" in a browser bundle',
    });
    recordFix({
      signature: memory.signature,
      summary: 'Move the filesystem access behind a server-only module boundary.',
      diff: '+ import "server-only";',
      rationale: 'Browser bundles have no filesystem; the import must not be reachable from client code.',
      verifiedBy: 'build',
    });

    const rendered = renderMemoriesForPrompt(
      await recallSimilar({ category: 'bundler', message: 'Module not found: Can\'t resolve "node:fs" in a browser bundle' }),
    );
    expect(rendered).toContain('server-only module boundary');
  });

  it('reports statistics that distinguish resolved from open failures', async () => {
    const { recordFailure, recordFix, errorMemoryStats } = await import('@/lib/knowledge/error-memory');

    const first = await recordFailure({ category: 'bundler', phase: 'build', message: 'first distinct failure' });
    await recordFailure({ category: 'runtime', phase: 'preview', message: 'second distinct failure' });
    recordFix({
      signature: first.signature,
      summary: 'the remedy',
      diff: '+ the change',
      rationale: 'the reason',
      verifiedBy: 'tests',
    });

    const stats = errorMemoryStats();
    expect(stats.total).toBe(2);
    expect(stats.resolved).toBe(1);
  });
});
