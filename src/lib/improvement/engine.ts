import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { db, fromJson, newId, nowIso, toJson } from '@/lib/db/client';
import { config } from '@/lib/config/env';
import { completeJson } from '@/lib/ai/router';
import { errorMemoryStats, listErrorMemories } from '@/lib/knowledge/error-memory';
import { assessRepair, NO_REGRESSION_DIRECTIVE } from '@/lib/agents/repair-policy';
import { unifiedDiff } from '@/lib/workspace/filesystem';
import { resolveInside } from '@/lib/workspace/paths';
import { createLogger } from '@/lib/observability/logger';
import { emitEvent } from '@/lib/observability/events';
import { audit } from '@/lib/security/audit';

const log = createLogger('improvement.engine');

/**
 * Self-improvement engine.
 *
 * The factory measures its own output, finds where it is weakest, and proposes
 * concrete changes to its own source — the runtime engine, the model
 * generators, the asset pipeline, the caches — with the evidence that motivated
 * each one.
 *
 * Two safety properties make this safe to run continuously:
 *
 *  1. Proposals are scoped. Only directories on the allow-list can be modified,
 *     and never the security, auth or improvement code itself, so the loop can
 *     improve what it builds but cannot weaken what constrains it.
 *  2. Every applied change passes the same no-regression policy as a repair, so
 *     "improvement" can never mean deleting capability, and the patch is stored
 *     so it can be reverted.
 *
 * In `manual` and `semi` autonomy the engine stops at a reviewable proposal with
 * a patch; only `auto` applies it, and only after the checks pass.
 */

/** Directories the engine may modify. Everything else is off limits. */
export const IMPROVABLE_ROOTS: readonly string[] = [
  'src/runtime/engine',
  'src/runtime/appkit',
  'src/lib/generation',
  'src/lib/graphics',
  'src/lib/market',
  'src/lib/research',
  'src/lib/cache',
];

/** Never modifiable, regardless of what a proposal asks for. */
const PROTECTED_PATTERNS: readonly RegExp[] = [
  /^src\/lib\/security\//,
  /^src\/lib\/improvement\//,
  /^src\/lib\/agents\/repair-policy\.ts$/,
  /^src\/lib\/db\/migrations\.ts$/,
  /^src\/middleware\.ts$/,
  /^scripts\//,
  /^\.github\//,
];

export type ImprovementArea =
  | 'mesh_quality'
  | 'texture_quality'
  | 'animation'
  | 'rendering'
  | 'physics'
  | 'input'
  | 'performance'
  | 'caching'
  | 'research_quality'
  | 'code_generation'
  | 'build_reliability';

export type ProposalStatus = 'proposed' | 'approved' | 'applied' | 'rejected' | 'reverted' | 'failed';

export interface ImprovementProposal {
  readonly id: string;
  /** 'platform' changes the factory itself; 'project' changes one product. */
  readonly target: 'platform' | 'project';
  readonly area: ImprovementArea;
  readonly title: string;
  readonly rationale: string;
  readonly evidence: string[];
  readonly expectedGain: string;
  readonly risk: string;
  readonly priority: number;
  readonly status: ProposalStatus;
  readonly appliedDiff: string;
  readonly measurement: Record<string, unknown>;
  readonly createdAt: string;
}

interface ProposalRow {
  id: string;
  target: string;
  area: string;
  title: string;
  rationale: string;
  evidence: string;
  expected_gain: string;
  risk: string;
  priority: number;
  status: string;
  applied_diff: string;
  measurement: string;
  project_id: string | null;
  factory_run_id: string | null;
  created_at: string;
  updated_at: string;
}

function toProposal(row: ProposalRow): ImprovementProposal {
  return {
    id: row.id,
    target: row.target as 'platform' | 'project',
    area: row.area as ImprovementArea,
    title: row.title,
    rationale: row.rationale,
    evidence: fromJson<string[]>(row.evidence, []),
    expectedGain: row.expected_gain,
    risk: row.risk,
    priority: row.priority,
    status: row.status as ProposalStatus,
    appliedDiff: row.applied_diff,
    measurement: fromJson<Record<string, unknown>>(row.measurement, {}),
    createdAt: row.created_at,
  };
}

// ------------------------------------------------------------- measurement --

export interface QualitySnapshot {
  readonly products: number;
  readonly buildSuccessRate: number;
  readonly firstPassTypecheckRate: number;
  readonly runtimePassRate: number;
  readonly assetValidationRate: number;
  readonly meanFps: number;
  readonly meanTrianglesPerModel: number;
  readonly meanCostUsdPerProduct: number;
  readonly cacheHitRate: number;
  readonly errorRecurrenceRate: number;
  readonly repairRejectionRate: number;
  readonly capturedAt: string;
}

/**
 * Measures the factory's current output quality. These are the numbers an
 * improvement has to move; without them "improvement" is an opinion.
 */
export function measureQuality(): QualitySnapshot {
  const database = db();
  const number = (sql: string, fallback = 0): number => {
    const row = database.prepare<[], { value: number | null }>(sql).get();
    return row?.value ?? fallback;
  };

  const products = number('SELECT COUNT(*) AS value FROM projects');
  const builds = number('SELECT COUNT(*) AS value FROM builds');
  const buildsOk = number("SELECT COUNT(*) AS value FROM builds WHERE status = 'SUCCEEDED'");
  const typecheckClean = number("SELECT COUNT(*) AS value FROM builds WHERE target = 'web' AND diagnostics = '[]'");
  const webBuilds = number("SELECT COUNT(*) AS value FROM builds WHERE target = 'web'");
  const runs = number('SELECT COUNT(*) AS value FROM test_runs');
  const runsOk = number("SELECT COUNT(*) AS value FROM test_runs WHERE status = 'passed'");
  const assets = number('SELECT COUNT(*) AS value FROM assets');
  const assetsOk = number('SELECT COUNT(*) AS value FROM assets WHERE validated = 1');
  const cost = number('SELECT COALESCE(SUM(cost_usd), 0) AS value FROM api_usage');
  const calls = number('SELECT COUNT(*) AS value FROM api_usage');
  const cacheHits = number("SELECT COUNT(*) AS value FROM api_usage WHERE cache_hit != 'miss'");
  const repairs = number('SELECT COUNT(*) AS value FROM repair_audits');
  const repairsRejected = number("SELECT COUNT(*) AS value FROM repair_audits WHERE verdict = 'reject'");

  const fpsRow = database
    .prepare<[], { value: number | null }>(
      `SELECT AVG(json_extract(report, '$.frameStats.fps')) AS value FROM test_runs WHERE suite = 'runtime'`,
    )
    .get();
  const triangleRow = database
    .prepare<[], { value: number | null }>(
      `SELECT AVG(json_extract(validation, '$.triangles')) AS value FROM assets WHERE mime = 'model/gltf-binary'`,
    )
    .get();

  const memory = errorMemoryStats();
  const ratio = (numerator: number, denominator: number): number => (denominator === 0 ? 0 : Number((numerator / denominator).toFixed(4)));

  return {
    products,
    buildSuccessRate: ratio(buildsOk, builds),
    firstPassTypecheckRate: ratio(typecheckClean, webBuilds),
    runtimePassRate: ratio(runsOk, runs),
    assetValidationRate: ratio(assetsOk, assets),
    meanFps: Number((fpsRow?.value ?? 0).toFixed(1)),
    meanTrianglesPerModel: Math.round(triangleRow?.value ?? 0),
    meanCostUsdPerProduct: products === 0 ? 0 : Number((cost / products).toFixed(4)),
    cacheHitRate: ratio(cacheHits, calls),
    errorRecurrenceRate: memory.total === 0 ? 0 : Number((memory.recurrences / memory.total).toFixed(4)),
    repairRejectionRate: ratio(repairsRejected, repairs),
    capturedAt: nowIso(),
  };
}

// ---------------------------------------------------------------- proposal --

const FileEditSchema = z.object({
  path: z.string().min(3).max(200),
  /** The exact text to find. Must appear once in the file. */
  find: z.string().min(10).max(6000),
  replace: z.string().min(1).max(12_000),
  reason: z.string().min(15).max(400),
});

const ProposalSchema = z.object({
  proposals: z
    .array(
      z.object({
        area: z.enum([
          'mesh_quality',
          'texture_quality',
          'animation',
          'rendering',
          'physics',
          'input',
          'performance',
          'caching',
          'research_quality',
          'code_generation',
          'build_reliability',
        ]),
        title: z.string().min(8).max(120),
        rationale: z.string().min(40).max(1200),
        evidence: z.array(z.string().max(300)).min(1).max(8),
        expectedGain: z.string().min(10).max(300),
        risk: z.enum(['low', 'medium', 'high']),
        priority: z.number().min(0).max(1),
        edits: z.array(FileEditSchema).min(1).max(8),
      }),
    )
    .max(5),
});

export interface ProposeInput {
  readonly snapshot: QualitySnapshot;
  /** Recent observations: build errors, runtime findings, asset warnings. */
  readonly observations: readonly string[];
  readonly projectId?: string;
  readonly factoryRunId?: string;
  readonly maxProposals?: number;
  readonly signal?: AbortSignal;
}

const SYSTEM_PROMPT = `You improve a software factory by editing its own source code.

You are given the factory's measured output quality, recent failures, and the source of the modules you may change.

Rules:
- Propose changes that raise the quality of what the factory produces: better geometry, better materials, better animation, better rendering, better physics, better input feel, faster builds, higher cache hit rates, fewer repeated failures.
- Every proposal must cite the measurement or failure that motivates it.
- Each edit is a find/replace against the current file content. The "find" text must be copied EXACTLY from the file shown to you and must appear exactly once.
- Never propose removing a feature, a guard, a test or a validation to make a number look better.
- Never propose changes to security, authentication, the repair policy, migrations, or this engine.
- Prefer one substantial, well-argued improvement over several speculative ones.
${NO_REGRESSION_DIRECTIVE}`;

/** True when `relative` is inside an improvable root and not protected. */
export function isImprovable(relative: string): boolean {
  const normalised = relative.replace(/\\/g, '/').replace(/^\.\//, '');
  if (PROTECTED_PATTERNS.some((pattern) => pattern.test(normalised))) return false;
  return IMPROVABLE_ROOTS.some((root) => normalised === root || normalised.startsWith(`${root}/`));
}

function readPlatformFile(relative: string): string | null {
  if (!isImprovable(relative)) return null;
  try {
    return fs.readFileSync(resolveInside(process.cwd(), relative), 'utf8');
  } catch {
    return null;
  }
}

/**
 * Asks the model to propose improvements, given the measured state and the
 * source of the modules relevant to the weakest metric.
 */
export async function proposeImprovements(input: ProposeInput): Promise<ImprovementProposal[]> {
  const focusFiles = selectFocusFiles(input.snapshot, input.observations);
  const sources = focusFiles
    .map((relative) => ({ relative, content: readPlatformFile(relative) }))
    .filter((entry): entry is { relative: string; content: string } => entry.content !== null)
    // Long files are truncated: the model gets the head, which carries the
    // documented contract and the tunable constants that matter most.
    .map((entry) => `--- ${entry.relative} ---\n${entry.content.slice(0, 14_000)}`);

  if (sources.length === 0) {
    log.warn('no improvable source files were resolved; skipping proposal generation');
    return [];
  }

  const { data } = await completeJson({
    task: 'performance_review',
    schema: ProposalSchema,
    system: SYSTEM_PROMPT,
    signal: input.signal,
    maxOutputTokens: 12_000,
    context: { projectId: input.projectId, factoryRunId: input.factoryRunId },
    messages: [
      {
        role: 'user',
        content:
          `MEASURED OUTPUT QUALITY:\n${JSON.stringify(input.snapshot, null, 2)}\n\n` +
          `RECENT OBSERVATIONS:\n${input.observations.map((o) => `- ${o}`).join('\n')}\n\n` +
          `SOURCE YOU MAY EDIT:\n${sources.join('\n\n')}\n\n` +
          `Propose at most ${input.maxProposals ?? 2} improvements as JSON.`,
      },
    ],
  });

  const stored: ImprovementProposal[] = [];
  for (const candidate of data.proposals) {
    const invalid = candidate.edits.find((edit) => !isImprovable(edit.path));
    if (invalid) {
      log.warn('discarded a proposal targeting a protected path', { title: candidate.title, path: invalid.path });
      continue;
    }
    stored.push(
      recordProposal({
        target: 'platform',
        area: candidate.area,
        title: candidate.title,
        rationale: candidate.rationale,
        evidence: candidate.evidence,
        expectedGain: candidate.expectedGain,
        risk: candidate.risk,
        priority: candidate.priority,
        edits: candidate.edits,
        projectId: input.projectId,
        factoryRunId: input.factoryRunId,
        snapshot: input.snapshot,
      }),
    );
  }
  return stored;
}

export interface FileEdit {
  readonly path: string;
  readonly find: string;
  readonly replace: string;
  readonly reason: string;
}

export function recordProposal(input: {
  target: 'platform' | 'project';
  area: ImprovementArea;
  title: string;
  rationale: string;
  evidence: readonly string[];
  expectedGain: string;
  risk: string;
  priority: number;
  edits: readonly FileEdit[];
  projectId?: string;
  factoryRunId?: string;
  snapshot?: QualitySnapshot;
}): ImprovementProposal {
  const id = newId('imp');
  const now = nowIso();
  db()
    .prepare(
      `INSERT INTO improvement_proposals (id, target, area, title, rationale, evidence, expected_gain, risk,
         priority, status, applied_diff, measurement, project_id, factory_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'proposed', '', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      input.target,
      input.area,
      input.title,
      input.rationale,
      toJson(input.evidence),
      input.expectedGain,
      input.risk,
      input.priority,
      toJson({ before: input.snapshot ?? null, edits: input.edits }),
      input.projectId ?? null,
      input.factoryRunId ?? null,
      now,
      now,
    );

  emitEvent({
    type: 'agent.progress',
    scope: 'improvement',
    projectId: input.projectId,
    runId: input.factoryRunId,
    message: `improvement proposed: ${input.title}`,
    data: { area: input.area, priority: input.priority, risk: input.risk },
  });
  log.info('improvement proposed', { id, area: input.area, title: input.title });

  return toProposal(db().prepare<[string], ProposalRow>('SELECT * FROM improvement_proposals WHERE id = ?').get(id) as ProposalRow);
}

export interface ApplyResult {
  readonly applied: boolean;
  readonly diff: string;
  readonly rejections: readonly string[];
  readonly changedFiles: readonly string[];
}

/**
 * Applies a proposal to the platform source.
 *
 * Each edit is applied to an in-memory copy first; the whole set is checked
 * against the no-regression policy; only if everything passes are the files
 * written. A failed check leaves the working tree untouched.
 */
export function applyProposal(id: string, actorId: string): ApplyResult {
  const row = db().prepare<[string], ProposalRow>('SELECT * FROM improvement_proposals WHERE id = ?').get(id);
  if (!row) throw new Error(`Unknown improvement proposal ${id}`);
  const proposal = toProposal(row);
  const measurement = fromJson<{ edits?: FileEdit[] }>(row.measurement, {});
  const edits = measurement.edits ?? [];
  if (edits.length === 0) throw new Error(`Proposal ${id} carries no edits`);

  const staged = new Map<string, { before: string; after: string }>();
  const rejections: string[] = [];

  for (const edit of edits) {
    if (!isImprovable(edit.path)) {
      rejections.push(`${edit.path}: outside the improvable roots`);
      continue;
    }
    const absolute = resolveInside(process.cwd(), edit.path);
    let current = staged.get(edit.path)?.after;
    let original = staged.get(edit.path)?.before;
    if (current === undefined) {
      try {
        current = fs.readFileSync(absolute, 'utf8');
        original = current;
      } catch {
        rejections.push(`${edit.path}: file not found`);
        continue;
      }
    }
    const occurrences = current.split(edit.find).length - 1;
    if (occurrences === 0) {
      rejections.push(`${edit.path}: the anchor text was not found; the file has changed since the proposal`);
      continue;
    }
    if (occurrences > 1) {
      rejections.push(`${edit.path}: the anchor text appears ${occurrences} times and is ambiguous`);
      continue;
    }
    staged.set(edit.path, { before: original as string, after: current.replace(edit.find, edit.replace) });
  }

  const diffs: string[] = [];
  for (const [relative, { before, after }] of staged) {
    const assessment = assessRepair({ filePath: relative, before, after });
    if (assessment.verdict === 'reject') {
      rejections.push(`${relative}: ${assessment.violations.filter((v) => v.blocking).map((v) => v.detail).join('; ')}`);
      continue;
    }
    diffs.push(unifiedDiff(before, after, relative));
  }

  if (rejections.length > 0) {
    db().prepare("UPDATE improvement_proposals SET status = 'rejected', updated_at = ? WHERE id = ?").run(nowIso(), id);
    audit({
      actorType: 'system',
      actorId,
      action: 'improvement.rejected',
      targetType: 'improvement',
      targetId: id,
      outcome: 'denied',
      metadata: { rejections },
    });
    log.warn('improvement rejected', { id, rejections });
    return { applied: false, diff: diffs.join('\n'), rejections, changedFiles: [] };
  }

  for (const [relative, { after }] of staged) {
    fs.writeFileSync(resolveInside(process.cwd(), relative), after, 'utf8');
  }

  const diff = diffs.join('\n');
  db()
    .prepare("UPDATE improvement_proposals SET status = 'applied', applied_diff = ?, updated_at = ? WHERE id = ?")
    .run(diff, nowIso(), id);
  audit({
    actorType: 'system',
    actorId,
    action: 'improvement.applied',
    targetType: 'improvement',
    targetId: id,
    metadata: { files: [...staged.keys()], area: proposal.area, title: proposal.title },
  });
  emitEvent({
    type: 'agent.finished',
    scope: 'improvement',
    message: `improvement applied: ${proposal.title}`,
    data: { files: [...staged.keys()] },
  });
  log.info('improvement applied', { id, files: [...staged.keys()] });

  return { applied: true, diff, rejections: [], changedFiles: [...staged.keys()] };
}

/** Chooses which modules the model should look at, from the weakest metric. */
export function selectFocusFiles(snapshot: QualitySnapshot, observations: readonly string[]): string[] {
  const text = observations.join(' ').toLowerCase();
  const files = new Set<string>();

  if (snapshot.meanFps > 0 && snapshot.meanFps < 45) {
    files.add('src/runtime/engine/render.ts');
    files.add('src/runtime/engine/core.ts');
  }
  if (snapshot.assetValidationRate < 0.98 || /mesh|texture|glb|asset/.test(text)) {
    files.add('src/lib/generation/models/catalog.ts');
    files.add('src/lib/generation/pbr.ts');
  }
  if (/animation|rig|skin|joint/.test(text)) files.add('src/lib/generation/models/skeleton.ts');
  if (/vehicle|car|drift|steer|tyre|tire/.test(text)) files.add('src/runtime/engine/vehicle.ts');
  if (/character|avatar|anatomy|proportion/.test(text)) files.add('src/lib/generation/models/character.ts');
  if (/track|circuit|corner|kerb/.test(text)) files.add('src/lib/generation/models/track.ts');
  if (snapshot.cacheHitRate < 0.35) files.add('src/lib/cache/index.ts');
  if (snapshot.firstPassTypecheckRate < 0.8) files.add('src/lib/generation/scaffold.ts');
  if (/touch|joystick|gamepad|input/.test(text)) files.add('src/runtime/engine/gamepad.ts');
  if (/physics|collision|jump|slope/.test(text)) files.add('src/runtime/engine/physics.ts');

  if (files.size === 0) {
    files.add('src/lib/generation/models/catalog.ts');
    files.add('src/runtime/engine/render.ts');
  }
  return [...files].slice(0, 4);
}

/**
 * Builds the observation list from what the factory has recorded, so the
 * proposal step is grounded in facts rather than in a general request to
 * "improve things".
 */
export function gatherObservations(limit = 24): string[] {
  const database = db();
  const observations: string[] = [];

  for (const row of database
    .prepare<[number], { error_summary: string; target: string; created_at: string }>(
      "SELECT error_summary, target, created_at FROM builds WHERE status = 'FAILED' AND error_summary != '' ORDER BY created_at DESC LIMIT ?",
    )
    .all(8)) {
    observations.push(`build failure (${row.target}): ${row.error_summary.slice(0, 220)}`);
  }

  for (const row of database
    .prepare<[number], { suite: string; report: string }>(
      "SELECT suite, report FROM test_runs WHERE status != 'passed' ORDER BY created_at DESC LIMIT ?",
    )
    .all(6)) {
    const report = fromJson<{ summary?: string }>(row.report, {});
    observations.push(`failing ${row.suite} run: ${report.summary ?? 'no summary'}`);
  }

  for (const row of database
    .prepare<[number], { path: string; validation: string }>(
      "SELECT path, validation FROM assets WHERE validated = 0 ORDER BY created_at DESC LIMIT ?",
    )
    .all(6)) {
    observations.push(`asset failed validation: ${row.path} (${row.validation.slice(0, 160)})`);
  }

  for (const memory of listErrorMemories(8)) {
    if (memory.occurrences > 1) {
      observations.push(`recurring failure (${memory.occurrences}x, ${memory.resolved ? 'has remedy' : 'unresolved'}): ${memory.message.slice(0, 200)}`);
    }
  }

  for (const row of database
    .prepare<[number], { file_path: string; violations: string }>(
      "SELECT file_path, violations FROM repair_audits WHERE verdict = 'reject' ORDER BY created_at DESC LIMIT ?",
    )
    .all(4)) {
    observations.push(`repair rejected in ${row.file_path}: ${row.violations.slice(0, 200)}`);
  }

  return observations.slice(0, limit);
}

export function listProposals(status?: ProposalStatus, limit = 50): ImprovementProposal[] {
  if (status) {
    return db()
      .prepare<[string, number], ProposalRow>(
        'SELECT * FROM improvement_proposals WHERE status = ? ORDER BY priority DESC, created_at DESC LIMIT ?',
      )
      .all(status, limit)
      .map(toProposal);
  }
  return db()
    .prepare<[number], ProposalRow>('SELECT * FROM improvement_proposals ORDER BY created_at DESC LIMIT ?')
    .all(limit)
    .map(toProposal);
}

export function getProposal(id: string): ImprovementProposal | null {
  const row = db().prepare<[string], ProposalRow>('SELECT * FROM improvement_proposals WHERE id = ?').get(id);
  return row ? toProposal(row) : null;
}

export function setProposalStatus(id: string, status: ProposalStatus): void {
  db().prepare('UPDATE improvement_proposals SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), id);
}

/**
 * One self-improvement cycle: measure, gather evidence, propose, and — only in
 * fully autonomous mode — apply the highest-priority low-risk proposal.
 */
export async function runImprovementCycle(options: { factoryRunId?: string; signal?: AbortSignal } = {}): Promise<{
  snapshot: QualitySnapshot;
  proposals: readonly ImprovementProposal[];
  applied: readonly string[];
}> {
  const snapshot = measureQuality();
  const observations = gatherObservations();
  if (observations.length === 0) {
    log.info('no observations to learn from yet; skipping the improvement cycle');
    return { snapshot, proposals: [], applied: [] };
  }

  const proposals = await proposeImprovements({
    snapshot,
    observations,
    factoryRunId: options.factoryRunId,
    signal: options.signal,
  });

  const applied: string[] = [];
  if (config().AUTONOMY_MODE === 'auto') {
    const candidate = proposals
      .filter((p) => p.risk === 'low')
      .sort((a, b) => b.priority - a.priority)[0];
    if (candidate) {
      const result = applyProposal(candidate.id, 'self-improvement');
      if (result.applied) applied.push(candidate.id);
    }
  }

  return { snapshot, proposals, applied };
}

/** Records the measured effect of an applied improvement. */
export function measureProposalOutcome(id: string): void {
  const proposal = getProposal(id);
  if (!proposal || proposal.status !== 'applied') return;
  const after = measureQuality();
  const measurement = { ...proposal.measurement, after };
  db().prepare('UPDATE improvement_proposals SET measurement = ?, updated_at = ? WHERE id = ?')
    .run(toJson(measurement), nowIso(), id);
}

void path;
