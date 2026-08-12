import { z } from 'zod';
import { completeJson } from '@/lib/ai/router';
import { createLogger } from '@/lib/observability/logger';
import { emitEvent } from '@/lib/observability/events';
import { recallSimilar, recordFailure, recordFix, renderMemoriesForPrompt } from '@/lib/knowledge/error-memory';
import {
  bestVerdictFor,
  exemplarRecipes,
  recallRecipe,
  recordFailureMode,
  recordReviewRound,
  rememberRecipe,
  renderFailureModesForPrompt,
  topFailureModes,
} from '@/lib/knowledge/recipe-library';
import { AssetRecipeSchema, RecipePatchSchema, applyRecipePatch, type AssetRecipe, type RecipePatch } from '../recipe/schema';
import { buildAssetFromRecipe, type BuiltAsset } from '../recipe/build';
import { recipeExamplePrompt, recipeRepairPrompt, recipeSystemPrompt, recipeUserPrompt, type AssetRequestBrief } from '../recipe/prompt';
import { renderForReview, type RenderReviewResult } from './render';
import { reviewAsset, VerdictSchema, type AssetVerdict } from './critic';

const log = createLogger('generation.review.loop');

/**
 * The closed loop: write, build, look, judge, repair.
 *
 * This is what separates this pipeline from one that emits an asset and hopes.
 * Each round the model sees exactly what it produced and the specific ways in
 * which it failed its own acceptance criteria, and repairs against them. The
 * loop stops when the critic accepts, when the score stops improving, or when
 * the round budget runs out — whichever comes first.
 *
 * Two things make the loop converge rather than wander:
 *
 *  - Every failure is recorded in the error memory under a normalised
 *    signature, and every fix that resolved one is attached to it. A later
 *    asset that fails the same way is repaired with the remedy that worked,
 *    injected into the prompt before the model tries anything.
 *  - The best attempt is kept. A repair that scores worse than the attempt it
 *    replaced is discarded rather than carried forward, so a bad round cannot
 *    drag the result below where it had already got to.
 */

export interface AssetLoopOptions {
  readonly request: AssetRequestBrief;
  readonly palette: readonly string[];
  readonly seed?: number;
  /** How many repair rounds after the first attempt. */
  readonly maxRepairs?: number;
  readonly passMark?: number;
  readonly textureSize?: number;
  /** Groups the asset in the library: 'vehicle', 'character', 'prop', … */
  readonly category?: string;
  /** Set false to force a fresh authoring even if the library already answers this. */
  readonly reuse?: boolean;
  /**
   * A recipe to start from instead of authoring one.
   *
   * Repairing an asset that already exists should not pay to invent it again.
   * The first round then builds and reviews this recipe as written, and every
   * round after it repairs against what the critic saw — which is the whole
   * loop, minus the one step that had already been bought.
   */
  readonly initialRecipe?: AssetRecipe;
  readonly signal?: AbortSignal;
  readonly context?: { projectId?: string; factoryRunId?: string };
}

export interface AssetAttempt {
  readonly round: number;
  readonly recipe: AssetRecipe;
  readonly asset: BuiltAsset;
  readonly verdict: AssetVerdict;
  readonly failures: readonly string[];
  readonly accepted: boolean;
  /**
   * Absent when the asset came from the library: a stored recipe is served with
   * the verdict it earned when it was first reviewed, and re-rendering it to
   * produce pictures nobody looks at would spend the time the reuse saved.
   */
  readonly render?: RenderReviewResult;
}

export interface AssetLoopResult {
  /** The highest-scoring attempt, which is what should be used. */
  readonly best: AssetAttempt;
  readonly attempts: readonly AssetAttempt[];
  readonly accepted: boolean;
  readonly rounds: number;
  readonly totalMs: number;
  /** True when the asset came from the recipe library rather than being authored. */
  readonly reused: boolean;
  /** The library row this asset is stored under, when it could be stored. */
  readonly recipeId: string | null;
}

/**
 * Builds a recipe, retrying only the *authoring* when the interpreter refuses
 * it. A recipe that will not build is a different failure from one that builds
 * something wrong, and it is repaired with the interpreter's own diagnostic
 * rather than with a picture.
 */
async function authorRecipe(
  options: AssetLoopOptions,
  history: Array<{ role: 'user' | 'assistant'; content: string }>,
): Promise<{ recipe: AssetRecipe; asset: BuiltAsset }> {
  // A supplied recipe is used as the first round's answer rather than paid for
  // again. It is still built here, so a recipe that no longer interprets fails
  // in the same place and with the same diagnostic as one just written.
  if (options.initialRecipe && history.length === 0) {
    const asset = buildAssetFromRecipe(options.initialRecipe, {
      palette: options.palette,
      ...(options.seed !== undefined ? { seed: options.seed } : {}),
      ...(options.textureSize !== undefined ? { textureSize: options.textureSize } : {}),
    });
    return { recipe: options.initialRecipe, asset };
  }

  const maxBuildRetries = 3;
  let lastError = '';

  for (let attempt = 0; attempt < maxBuildRetries; attempt += 1) {
    const memories = await recallSimilar({
      category: 'asset',
      message: lastError || options.request.request,
      limit: 4,
    });
    const lessons = memories.length > 0 ? `\n\nLESSONS FROM EARLIER FAILURES:\n${renderMemoriesForPrompt(memories)}` : '';

    // The library's own best work, and the mistakes this pipeline keeps making,
    // both go in front of the request. Together they are what makes the author
    // better next month than it is today without a line of the prompt changing.
    const learned = exemplarRecipes({ ...(options.category ? { category: options.category } : {}), limit: 2 }).map(
      (stored) => ({ title: stored.subject || stored.name, recipe: stored.recipe, score: stored.score }),
    );
    const recurring = renderFailureModesForPrompt(topFailureModes(8));

    const messages = [
      {
        role: 'user' as const,
        content:
          `${recipeExamplePrompt(learned)}\n\n---\n\n${recipeUserPrompt(options.request)}${lessons}` +
          (recurring ? `\n\n${recurring}` : ''),
      },
      ...history,
    ];
    if (lastError) {
      messages.push({
        role: 'user' as const,
        content: `That recipe could not be built:\n\n${lastError}\n\nFix the cause and return the complete corrected recipe.`,
      });
    }

    const { data: recipe } = await completeJson({
      task: 'asset_recipe',
      system: recipeSystemPrompt(),
      schema: AssetRecipeSchema as unknown as z.ZodType<AssetRecipe, z.ZodTypeDef, unknown>,
      messages,
      // A recipe carrying a full brief and eighty steps has measured close to
      // 12k tokens on its own, and a JSON answer that runs out of room is
      // unrecoverable rather than repairable.
      maxOutputTokens: 32_000,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.context ? { context: options.context } : {}),
    });

    try {
      const asset = buildAssetFromRecipe(recipe, {
        palette: options.palette,
        ...(options.seed !== undefined ? { seed: options.seed } : {}),
        ...(options.textureSize !== undefined ? { textureSize: options.textureSize } : {}),
      });
      if (lastError) {
        // The recipe that finally built is the fix for the one that did not.
        const memory = await recordFailure({
          category: 'asset',
          phase: 'generation',
          message: lastError,
        });
        recordFix({
          signature: memory.signature,
          summary: `Rewrote the recipe for "${recipe.name}" so the interpreter accepted it.`,
          diff: JSON.stringify(recipe.steps.map((step) => ({ id: step.id, op: step.op })), null, 2).slice(0, 4000),
          rationale: 'The interpreter rejected the previous recipe; this structure builds.',
          verifiedBy: 'build',
        });
      }
      return { recipe, asset };
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.warn('recipe failed to build; asking for a correction', { attempt, error: lastError });
      await recordFailure({ category: 'asset', phase: 'generation', message: lastError });
    }
  }

  throw new Error(`the recipe could not be made to build after ${maxBuildRetries} attempts: ${lastError}`);
}

/**
 * Serves an asset from the recipe library.
 *
 * The stored recipe is rebuilt against *this* caller's palette and seed, so a
 * reused asset still takes the product's colours; only the shape is reused,
 * which is the expensive part. The verdict is the one that recipe earned when a
 * critic actually looked at it — the loop never claims a review it did not run.
 *
 * Returns null whenever anything about the stored row cannot be honoured, in
 * which case the caller authors a fresh recipe. There is no partial reuse.
 */
async function serveFromLibrary(options: AssetLoopOptions): Promise<AssetLoopResult | null> {
  const started = Date.now();
  const category = options.category ?? 'other';

  let stored;
  try {
    stored = await recallRecipe({ request: options.request.request, category });
  } catch (error) {
    log.warn('the recipe library could not be consulted; authoring from scratch', {
      error: (error as Error).message,
    });
    return null;
  }
  if (!stored) return null;

  const remembered = bestVerdictFor(stored.id);
  if (!remembered) {
    log.debug('a stored recipe has no recorded verdict; it will be re-authored rather than served unreviewed', {
      name: stored.name,
    });
    return null;
  }
  const verdict = VerdictSchema.safeParse(remembered.verdict);
  if (!verdict.success) return null;

  let asset: BuiltAsset;
  try {
    asset = buildAssetFromRecipe(stored.recipe, {
      palette: options.palette,
      ...(options.seed !== undefined ? { seed: options.seed } : { seed: stored.seed }),
      ...(options.textureSize !== undefined ? { textureSize: options.textureSize } : {}),
    });
  } catch (error) {
    // A recipe that no longer builds is a real regression in the kernel, not a
    // cache miss to pass over quietly.
    const message = (error as Error).message;
    log.warn('a stored recipe no longer builds; authoring a replacement', { name: stored.name, error: message });
    await recordFailure({
      category: 'asset',
      phase: 'generation',
      message: `stored recipe "${stored.name}" no longer builds: ${message}`,
    });
    return null;
  }

  const attempt: AssetAttempt = {
    round: remembered.round,
    recipe: stored.recipe,
    asset,
    verdict: verdict.data,
    failures: remembered.failures,
    accepted: stored.accepted,
  };

  emitEvent({
    type: 'asset.generated',
    scope: 'generation',
    message: `reused "${stored.name}" from the recipe library (scored ${Math.round(stored.score)}, matched by ${stored.matchedBy})`,
    data: { name: stored.name, score: stored.score, matchedBy: stored.matchedBy, reused: true },
    ...(options.context?.projectId ? { projectId: options.context.projectId } : {}),
  });

  return {
    best: attempt,
    attempts: [attempt],
    accepted: stored.accepted,
    rounds: 0,
    totalMs: Date.now() - started,
    reused: true,
    recipeId: stored.id,
  };
}

export async function generateReviewedAsset(options: AssetLoopOptions): Promise<AssetLoopResult> {
  const started = Date.now();
  const maxRepairs = Math.max(0, Math.min(5, options.maxRepairs ?? 2));
  const passMark = options.passMark ?? 82;
  const category = options.category ?? 'other';

  if (options.reuse !== false) {
    const served = await serveFromLibrary(options);
    if (served) return served;
  }

  const attempts: AssetAttempt[] = [];
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];
  /** The recipe the next round builds: a patched one, or nothing on the first. */
  let pendingRecipe: AssetRecipe | undefined = options.initialRecipe;

  for (let round = 0; round <= maxRepairs; round += 1) {
    if (options.signal?.aborted) break;

    const { recipe, asset } = await authorRecipe(
      pendingRecipe ? { ...options, initialRecipe: pendingRecipe } : options,
      pendingRecipe ? [] : history,
    );

    emitEvent({
      type: 'asset.generated',
      scope: 'generation',
      message: `round ${round}: built "${recipe.name}" (${asset.triangleCount} triangles)`,
      data: { round, name: recipe.name, triangles: asset.triangleCount },
      ...(options.context?.projectId ? { projectId: options.context.projectId } : {}),
    });

    const render = await renderForReview(asset.glb);
    let review;
    try {
      review = await reviewAsset({
        recipe,
        render,
        passMark,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.context ? { context: options.context } : {}),
      });
    } catch (error) {
      // A reviewer that could not be understood must not destroy the rounds
      // that were already paid for and graded. The loop stops here and returns
      // the best attempt it has; only a failure on the very first round, where
      // there is nothing to return, is fatal.
      log.warn('the review failed; keeping the rounds already graded', {
        round,
        error: (error as Error).message,
      });
      if (attempts.length === 0) throw error;
      break;
    }

    const attempt: AssetAttempt = {
      round,
      recipe,
      asset,
      verdict: review.verdict,
      failures: review.failures,
      accepted: review.accepted,
      render,
    };
    attempts.push(attempt);

    if (review.accepted) {
      // Record what the failures of earlier rounds turned out to need, so the
      // next asset that fails the same way starts from the remedy.
      const previous = attempts[attempts.length - 2];
      if (previous) {
        for (const failure of previous.failures.slice(0, 4)) {
          const memory = await recordFailure({ category: 'asset', phase: 'generation', message: failure });
          recordFix({
            signature: memory.signature,
            summary: `Resolved in "${recipe.name}" by revising the recipe; score rose ${previous.verdict.score} → ${review.verdict.score}.`,
            diff: summariseChange(previous.recipe, recipe),
            rationale: review.verdict.summary.slice(0, 3000),
            verifiedBy: 'runtime',
          });
        }
      }
      break;
    }

    if (round === maxRepairs) break;

    // Ask for a patch rather than a rewrite, and apply it here.
    //
    // Demanding the complete corrected recipe made every repair re-emit the
    // whole asset: twenty thousand tokens of unchanged geometry to move three
    // steps, paid for in full, and on anything the size of a car it did not fit
    // in one answer at all — so the repair round could not succeed however many
    // times it was tried.
    try {
      const { data: patch } = await completeJson<RecipePatch>({
        task: 'asset_recipe',
        system: recipeSystemPrompt(),
        schema: RecipePatchSchema as unknown as z.ZodType<RecipePatch, z.ZodTypeDef, unknown>,
        messages: [{ role: 'user', content: recipeRepairPrompt(review.failures, recipe) }],
        maxOutputTokens: 12_000,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.context ? { context: options.context } : {}),
      });
      pendingRecipe = applyRecipePatch(recipe, patch);
      log.info('repair patch applied', {
        round,
        replaced: patch.replaceSteps.length,
        removed: patch.removeStepIds.length,
        reasoning: patch.reasoning.slice(0, 200),
      });
    } catch (error) {
      log.warn('the repair could not be applied; keeping the best attempt so far', {
        round,
        error: (error as Error).message,
      });
      break;
    }
  }

  if (attempts.length === 0) {
    throw new Error('no asset was produced');
  }

  const best = attempts.reduce((a, b) => (b.verdict.score > a.verdict.score ? b : a));
  const accepted = best.accepted;

  // Everything the loop learned goes to the library before it returns: the
  // winning recipe so the next request for this object is free, every round's
  // verdict so the history survives, and the failed criteria so a criterion that
  // keeps failing across unrelated assets becomes visible as a gap in the kernel
  // rather than as one asset's bad luck.
  const recipeId = await persistToLibrary(options, category, attempts, best, accepted);

  log.info('asset loop finished', {
    request: options.request.request.slice(0, 80),
    rounds: attempts.length,
    bestScore: best.verdict.score,
    accepted,
  });

  return {
    best,
    attempts,
    accepted,
    rounds: attempts.length,
    totalMs: Date.now() - started,
    reused: false,
    recipeId,
  };
}

/**
 * Writes the run to the recipe library.
 *
 * Deliberately never throws. A database problem must not destroy an asset that
 * was successfully generated and reviewed; the caller loses the cache entry, is
 * told so in the log, and still gets its GLB.
 */
async function persistToLibrary(
  options: AssetLoopOptions,
  category: string,
  attempts: readonly AssetAttempt[],
  best: AssetAttempt,
  accepted: boolean,
): Promise<string | null> {
  try {
    const recipeId = await rememberRecipe({
      request: options.request.request,
      category,
      recipe: best.recipe,
      triangleCount: best.asset.triangleCount,
      score: best.verdict.score,
      accepted,
      rounds: attempts.length,
      glb: best.asset.glb,
      palette: options.palette,
      seed: options.seed ?? 0,
      ...(options.context?.projectId ? { projectId: options.context.projectId } : {}),
      ...(options.context?.factoryRunId ? { factoryRunId: options.context.factoryRunId } : {}),
    });

    for (const attempt of attempts) {
      recordReviewRound({
        recipeId,
        round: attempt.round,
        score: attempt.verdict.score,
        accepted: attempt.accepted,
        silhouetteReads: attempt.verdict.silhouetteReads,
        summary: attempt.verdict.summary,
        verdict: attempt.verdict,
        failures: attempt.failures,
        triangleCount: attempt.asset.triangleCount,
        viewCount: attempt.render?.views.length ?? 0,
        durationMs: attempt.asset.stats.durationMs,
      });
    }

    // A criterion that failed in one round and passed in a later one is a
    // mistake the repair loop can fix on its own; one that never recovers is
    // the interesting kind, and the two are counted separately.
    const passedLater = new Set<string>();
    for (const attempt of [...attempts].reverse()) {
      for (const criterion of attempt.verdict.criteria) {
        if (criterion.verdict === 'PASS') passedLater.add(criterion.criterion);
      }
      for (const criterion of attempt.verdict.criteria) {
        if (criterion.verdict === 'PASS') continue;
        recordFailureMode(criterion.criterion, {
          category,
          recovered: passedLater.has(criterion.criterion),
        });
      }
      for (const problem of attempt.verdict.additionalProblems) {
        if (problem.severity === 'minor') continue;
        recordFailureMode(problem.problem, {
          category,
          ...(problem.step ? { step: problem.step } : {}),
        });
      }
    }
    return recipeId;
  } catch (error) {
    log.error('the asset was generated but could not be stored in the library', {
      error: (error as Error).message,
    });
    return null;
  }
}

/** A compact description of what changed between two recipes, for the memory. */
function summariseChange(before: AssetRecipe, after: AssetRecipe): string {
  const beforeSteps = new Map(before.steps.map((step) => [step.id, step]));
  const afterSteps = new Map(after.steps.map((step) => [step.id, step]));
  const lines: string[] = [];

  for (const [id, step] of afterSteps) {
    const previous = beforeSteps.get(id);
    if (!previous) {
      lines.push(`+ added step "${id}" (${step.op}): ${step.note}`);
      continue;
    }
    if (JSON.stringify(previous) !== JSON.stringify(step)) {
      lines.push(`~ changed step "${id}" (${step.op}): ${step.note}`);
    }
  }
  for (const [id, step] of beforeSteps) {
    if (!afterSteps.has(id)) lines.push(`- removed step "${id}" (${step.op})`);
  }
  return lines.join('\n').slice(0, 4000) || 'parameters adjusted without structural change';
}
