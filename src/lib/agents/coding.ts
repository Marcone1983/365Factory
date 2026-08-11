import { z } from 'zod';
import { Agent, AgentError, type AgentContext } from './base';
import { completeJson } from '@/lib/ai/router';
import { NO_REGRESSION_DIRECTIVE, assessRepair, recordRepairAudit } from './repair-policy';
import { recallSimilar, recordFailure, recordFix, renderMemoriesForPrompt, type ErrorCategory } from '@/lib/knowledge/error-memory';
import { indexProject, selectRelevantFiles } from '@/lib/ide/repo-index';
import { workspaceFor, commitVersion, type Project } from '@/lib/workspace/project';
import { buildWeb, typecheckProject, type WebBuildResult } from '@/lib/build/web';
import { unifiedDiff, type FileChange } from '@/lib/workspace/filesystem';
import { GAME_RUNTIME_CONTRACT, APP_RUNTIME_CONTRACT } from '@/lib/qa/runtime';
import type { BuildDiagnostic } from '@/lib/build/store';

/**
 * Coding agent.
 *
 * Writes and repairs the source of a generated product, then proves the result
 * compiles. Three things make it more than a code-completion loop:
 *
 *  1. Context selection. It is given the ranked-relevant files from the project
 *     index rather than the whole repository, so the model sees what matters and
 *     the token cost stays bounded as the project grows.
 *  2. Error memory. Before every repair it recalls how the same failure was
 *     resolved previously, and after a successful repair it records the remedy.
 *     A defect the factory has already solved is not solved again from scratch.
 *  3. The no-regression policy. Every repair is inspected before it is written;
 *     a change that "fixes" the build by deleting behaviour is rejected and the
 *     model is asked again with the specific violation.
 */

const FileSpecSchema = z.object({
  path: z.string().min(3).max(160),
  purpose: z.string().min(10).max(400),
  contents: z.string().min(1).max(120_000),
});

const GenerationSchema = z.object({
  files: z.array(FileSpecSchema).min(1).max(24),
  notes: z.string().max(2000).default(''),
});

const RepairSchema = z.object({
  diagnosis: z.string().min(20).max(1500),
  files: z
    .array(
      z.object({
        path: z.string().min(3).max(160),
        contents: z.string().min(1).max(120_000),
        change: z.string().min(10).max(600),
      }),
    )
    .min(1)
    .max(8),
});

export interface FilePlanEntry {
  readonly path: string;
  readonly purpose: string;
  /** Modules this file is expected to import; guides the model's context. */
  readonly uses?: readonly string[];
}

export interface CodingAgentInput {
  readonly project: Project;
  readonly kind: 'app' | 'game' | 'hybrid';
  /** The architecture the architect agent produced. */
  readonly design: Record<string, unknown>;
  readonly plan: readonly FilePlanEntry[];
  /** Assets already generated, so the code references real paths. */
  readonly assets: readonly { path: string; kind: string; name: string }[];
  /** Structured gameplay data emitted alongside generated models. */
  readonly modelData?: Record<string, unknown>;
  readonly maxRepairAttempts?: number;
}

export interface CodingAgentOutput {
  readonly filesWritten: readonly string[];
  readonly build: WebBuildResult;
  readonly repairAttempts: number;
  readonly rejectedRepairs: number;
  readonly memoriesUsed: number;
  readonly succeeded: boolean;
}

function runtimeContract(kind: 'app' | 'game' | 'hybrid'): string {
  return kind === 'app' ? APP_RUNTIME_CONTRACT : GAME_RUNTIME_CONTRACT;
}

function systemPrompt(kind: 'app' | 'game' | 'hybrid'): string {
  const engine = kind === 'app' ? 'appkit' : 'engine';
  return `You are a senior engineer writing the source of a product inside an existing project.

The project already contains a runtime SDK at \`src/${engine}/\`. Import from \`./${engine}\` (the barrel) only — never from a submodule path, and never reimplement what the SDK provides.

For 3D products the SDK gives you: Engine (fixed-timestep loop, quality tiers, diagnostics), InputSystem and VirtualGamepad, terrain/sky/scatter world building, CharacterController and SpatialHash, VehicleController with a tyre model and presets, combat (Combatant, resolveMelee, stepBallistics, resolveHitscan, WeaponState), ParticleSystem and MaterialLibrary, RenderPipeline with image-based lighting and post-processing, model loading with animation (loadModel, instantiate, AnimationSystem, preloadModels), AudioEngine, UiLayer, SaveStore, Inventory, QuestLog, Progression.

Hard requirements:
- TypeScript, strict mode, no \`any\`, no non-null assertions on values that can genuinely be null.
- The entry point is \`src/main.ts\`.
- Implement the runtime inspection contract exactly, because the automated tests drive it:
${runtimeContract(kind)}
- Load the generated assets by the paths you are given. Do not invent asset paths.
- Every file you emit must be complete and compilable on its own. Never emit a fragment, a diff, or an ellipsis.
- Write the product's real behaviour. Placeholder logic that "would" do something is a failure.

${NO_REGRESSION_DIRECTIVE}`;
}

function categoriseDiagnostic(diagnostic: BuildDiagnostic): ErrorCategory {
  if (diagnostic.code?.startsWith('TS')) return 'typescript';
  if (/esbuild|bundle|resolve/i.test(diagnostic.message)) return 'bundler';
  return 'other';
}

export class CodingAgent extends Agent<CodingAgentInput, CodingAgentOutput> {
  readonly name = 'coding';
  readonly description = 'Writes the product source and drives it to a clean compile';

  constructor() {
    super({ maxAttempts: 1, timeoutMs: 1_800_000 });
  }

  protected async execute(input: CodingAgentInput, context: AgentContext): Promise<CodingAgentOutput> {
    const source = workspaceFor(input.project, 'source');
    const maxRepairs = input.maxRepairAttempts ?? 4;
    let memoriesUsed = 0;

    // ---------------------------------------------------------- generation --
    context.progress(`generating ${input.plan.length} source files`);
    const { data } = await completeJson({
      task: 'code_generation',
      schema: GenerationSchema,
      system: systemPrompt(input.kind),
      signal: context.signal,
      maxOutputTokens: 32_000,
      context: { projectId: input.project.id, factoryRunId: context.factoryRunId },
      messages: [
        {
          role: 'user',
          content:
            `PRODUCT: ${input.project.name} (${input.kind})\n${input.project.description}\n\n` +
            `DESIGN:\n${JSON.stringify(input.design, null, 2).slice(0, 20_000)}\n\n` +
            `FILE PLAN (write every one of these):\n${input.plan.map((f) => `- ${f.path}: ${f.purpose}${f.uses?.length ? ` [uses: ${f.uses.join(', ')}]` : ''}`).join('\n')}\n\n` +
            `AVAILABLE ASSETS (reference these exact paths, served from ./assets/):\n${input.assets.map((a) => `- assets/${a.path} (${a.kind}: ${a.name})`).join('\n')}\n\n` +
            (input.modelData ? `MODEL GAMEPLAY DATA:\n${JSON.stringify(input.modelData).slice(0, 8000)}\n\n` : '') +
            'Return JSON {"files":[{"path","purpose","contents"}],"notes":"..."}.',
        },
      ],
    });

    const written: string[] = [];
    for (const file of data.files) {
      if (file.path.startsWith('src/engine/') || file.path.startsWith('src/appkit/')) {
        context.logger.warn('ignoring an attempt to overwrite the runtime SDK', { path: file.path });
        continue;
      }
      source.write(file.path, file.contents);
      written.push(file.path);
    }
    if (!written.includes('src/main.ts')) {
      throw new AgentError('The generated file set has no src/main.ts entry point.', false, 'NO_ENTRYPOINT');
    }
    context.progress(`wrote ${written.length} files`, { files: written });

    await indexProject(input.project);

    // ------------------------------------------------------- verify + fix --
    let build = await buildWeb(input.project, { injectHarness: true });
    let attempt = 0;
    let rejected = 0;

    while (!build.succeeded && attempt < maxRepairs) {
      attempt += 1;
      const errors = build.diagnostics.filter((d) => d.severity === 'error');
      const headline = errors[0]?.message ?? build.build.errorSummary ?? 'unknown build failure';
      context.progress(`repair attempt ${attempt}/${maxRepairs}: ${errors.length} error(s)`, { headline });

      const category = errors[0] ? categoriseDiagnostic(errors[0]) : 'bundler';
      const memory = await recordFailure({
        category,
        phase: 'build',
        message: headline,
        detail: errors.slice(0, 12).map(formatDiagnostic).join('\n'),
        filePath: errors[0]?.file,
        projectId: input.project.id,
      });
      const recalled = await recallSimilar({ category, message: headline, filePath: errors[0]?.file, limit: 4 });
      memoriesUsed += recalled.filter((m) => m.resolved).length;

      const applied = await this.attemptRepair({
        input,
        context,
        errors,
        recalledPrompt: renderMemoriesForPrompt(recalled),
        attempt,
      });
      rejected += applied.rejected;
      if (applied.files.length === 0) {
        context.progress('no acceptable repair was produced for this attempt');
        continue;
      }

      await indexProject(input.project);
      const next = await buildWeb(input.project, { injectHarness: true });
      if (next.succeeded) {
        // Only record the remedy once the build has actually passed.
        recordFix({
          signature: memory.signature,
          summary: applied.diagnosis.slice(0, 400),
          diff: applied.diff.slice(0, 12_000),
          rationale: applied.diagnosis,
          verifiedBy: 'build',
        });
        context.progress('repair verified by a clean build; remedy recorded for future runs');
      }
      build = next;
    }

    if (build.succeeded) {
      const changes = source.takeChanges();
      commitVersion(input.project, {
        label: attempt === 0 ? 'initial implementation' : `implementation with ${attempt} repair round(s)`,
        summary: data.notes || `Generated ${written.length} files for ${input.project.name}.`,
        authorType: 'agent',
        authorId: this.name,
        changes,
      });
    }

    return {
      filesWritten: written,
      build,
      repairAttempts: attempt,
      rejectedRepairs: rejected,
      memoriesUsed,
      succeeded: build.succeeded,
    };
  }

  /**
   * Asks for a repair, checks it against the no-regression policy, and writes it
   * only if it passes. A rejected repair is retried once with the violation
   * spelled out, because the model usually complies when told exactly what it
   * did wrong.
   */
  private async attemptRepair(params: {
    input: CodingAgentInput;
    context: AgentContext;
    errors: readonly BuildDiagnostic[];
    recalledPrompt: string;
    attempt: number;
  }): Promise<{ files: string[]; diff: string; diagnosis: string; rejected: number }> {
    const { input, context, errors, recalledPrompt, attempt } = params;
    const source = workspaceFor(input.project, 'source');
    let rejected = 0;
    let guidance = '';

    for (let round = 0; round < 2; round += 1) {
      const focus = await selectRelevantFiles(input.project, errors.map(formatDiagnostic).join('\n'), {
        limit: 8,
        seeds: errors.map((e) => e.file).filter((f): f is string => Boolean(f)).map((f) => normaliseWorkspacePath(f, input.project)),
      });
      const excerpts = focus
        .filter((entry) => source.exists(entry.path))
        .map((entry) => `--- ${entry.path} (${entry.reason}) ---\n${source.readText(entry.path).slice(0, 16_000)}`)
        .join('\n\n');

      const { data } = await completeJson({
        task: 'code_repair',
        schema: RepairSchema,
        system: systemPrompt(input.kind),
        signal: context.signal,
        maxOutputTokens: 24_000,
        bypassCache: true,
        context: { projectId: input.project.id, factoryRunId: context.factoryRunId },
        messages: [
          {
            role: 'user',
            content:
              `The build failed. Diagnose the cause and fix it properly.\n\n` +
              `ERRORS:\n${errors.slice(0, 20).map(formatDiagnostic).join('\n')}\n\n` +
              (recalledPrompt ? `${recalledPrompt}\n\n` : '') +
              (guidance ? `YOUR PREVIOUS ATTEMPT WAS REJECTED:\n${guidance}\n\n` : '') +
              `RELEVANT SOURCE:\n${excerpts}\n\n` +
              'Return JSON {"diagnosis":"...","files":[{"path","contents","change"}]} with the COMPLETE new contents of each file you change.',
          },
        ],
      });

      const staged: Array<{ path: string; before: string; after: string; change: string }> = [];
      const violations: string[] = [];

      for (const file of data.files) {
        if (file.path.startsWith('src/engine/') || file.path.startsWith('src/appkit/')) {
          violations.push(`${file.path}: the runtime SDK is not modifiable from a product repair`);
          continue;
        }
        const before = source.exists(file.path) ? source.readText(file.path) : '';
        const assessment = assessRepair({ filePath: file.path, before, after: file.contents, isTestFile: /\btests?\//.test(file.path) });
        recordRepairAudit({ projectId: input.project.id, attempt, filePath: file.path, assessment });
        if (assessment.verdict === 'reject') {
          rejected += 1;
          violations.push(assessment.guidance);
          continue;
        }
        staged.push({ path: file.path, before, after: file.contents, change: file.change });
      }

      if (violations.length > 0 && staged.length === 0) {
        guidance = violations.join('\n\n');
        context.progress(`repair rejected by the quality policy (round ${round + 1}); asking again`);
        continue;
      }

      const diffs: string[] = [];
      const applied: string[] = [];
      for (const file of staged) {
        source.write(file.path, file.after);
        diffs.push(unifiedDiff(file.before, file.after, file.path));
        applied.push(file.path);
      }
      return { files: applied, diff: diffs.join('\n'), diagnosis: data.diagnosis, rejected };
    }

    return { files: [], diff: '', diagnosis: '', rejected };
  }
}

function formatDiagnostic(diagnostic: BuildDiagnostic): string {
  const location = diagnostic.file ? `${diagnostic.file}${diagnostic.line ? `(${diagnostic.line},${diagnostic.column ?? 0})` : ''}: ` : '';
  return `${location}${diagnostic.severity} ${diagnostic.code ?? ''} ${diagnostic.message}`.trim();
}

/** Compiler paths are absolute; the index and workspace use relative ones. */
function normaliseWorkspacePath(filePath: string, project: Project): string {
  const marker = `${project.workspacePath}/source/`;
  const index = filePath.indexOf(marker);
  if (index >= 0) return filePath.slice(index + marker.length);
  return filePath.replace(/^.*?\/source\//, '');
}

/**
 * Applies an operator instruction ("make the combat faster", "add a boost
 * mechanic") to an existing project, then verifies it still compiles.
 */
export interface RefineInput {
  readonly project: Project;
  readonly kind: 'app' | 'game' | 'hybrid';
  readonly instruction: string;
  readonly maxRepairAttempts?: number;
}

export class RefinementAgent extends Agent<RefineInput, CodingAgentOutput> {
  readonly name = 'coding';
  readonly description = 'Applies a natural-language change to an existing product and re-verifies it';

  constructor() {
    super({ maxAttempts: 1, timeoutMs: 1_800_000 });
  }

  protected async execute(input: RefineInput, context: AgentContext): Promise<CodingAgentOutput> {
    const source = workspaceFor(input.project, 'source');
    await indexProject(input.project);

    const relevant = await selectRelevantFiles(input.project, input.instruction, { limit: 10 });
    if (relevant.length === 0) throw new AgentError('The project index is empty; nothing to refine.', false, 'EMPTY_INDEX');

    const excerpts = relevant
      .filter((entry) => source.exists(entry.path))
      .map((entry) => `--- ${entry.path} (${entry.reason}) ---\n${source.readText(entry.path).slice(0, 16_000)}`)
      .join('\n\n');

    context.progress(`applying instruction across ${relevant.length} candidate files`);
    const { data } = await completeJson({
      task: 'code_generation',
      schema: RepairSchema,
      system: systemPrompt(input.kind),
      signal: context.signal,
      maxOutputTokens: 24_000,
      bypassCache: true,
      context: { projectId: input.project.id, factoryRunId: context.factoryRunId },
      messages: [
        {
          role: 'user',
          content:
            `OPERATOR INSTRUCTION: ${input.instruction}\n\n` +
            `Apply it to this product. Change as few files as the instruction genuinely requires, and keep everything else working.\n\n` +
            `RELEVANT SOURCE:\n${excerpts}\n\n` +
            'Return JSON {"diagnosis":"what you changed and why","files":[{"path","contents","change"}]} with COMPLETE file contents.',
        },
      ],
    });

    const changes: FileChange[] = [];
    let rejected = 0;
    for (const file of data.files) {
      if (file.path.startsWith('src/engine/') || file.path.startsWith('src/appkit/')) continue;
      const before = source.exists(file.path) ? source.readText(file.path) : '';
      const assessment = assessRepair({ filePath: file.path, before, after: file.contents });
      recordRepairAudit({ projectId: input.project.id, attempt: 0, filePath: file.path, assessment });
      if (assessment.verdict === 'reject') {
        rejected += 1;
        context.logger.warn('refinement rejected by the quality policy', { path: file.path });
        continue;
      }
      changes.push(source.write(file.path, file.contents));
    }

    if (changes.length === 0) {
      throw new AgentError('No acceptable change was produced for this instruction.', false, 'NO_CHANGE');
    }

    await indexProject(input.project);
    const typecheck = await typecheckProject(input.project, context.signal);
    const build = await buildWeb(input.project, { injectHarness: true, runTypecheck: !typecheck.ok });

    if (build.succeeded) {
      commitVersion(input.project, {
        label: input.instruction.slice(0, 60),
        summary: data.diagnosis,
        authorType: 'user',
        authorId: 'operator',
        changes: source.takeChanges(),
      });
    }

    return {
      filesWritten: changes.map((c) => c.path),
      build,
      repairAttempts: 0,
      rejectedRepairs: rejected,
      memoriesUsed: 0,
      succeeded: build.succeeded,
    };
  }
}
