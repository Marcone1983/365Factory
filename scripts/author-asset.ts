/**
 * Runs the closed asset loop on one request, from the command line.
 *
 * This is the pipeline doing what it was built to do rather than a person
 * typing coordinates: a model writes the brief and the construction, the
 * interpreter builds it, a renderer photographs it under studio light, a vision
 * critic grades it against the brief's own acceptance criteria, and the failures
 * come back as repair instructions. Whatever survives goes to the recipe
 * library, so the same request costs nothing the second time.
 *
 *   npx tsx scripts/author-asset.ts "a cast-iron mooring bollard on a quayside"
 *   npx tsx scripts/author-asset.ts "a fire axe" --category=weapon --rounds=3
 *   npx tsx scripts/author-asset.ts "…" --palette=#8c1230,#101418,#c9d1de
 *
 * Requires ANTHROPIC_API_KEY (or an OpenAI-compatible provider) to be
 * configured. Without one it stops and says so rather than pretending.
 */
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../src/lib/config/env';
import { generateReviewedAsset } from '../src/lib/generation/review/loop';
import { recipeLibraryStats } from '../src/lib/knowledge/recipe-library';
import { recipeExamplePrompt, recipeSystemPrompt } from '../src/lib/generation/recipe/prompt';
import { tokenCost } from '../src/lib/providers/pricing';
import { db } from '../src/lib/db/client';

const args = process.argv.slice(2);
const request = args.find((arg) => !arg.startsWith('--'));
if (!request) {
  throw new Error('usage: author-asset.ts "<what you want>" [--category=prop] [--rounds=2] [--out=var/authored]');
}

const flag = (name: string): string | undefined => args.find((arg) => arg.startsWith(`--${name}=`))?.split('=')[1];

const category = flag('category') ?? 'prop';
const rounds = Number(flag('rounds') ?? 2);
const out = flag('out') ?? path.resolve('var/authored');
const seed = Number(flag('seed') ?? 4242);
const palette = (flag('palette') ?? '#8c1230,#101418,#c9d1de,#f0a500,#8892a0,#555a63,#17171b').split(',');
/** Hard ceiling for this run, in dollars. Refuses to start rather than overrunning. */
const maxUsd = Number(flag('max-usd') ?? 1.5);

/**
 * What this run will cost, before a penny is spent.
 *
 * Nobody should discover the price of a generation from an invoice. The prompt
 * is measurable and the model's rate is known, so the estimate is arithmetic
 * rather than a guess: the only unknown is how long the model's answer runs,
 * and the recipes this pipeline produces have measured between six and nine
 * thousand tokens.
 */
function estimate(rounds: number): { usd: number; perRound: number; promptTokens: number } {
  const cfg = config();
  const promptChars = recipeSystemPrompt().length + recipeExamplePrompt().length + 400;
  // Roughly 3.6 characters per token on prose-with-JSON, measured on this
  // project's own prompts.
  const promptTokens = Math.round(promptChars / 3.6);
  const author = tokenCost(cfg.ANTHROPIC_MODEL_BALANCED, promptTokens, 8000).costUsd;
  // The critic reads six renders; an image of this size runs about 1,500 tokens.
  const review = tokenCost(cfg.ANTHROPIC_MODEL_BALANCED, 9000 + 4000, 2500).costUsd;
  const perRound = author + review;
  return { usd: perRound * (rounds + 1), perRound, promptTokens };
}

function spentToday(): number {
  const row = db()
    .prepare<[], { total: number | null }>(
      "SELECT SUM(cost_usd) AS total FROM api_usage WHERE ts >= date('now') || 'T00:00:00.000Z'",
    )
    .get();
  return row?.total ?? 0;
}

async function main(): Promise<void> {
  const cfg = config();
  if (!cfg.ANTHROPIC_API_KEY && !cfg.OPENAI_API_KEY) {
    // The whole point of the loop is that a model authors and a critic looks.
    // Neither can happen without a provider, and producing something anyway
    // would be the pipeline lying about what it did.
    process.stderr.write(
      'No LLM provider is configured, so nothing can author a recipe and nothing can review a render.\n' +
        'Set ANTHROPIC_API_KEY (see .env.example) and run this again.\n',
    );
    process.exitCode = 1;
    return;
  }

  const forecast = estimate(rounds);
  const already = spentToday();
  process.stdout.write(
    `estimate: about $${forecast.usd.toFixed(2)} for ${rounds + 1} round(s) — ` +
      `$${forecast.perRound.toFixed(2)} each, on ${cfg.ANTHROPIC_MODEL_BALANCED}, ` +
      `${forecast.promptTokens} prompt tokens.\n` +
      `already spent today: $${already.toFixed(2)} of a $${cfg.LLM_DAILY_COST_BUDGET_USD.toFixed(2)} cap.\n`,
  );

  if (forecast.usd > maxUsd) {
    process.stderr.write(
      `Refusing to start: the estimate exceeds the --max-usd ceiling of $${maxUsd.toFixed(2)}.\n` +
        `Raise it deliberately if that is what you want to spend.\n`,
    );
    process.exitCode = 1;
    return;
  }

  fs.mkdirSync(out, { recursive: true });
  process.stdout.write(`authoring "${request}" as a ${category}…\n`);

  const result = await generateReviewedAsset({
    request: { request: request as string, palette },
    palette,
    seed,
    category,
    maxRepairs: rounds,
  });

  for (const attempt of result.attempts) {
    const verdict = attempt.verdict;
    process.stdout.write(
      `\nround ${attempt.round}: ${Math.round(verdict.score)}/100 ${attempt.accepted ? '— accepted' : '— rejected'}\n` +
        `  ${verdict.summary}\n`,
    );
    for (const criterion of verdict.criteria) {
      process.stdout.write(`  [${criterion.verdict.padEnd(7)}] ${criterion.criterion}\n`);
      if (criterion.verdict !== 'PASS') process.stdout.write(`            observed: ${criterion.observation}\n`);
    }
  }

  const { best } = result;
  const glb = path.join(out, `${best.recipe.name}.glb`);
  const json = path.join(out, `${best.recipe.name}.recipe.json`);
  fs.writeFileSync(glb, best.asset.glb);
  fs.writeFileSync(json, JSON.stringify(best.recipe, null, 2));

  // The renders the critic actually looked at, so its verdict can be checked
  // against the same pictures rather than taken on trust.
  best.render?.views.forEach((view, index) => {
    fs.writeFileSync(path.join(out, `${best.recipe.name}-${index}-${view.kind}-${view.label}.png`), view.png);
  });

  const spent = spentToday() - already;
  const stats = recipeLibraryStats();
  process.stdout.write(`\nthis run actually cost $${spent.toFixed(2)}\n`);
  process.stdout.write(
    `\n${result.reused ? 'reused from the library' : `authored in ${result.rounds} round(s)`} · ` +
      `${Math.round(best.verdict.score)}/100 · ${best.asset.triangleCount} triangles · ` +
      `${best.recipe.steps.length} steps · ${(result.totalMs / 1000).toFixed(1)}s\n` +
      `written to ${glb}\n` +
      `library now holds ${stats.recipes} recipe(s), ${stats.accepted} accepted, ${stats.totalReuse} reuse(s)\n`,
  );
}

void main();
