import { z } from 'zod';
import { completeJson } from '@/lib/ai/router';
import { createLogger } from '@/lib/observability/logger';
import { emitEvent } from '@/lib/observability/events';
import type { LLMImage } from '@/lib/providers/types';
import type { AssetRecipe } from '../recipe/schema';
import type { AssetView, RenderReviewResult } from './render';

const log = createLogger('generation.review.critic');

/**
 * Judges a rendered asset against the brief that specified it.
 *
 * This is the step that turns the pipeline from open-loop into closed-loop.
 * Everything before it could produce a confident, well-formed, entirely wrong
 * object and nothing would notice. The critic looks at the render and answers,
 * one acceptance criterion at a time, whether it is actually there.
 *
 * Two properties make the verdict useful rather than decorative:
 *
 *  - It grades against criteria the *recipe author* wrote, in advance, to be
 *    checkable by looking. A critic asked "is this good?" produces agreeable
 *    noise; a critic asked "is the bulb visible through the glazing?" produces
 *    a fact.
 *  - It must attribute each failure to a step. The recipe's step notes say what
 *    every part depicts, so the failure comes back as "the housing does not
 *    read as a separate mass — step `housing`", which is a repairable
 *    instruction rather than a complaint.
 */

/**
 * Normalises a verdict before it is validated.
 *
 * A reviewer that graded every criterion correctly and called the field
 * `otherProblems` instead of `additionalProblems`, or wrote its prose into the
 * notes and left `summary` empty, has done the job. Rejecting that costs a
 * complete re-review — the images go up again, the model reads them again, and
 * the caller pays again — to obtain a word that was already on the page.
 * Measured on this project: three rounds, sixty-four cents, for a missing
 * summary.
 *
 * So the shape is repaired where the meaning is unambiguous, and only where it
 * is unambiguous. A missing score or a missing criteria list is not repaired,
 * because inventing either would be inventing the review itself.
 */
function normaliseVerdict(value: unknown): unknown {
  if (typeof value !== 'object' || value === null) return value;
  const raw = { ...(value as Record<string, unknown>) };

  if (raw.additionalProblems === undefined && raw.otherProblems !== undefined) {
    raw.additionalProblems = raw.otherProblems;
  }
  if (raw.silhouetteNotes === undefined && typeof raw.silhouette === 'string') {
    raw.silhouetteNotes = raw.silhouette;
  }

  if (typeof raw.summary !== 'string' || raw.summary.trim().length === 0) {
    // Built from what the reviewer did write: the criteria it failed, which is
    // what a summary of a review is for.
    const criteria = Array.isArray(raw.criteria) ? (raw.criteria as Array<Record<string, unknown>>) : [];
    const failed = criteria
      .filter((entry) => entry?.verdict !== 'PASS')
      .map((entry) => String(entry?.criterion ?? ''))
      .filter(Boolean);
    const notes = typeof raw.silhouetteNotes === 'string' ? raw.silhouetteNotes : '';
    raw.summary =
      failed.length > 0
        ? `${failed.length} of ${criteria.length} acceptance criteria were not met: ${failed.join('; ')}`
        : notes || 'Every acceptance criterion was met.';
  }
  return raw;
}

const VerdictShape = z.object({
  /** One entry per acceptance criterion, in the order they were given. */
  criteria: z
    .array(
      z.object({
        criterion: z.string(),
        /**
         * Three states, not two.
         *
         * A reviewer asked for a boolean on "the butt flares wider than the
         * waist" answers PARTIAL when the flare is there and too slight to
         * read, which is a different fact from absent and calls for a different
         * repair. Forcing it into a boolean threw that away — and, because the
         * model kept writing the three-state answer anyway, made the contract
         * fail and the whole review regenerate at the caller's expense.
         */
        verdict: z.enum(['PASS', 'FAIL', 'PARTIAL']),
        /** What was actually observed. Required whether it passed or not. */
        observation: z.string(),
      }),
    )
    .min(1),
  /** Features from mustRead that cannot be found in any view. */
  missingFeatures: z.array(z.string()).default([]),
  /** Problems the criteria did not anticipate. */
  additionalProblems: z
    .array(
      z.object({
        problem: z.string(),
        /** The step id most likely responsible, when identifiable. */
        step: z.string().optional(),
        severity: z.enum(['minor', 'significant', 'severe']),
      }),
    )
    .default([]),
  /** Whether the silhouette reads as the described object. */
  silhouetteReads: z.boolean(),
  silhouetteNotes: z.string(),
  /** 0-100. Below `passMark` the asset goes back for repair. */
  score: z.number().min(0).max(100),
  summary: z.string(),
});

export const VerdictSchema = z.preprocess(normaliseVerdict, VerdictShape);

export type AssetVerdict = z.infer<typeof VerdictShape>;

export interface ReviewOutcome {
  readonly verdict: AssetVerdict;
  readonly accepted: boolean;
  /** Repair instructions, ready to feed back to the recipe author. */
  readonly failures: readonly string[];
}

const SYSTEM = `You are a senior 3D art director reviewing a generated asset before it goes into a game.

You are shown renders of one asset: several lit three-quarter, front, side and overhead views, and one or two flat black silhouettes against white. You are also given the brief the asset was built to and the list of steps that built it.

HOW TO REVIEW

Work through the acceptance criteria one at a time, in order. For each one, look for the thing it describes and answer PASS, FAIL or PARTIAL. PARTIAL is for a form that is present but too slight to read at the distance the brief specifies — a flare that exists and cannot be seen is a different fault from one that is missing, and it asks for a different repair. Record what you observed either way: a criterion you passed without looking at is worse than useless.

Then check the mustRead features. Any that you cannot find in any view goes in missingFeatures.

Then look at the silhouette on its own. Recognition of an object happens mostly at the outline: if the silhouette does not read as the subject, the asset fails regardless of how it looks lit. A lit render hides a bad shape behind material detail; the silhouette does not.

Then note problems the criteria did not anticipate — intersecting parts, floating parts, parts at the wrong scale relative to each other, surfaces that should be flat and are not, features that read as a different object entirely.

ATTRIBUTING FAILURES

Each step's note says what that part depicts. When something is wrong, name the step responsible. "The housing does not separate from the post — step housing" can be repaired; "it looks off" cannot.

BEING USEFUL

- Be specific and physical. "The post is the same thickness top and bottom" beats "the proportions are wrong".
- Judge against the brief, not against your own taste. If the brief asks for a stylised object, do not fail it for not being photoreal.
- Do not pass something because it is close. This asset ships into a game; a reviewer who waves things through is why generated content looks generated.
- Do not fail something for a quality the brief did not ask for.
- Score honestly. 90+ means it satisfies the brief and would not embarrass anyone. 70-89 means it reads correctly with visible flaws. Below 70 means it does not yet depict what was asked for.`;

export interface ReviewInput {
  readonly recipe: AssetRecipe;
  readonly render: RenderReviewResult;
  /** Score at or above which the asset is accepted. */
  readonly passMark?: number;
  readonly signal?: AbortSignal;
  readonly context?: { projectId?: string; factoryRunId?: string };
}

function toImages(views: readonly AssetView[]): LLMImage[] {
  return views.map((view) => ({
    data: view.png,
    mimeType: 'image/png' as const,
    caption:
      view.kind === 'silhouette'
        ? `Silhouette, ${view.label.replace('-silhouette', '')} view — judge the outline only.`
        : `Lit view: ${view.label}.`,
  }));
}

function describeRecipe(recipe: AssetRecipe): string {
  return [
    `SUBJECT: ${recipe.brief.subject}`,
    `STYLE: ${recipe.brief.style}`,
    `PURPOSE: ${recipe.brief.purpose}`,
    '',
    'MUST READ (features that have to be recognisable):',
    ...recipe.brief.mustRead.map((feature, index) => `  ${index + 1}. ${feature}`),
    '',
    `SILHOUETTE THE BRIEF ASKS FOR: ${recipe.brief.silhouette}`,
    '',
    'PROPORTIONS:',
    ...recipe.brief.proportions.map((line) => `  - ${line}`),
    '',
    `SURFACE: ${recipe.brief.surfaceNotes}`,
    '',
    'MISTAKES TO WATCH FOR (the brief explicitly says to avoid these):',
    ...recipe.brief.avoid.map((line) => `  - ${line}`),
    '',
    'ACCEPTANCE CRITERIA — grade each of these in order:',
    ...recipe.brief.acceptance.map((line, index) => `  ${index + 1}. ${line}`),
    '',
    'STEPS THAT BUILT IT (use these ids when attributing a failure):',
    ...recipe.steps.map((step) => `  ${step.id} (${step.op}): ${step.note}`),
  ].join('\n');
}

export async function reviewAsset(input: ReviewInput): Promise<ReviewOutcome> {
  const { recipe, render } = input;
  const passMark = input.passMark ?? 82;

  const measured = [
    `MEASURED FROM THE FILE (facts, not opinions):`,
    `  bounding box: ${render.measured.sizeMetres.x} x ${render.measured.sizeMetres.y} x ${render.measured.sizeMetres.z} metres`,
    `  requested size: ${recipe.targetSize.join(' x ')} metres`,
    `  triangles: ${render.measured.triangles}, materials: ${render.measured.materials}, textures: ${render.measured.textures}`,
  ].join('\n');

  const { data: verdict } = await completeJson({
    task: 'asset_review',
    system: SYSTEM,
    schema: VerdictSchema as unknown as z.ZodType<AssetVerdict, z.ZodTypeDef, unknown>,
    messages: [
      {
        role: 'user',
        content: `${describeRecipe(recipe)}\n\n${measured}\n\nGrade every acceptance criterion in order, then report anything else that is wrong.`,
        images: toImages(render.views),
      },
    ],
    // One observation per criterion, in prose, for up to twelve criteria plus a
    // summary: the review is longer than it looks, and a verdict cut off halfway
    // is unrecoverable rather than repairable.
    maxOutputTokens: 9_000,
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.context ? { context: input.context } : {}),
  });

  const failures: string[] = [];
  for (const entry of verdict.criteria) {
    if (entry.verdict !== 'PASS') {
      // PARTIAL is reported as what it is: the form is present and too weak to
      // read, which asks the author to strengthen it rather than to add it.
      const lead = entry.verdict === 'PARTIAL' ? 'Acceptance criterion only partly met' : 'Acceptance criterion not met';
      failures.push(`${lead} — ${entry.criterion}. Observed: ${entry.observation}`);
    }
  }
  for (const feature of verdict.missingFeatures) {
    failures.push(`Required feature is absent from every view: ${feature}`);
  }
  for (const problem of verdict.additionalProblems) {
    if (problem.severity === 'minor') continue;
    failures.push(
      `${problem.severity === 'severe' ? 'Severe' : 'Significant'} problem${problem.step ? ` in step "${problem.step}"` : ''}: ${problem.problem}`,
    );
  }
  if (!verdict.silhouetteReads) {
    failures.push(`The silhouette does not read as the subject: ${verdict.silhouetteNotes}`);
  }

  // A render that threw is a defect in the asset, not in the reviewer.
  for (const error of render.runtimeErrors.slice(0, 3)) {
    failures.push(`The asset produced a runtime error when loaded: ${error}`);
  }

  const accepted = verdict.score >= passMark && failures.length === 0;

  log.info('asset reviewed', { name: recipe.name, score: verdict.score, accepted, failures: failures.length });
  emitEvent({
    type: 'asset.generated',
    scope: 'generation.review',
    message: `${recipe.name} scored ${verdict.score}/100 — ${accepted ? 'accepted' : `${failures.length} failures`}`,
    data: { name: recipe.name, score: verdict.score, accepted, failures: failures.length },
    ...(input.context?.projectId ? { projectId: input.context.projectId } : {}),
  });

  return { verdict, accepted, failures };
}
