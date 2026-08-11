import { z } from 'zod';
import { Agent, AgentError, type AgentContext } from './base';
import { completeJson } from '@/lib/ai/router';
import { db, newId, nowIso, toJson } from '@/lib/db/client';
import { buildWeb } from '@/lib/build/web';
import { buildAndroidApk } from '@/lib/build/android';
import { androidToolchain } from '@/lib/build/toolchain';
import { startPreview } from '@/lib/preview/server';
import { validateRuntime, type RuntimeValidationResult } from '@/lib/qa/runtime';
import { recordFailure } from '@/lib/knowledge/error-memory';
import { workspaceFor, updateProject, type Project } from '@/lib/workspace/project';
import { measureQuality, proposeImprovements, gatherObservations, type ImprovementProposal } from '@/lib/improvement/engine';
import { attachEmbedding, embedTexts } from '@/lib/knowledge/embeddings';
import { getEmbeddingProvider } from '@/lib/providers/registry';
import type { BuildArtifact, BuildRecord } from '@/lib/build/store';

/**
 * Delivery agents: quality assurance, packaging, security review and learning.
 *
 * These are the steps that decide whether a generated product is allowed to be
 * called READY. Nothing here reports success it did not observe: a runtime check
 * that could not run reports "unavailable", and an APK that could not be built
 * reports why rather than producing a file.
 */

// -------------------------------------------------------------------- QA ----

export interface QaInput {
  readonly project: Project;
  readonly kind: 'app' | 'game' | 'hybrid';
  readonly buildId?: string;
}

export interface QaOutput {
  readonly runtime: RuntimeValidationResult;
  readonly previewUrl: string;
  readonly passed: boolean;
}

export class QaAgent extends Agent<QaInput, QaOutput> {
  readonly name = 'qa';
  readonly description = 'Boots the product in a real browser and validates its runtime behaviour';

  constructor() {
    super({ maxAttempts: 2, timeoutMs: 600_000 });
  }

  protected async execute(input: QaInput, context: AgentContext): Promise<QaOutput> {
    const preview = await startPreview(input.project, input.buildId);
    context.progress(`preview running at ${preview.url}`);

    const runtime = await validateRuntime(input.project, {
      url: preview.url,
      kind: input.kind,
      buildId: input.buildId,
      signal: context.signal,
    });

    if (runtime.status === 'unavailable') {
      context.progress('runtime validation unavailable: no browser binary is configured');
      return { runtime, previewUrl: preview.url, passed: false };
    }

    for (const check of runtime.checks) {
      if (check.status !== 'failed') continue;
      await recordFailure({
        category: 'runtime',
        phase: 'preview',
        message: `${check.name}: ${check.detail}`,
        detail: JSON.stringify(runtime.report?.errors?.slice(0, 4) ?? []),
        projectId: input.project.id,
      });
    }

    context.progress(runtime.summary, { status: runtime.status });
    return { runtime, previewUrl: preview.url, passed: runtime.status === 'passed' };
  }
}

// ----------------------------------------------------------------- build ----

export interface BuildInput {
  readonly project: Project;
  readonly android: boolean;
}

export interface BuildOutput {
  readonly web: BuildRecord;
  readonly android: BuildRecord | null;
  readonly apk: BuildArtifact | null;
  readonly toolchainMissing: readonly string[];
}

export class BuildAgent extends Agent<BuildInput, BuildOutput> {
  readonly name = 'build';
  readonly description = 'Produces the web bundle and, when the toolchain allows, a signed APK';

  constructor() {
    super({ maxAttempts: 1, timeoutMs: 1_800_000 });
  }

  protected async execute(input: BuildInput, context: AgentContext): Promise<BuildOutput> {
    context.progress('building the web bundle');
    const web = await buildWeb(input.project, { injectHarness: true });
    if (!web.succeeded) {
      throw new AgentError(`Web build failed: ${web.build.errorSummary}`, false, 'WEB_BUILD_FAILED');
    }

    if (!input.android) {
      return { web: web.build, android: null, apk: null, toolchainMissing: [] };
    }

    const toolchain = androidToolchain(true);
    if (!toolchain.ready) {
      // Reported, not hidden: the operator needs to know exactly what to install.
      context.progress(`APK skipped — Android toolchain incomplete: ${toolchain.missing.join(', ')}`);
      const result = await buildAndroidApk(input.project, { signal: context.signal });
      return { web: web.build, android: result.build, apk: null, toolchainMissing: toolchain.missing };
    }

    context.progress('packaging the Android APK');
    const android = await buildAndroidApk(input.project, { signal: context.signal });
    if (!android.succeeded) {
      await recordFailure({
        category: 'gradle',
        phase: 'package',
        message: android.build.errorSummary,
        projectId: input.project.id,
      });
    }
    return { web: web.build, android: android.build, apk: android.artifact, toolchainMissing: [] };
  }
}

// -------------------------------------------------------------- security ----

const SecuritySchema = z.object({
  findings: z
    .array(
      z.object({
        severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
        file: z.string().max(200),
        issue: z.string().min(15).max(500),
        remediation: z.string().min(15).max(600),
      }),
    )
    .max(20),
  verdict: z.enum(['pass', 'pass_with_warnings', 'fail']),
  summary: z.string().min(20).max(800),
});

export interface SecurityInput {
  readonly project: Project;
  readonly buildId?: string;
}

export interface SecurityOutput {
  readonly verdict: 'pass' | 'pass_with_warnings' | 'fail';
  readonly findings: z.infer<typeof SecuritySchema>['findings'];
  readonly summary: string;
}

/** Static patterns that are defects regardless of what a model thinks. */
const STATIC_RULES: ReadonlyArray<{ pattern: RegExp; severity: 'critical' | 'high' | 'medium'; issue: string; remediation: string }> = [
  { pattern: /\beval\s*\(/, severity: 'critical', issue: 'eval() executes arbitrary strings as code', remediation: 'Replace with an explicit dispatch table or JSON parsing.' },
  { pattern: /new\s+Function\s*\(/, severity: 'critical', issue: 'new Function() compiles arbitrary strings as code', remediation: 'Replace with a statically defined function.' },
  { pattern: /\.innerHTML\s*=\s*[^'"`]/, severity: 'high', issue: 'innerHTML assigned from a non-literal value, allowing HTML injection', remediation: 'Use textContent, or escape the value before insertion.' },
  { pattern: /document\.write\s*\(/, severity: 'high', issue: 'document.write() rewrites the document and blocks parsing', remediation: 'Build DOM nodes and append them instead.' },
  { pattern: /https?:\/\/(?!appassets\.androidplatform\.net)[a-z0-9.-]+\.[a-z]{2,}/i, severity: 'medium', issue: 'the product references a remote origin; generated products must run entirely offline', remediation: 'Bundle the resource, or remove the reference.' },
  { pattern: /(?:api[_-]?key|secret|password|token)\s*[:=]\s*['"][^'"]{8,}/i, severity: 'critical', issue: 'a credential appears to be hard-coded', remediation: 'Remove the credential; generated products must not carry secrets.' },
];

export class SecurityAgent extends Agent<SecurityInput, SecurityOutput> {
  readonly name = 'security';
  readonly description = 'Scans the generated source for security defects before release';

  protected async execute(input: SecurityInput, context: AgentContext): Promise<SecurityOutput> {
    const source = workspaceFor(input.project, 'source');
    const files = source
      .list({ maxFiles: 400 })
      .filter((path) => /\.(ts|tsx|js|html)$/.test(path) && !path.startsWith('src/engine/') && !path.startsWith('src/appkit/'));

    const findings: SecurityOutput['findings'] = [];
    for (const path of files) {
      const contents = source.readText(path);
      for (const rule of STATIC_RULES) {
        if (rule.pattern.test(contents)) {
          findings.push({ severity: rule.severity, file: path, issue: rule.issue, remediation: rule.remediation });
        }
      }
    }
    context.progress(`static scan found ${findings.length} issue(s) across ${files.length} files`);

    // A model review adds judgement about logic flaws the patterns cannot see.
    const excerpt = files
      .slice(0, 8)
      .map((path) => `--- ${path} ---\n${source.readText(path).slice(0, 6000)}`)
      .join('\n\n');

    let verdict: SecurityOutput['verdict'] = findings.some((f) => f.severity === 'critical') ? 'fail' : findings.length > 0 ? 'pass_with_warnings' : 'pass';
    let summary = `${findings.length} issue(s) from static rules.`;

    try {
      const { data } = await completeJson({
        task: 'security_review',
        schema: SecuritySchema,
        signal: context.signal,
        context: { projectId: input.project.id, factoryRunId: context.factoryRunId },
        system:
          'You review generated client-side product code for security defects. The product runs offline inside a WebView with no network access and no secrets. ' +
          'Report only defects you can point at in the supplied code. Do not speculate about code you were not shown.',
        messages: [{ role: 'user', content: `STATIC FINDINGS:\n${JSON.stringify(findings)}\n\nSOURCE:\n${excerpt}\n\nReturn the JSON review.` }],
      });
      findings.push(...data.findings.filter((f) => !findings.some((existing) => existing.file === f.file && existing.issue === f.issue)));
      summary = data.summary;
      if (data.verdict === 'fail' || findings.some((f) => f.severity === 'critical')) verdict = 'fail';
      else if (findings.length > 0) verdict = 'pass_with_warnings';
    } catch (error) {
      context.logger.warn('model security review unavailable; static rules stand alone', { error: (error as Error).message });
    }

    db()
      .prepare('INSERT INTO security_scans (id, project_id, build_id, status, findings, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(newId('sec'), input.project.id, input.buildId ?? null, verdict, toJson(findings), nowIso());

    return { verdict, findings, summary };
  }
}

// -------------------------------------------------------------- learning ----

export interface LearningInput {
  readonly project: Project;
  readonly outcome: 'ready' | 'failed';
  readonly notes: readonly string[];
  readonly runtime?: RuntimeValidationResult;
}

export interface LearningOutput {
  readonly knowledgeItems: number;
  readonly proposals: readonly ImprovementProposal[];
  readonly snapshot: ReturnType<typeof measureQuality>;
}

export class LearningAgent extends Agent<LearningInput, LearningOutput> {
  readonly name = 'learning';
  readonly description = 'Consolidates the run into reusable knowledge and proposes platform improvements';

  constructor() {
    super({ maxAttempts: 1, timeoutMs: 600_000 });
  }

  protected async execute(input: LearningInput, context: AgentContext): Promise<LearningOutput> {
    const lessons: Array<{ key: string; title: string; content: string; tags: string[] }> = [];

    lessons.push({
      key: `product:${input.project.slug}`,
      title: `${input.project.name} (${input.outcome})`,
      content:
        `${input.project.description}\nKind: ${input.project.kind}\nOutcome: ${input.outcome}\n` +
        `${input.notes.join('\n')}` +
        (input.runtime ? `\nRuntime: ${input.runtime.summary}` : ''),
      tags: [input.project.kind, input.outcome],
    });

    if (input.runtime) {
      for (const check of input.runtime.checks.filter((c) => c.status === 'failed')) {
        lessons.push({
          key: `runtime-failure:${check.name}:${input.project.slug}`,
          title: `Runtime check "${check.name}" failed`,
          content: `${check.detail}\nProduct: ${input.project.name} (${input.project.kind})`,
          tags: ['runtime', check.name],
        });
      }
    }

    const database = db();
    const insert = database.prepare(
      `INSERT INTO knowledge_items (id, kind, key, title, content, tags, importance, source_type, source_id, created_at, updated_at)
       VALUES (?, 'product_outcome', ?, ?, ?, ?, ?, 'project', ?, ?, ?)
       ON CONFLICT(kind, key) DO UPDATE SET content = excluded.content, updated_at = excluded.updated_at, hits = knowledge_items.hits + 1`,
    );
    const now = nowIso();
    for (const lesson of lessons) {
      insert.run(
        newId('kno'),
        lesson.key,
        lesson.title,
        lesson.content,
        toJson(lesson.tags),
        input.outcome === 'failed' ? 0.8 : 0.6,
        input.project.id,
        now,
        now,
      );
    }

    // Index the lessons so future runs can recall them semantically.
    try {
      const vectors = await embedTexts(lessons.map((l) => `${l.title}\n${l.content}`), { ownerType: 'knowledge', projectId: input.project.id });
      const model = getEmbeddingProvider().name;
      lessons.forEach((lesson, i) => attachEmbedding('knowledge', lesson.key, lesson.content, vectors[i] as Float32Array, model));
    } catch (error) {
      context.logger.warn('knowledge indexing unavailable', { error: (error as Error).message });
    }
    context.progress(`recorded ${lessons.length} knowledge items`);

    // Close the loop: measure, then propose improvements to the factory itself.
    const snapshot = measureQuality();
    let proposals: readonly ImprovementProposal[] = [];
    try {
      const observations = [...gatherObservations(16), ...input.notes];
      if (observations.length > 0) {
        proposals = await proposeImprovements({
          snapshot,
          observations,
          projectId: input.project.id,
          factoryRunId: context.factoryRunId,
          signal: context.signal,
          maxProposals: 2,
        });
        context.progress(`proposed ${proposals.length} platform improvement(s)`);
      }
    } catch (error) {
      context.logger.warn('improvement proposal step failed', { error: (error as Error).message });
    }

    updateProject(input.project.id, { metadata: { lastLearningAt: nowIso(), qualitySnapshot: snapshot } });
    return { knowledgeItems: lessons.length, proposals, snapshot };
  }
}
