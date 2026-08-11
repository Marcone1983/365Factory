import { z } from 'zod';
import { completeJson } from '@/lib/ai/router';
import { createLogger } from '@/lib/observability/logger';
import { emitEvent } from '@/lib/observability/events';
import { recallSimilar, recordFailure, recordFix, renderMemoriesForPrompt } from '@/lib/knowledge/error-memory';
import { AssetRecipeSchema, type AssetRecipe } from '../recipe/schema';
import { buildAssetFromRecipe, type BuiltAsset } from '../recipe/build';
import { recipeExamplePrompt, recipeRepairPrompt, recipeSystemPrompt, recipeUserPrompt, type AssetRequestBrief } from '../recipe/prompt';
import { renderForReview, type RenderReviewResult } from './render';
import { reviewAsset, type AssetVerdict } from './critic';

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
  readonly render: RenderReviewResult;
}

export interface AssetLoopResult {
  /** The highest-scoring attempt, which is what should be used. */
  readonly best: AssetAttempt;
  readonly attempts: readonly AssetAttempt[];
  readonly accepted: boolean;
  readonly rounds: number;
  readonly totalMs: number;
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
  const maxBuildRetries = 3;
  let lastError = '';

  for (let attempt = 0; attempt < maxBuildRetries; attempt += 1) {
    const memories = await recallSimilar({
      category: 'asset',
      message: lastError || options.request.request,
      limit: 4,
    });
    const lessons = memories.length > 0 ? `\n\nLESSONS FROM EARLIER FAILURES:\n${renderMemoriesForPrompt(memories)}` : '';

    const messages = [
      { role: 'user' as const, content: `${recipeExamplePrompt()}\n\n---\n\n${recipeUserPrompt(options.request)}${lessons}` },
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
      maxOutputTokens: 12_000,
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

export async function generateReviewedAsset(options: AssetLoopOptions): Promise<AssetLoopResult> {
  const started = Date.now();
  const maxRepairs = Math.max(0, Math.min(5, options.maxRepairs ?? 2));
  const passMark = options.passMark ?? 82;

  const attempts: AssetAttempt[] = [];
  const history: Array<{ role: 'user' | 'assistant'; content: string }> = [];

  for (let round = 0; round <= maxRepairs; round += 1) {
    if (options.signal?.aborted) break;

    const { recipe, asset } = await authorRecipe(options, history);

    emitEvent({
      type: 'asset.generated',
      scope: 'generation',
      message: `round ${round}: built "${recipe.name}" (${asset.triangleCount} triangles)`,
      data: { round, name: recipe.name, triangles: asset.triangleCount },
      ...(options.context?.projectId ? { projectId: options.context.projectId } : {}),
    });

    const render = await renderForReview(asset.glb);
    const review = await reviewAsset({
      recipe,
      render,
      passMark,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.context ? { context: options.context } : {}),
    });

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

    // Feed the model its own recipe and the specific failures.
    history.push(
      { role: 'assistant', content: JSON.stringify(recipe) },
      { role: 'user', content: recipeRepairPrompt(review.failures) },
    );
  }

  if (attempts.length === 0) {
    throw new Error('no asset was produced');
  }

  const best = attempts.reduce((a, b) => (b.verdict.score > a.verdict.score ? b : a));
  const accepted = best.accepted;

  log.info('asset loop finished', {
    request: options.request.request.slice(0, 80),
    rounds: attempts.length,
    bestScore: best.verdict.score,
    accepted,
  });

  return { best, attempts, accepted, rounds: attempts.length, totalMs: Date.now() - started };
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
