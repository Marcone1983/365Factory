import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTestEnvironment, type TestEnvironment } from './helpers/env';
import {
  bestVerdictFor,
  exemplarRecipes,
  failureSignature,
  normaliseRequest,
  recallRecipe,
  recipeLibraryStats,
  recordFailureMode,
  recordReviewRound,
  rememberRecipe,
  renderFailureModesForPrompt,
  requestHash,
  reviewHistory,
  topFailureModes,
} from '@/lib/knowledge/recipe-library';
import { STREET_LANTERN } from '@/lib/generation/recipe/examples';
import type { AssetRecipe } from '@/lib/generation/recipe/schema';

let env: TestEnvironment;

beforeEach(() => {
  env = createTestEnvironment();
});

afterEach(() => {
  env.cleanup();
});

/**
 * The recipe library is what makes the second request for an object free, and
 * what carries a lesson from one asset to the next. Two properties decide
 * whether it is an asset or a liability: a hit must be the object that was
 * asked for, and a worse run must never overwrite a better one.
 */

const GLB = Buffer.from('glb-bytes-for-the-test');

function stored(name: string): AssetRecipe {
  return { ...STREET_LANTERN, name };
}

async function remember(
  request: string,
  options: { score: number; accepted: boolean; category?: string; name?: string } = { score: 90, accepted: true },
): Promise<string> {
  return rememberRecipe({
    request,
    ...(options.category ? { category: options.category } : {}),
    recipe: stored(options.name ?? 'street_lantern'),
    triangleCount: 7128,
    score: options.score,
    accepted: options.accepted,
    rounds: 1,
    glb: GLB,
    palette: ['#101010', '#ffffff'],
    seed: 7,
  });
}

describe('request identity', () => {
  it('collapses phrasings that ask for the same thing', () => {
    expect(normaliseRequest('Please generate a Victorian street lantern!')).toBe('victorian street lantern');
    expect(normaliseRequest('A Victorian street lantern.')).toBe('victorian street lantern');
    expect(requestHash('Create a cast-iron street lantern', 'prop')).toBe(
      requestHash('  cast-iron   street lantern ', 'prop'),
    );
  });

  it('does not collapse requests that differ in substance', () => {
    expect(requestHash('a red sports car', 'vehicle')).not.toBe(requestHash('a red sports car door', 'vehicle'));
  });

  it('keeps categories apart, so a "scout" character never answers a "scout" vehicle', () => {
    expect(requestHash('a scout', 'character')).not.toBe(requestHash('a scout', 'vehicle'));
  });
});

describe('storing and recalling recipes', () => {
  it('serves a stored recipe back for the same request', async () => {
    await remember('a Victorian cast-iron street lantern', { score: 91, accepted: true, category: 'prop' });

    const hit = await recallRecipe({ request: 'A Victorian cast-iron street lantern.', category: 'prop' });
    expect(hit).not.toBeNull();
    expect(hit?.matchedBy).toBe('request');
    expect(hit?.recipe.steps.length).toBe(STREET_LANTERN.steps.length);
    expect(hit?.recipe.brief.subject).toBe(STREET_LANTERN.brief.subject);
  });

  it('counts every reuse, so the saving the library produces is measurable', async () => {
    await remember('a street lantern', { score: 88, accepted: true, category: 'prop' });
    await recallRecipe({ request: 'a street lantern', category: 'prop' });
    await recallRecipe({ request: 'a street lantern', category: 'prop' });

    expect(recipeLibraryStats().totalReuse).toBe(2);
  });

  it('refuses to serve a recipe that scored below the bar', async () => {
    await remember('a wobbly lantern', { score: 44, accepted: false, category: 'prop' });
    expect(await recallRecipe({ request: 'a wobbly lantern', category: 'prop' })).toBeNull();
  });

  it('does not answer one category from another', async () => {
    await remember('a scout', { score: 95, accepted: true, category: 'character' });
    expect(await recallRecipe({ request: 'a scout', category: 'vehicle' })).toBeNull();
  });

  it('keeps the better recipe when a later run scores worse', async () => {
    const first = await remember('a lantern', { score: 93, accepted: true, name: 'good_lantern', category: 'prop' });
    const second = await remember('a lantern', { score: 61, accepted: false, name: 'bad_lantern', category: 'prop' });

    expect(second).toBe(first);
    const hit = await recallRecipe({ request: 'a lantern', category: 'prop' });
    expect(hit?.name).toBe('good_lantern');
    expect(hit?.score).toBe(93);
  });

  it('replaces the stored recipe when a later run scores better', async () => {
    await remember('a lantern', { score: 71, accepted: false, name: 'first_try', category: 'prop' });
    await remember('a lantern', { score: 96, accepted: true, name: 'second_try', category: 'prop' });

    const hit = await recallRecipe({ request: 'a lantern', category: 'prop' });
    expect(hit?.name).toBe('second_try');
    expect(hit?.accepted).toBe(true);
    expect(recipeLibraryStats().recipes).toBe(1);
  });
});

describe('review history', () => {
  it('keeps every round, including the ones that were superseded', async () => {
    const id = await remember('a lantern', { score: 90, accepted: true, category: 'prop' });

    for (const [round, score] of [
      [0, 58],
      [1, 74],
      [2, 90],
    ] as const) {
      recordReviewRound({
        recipeId: id,
        round,
        score,
        accepted: score >= 82,
        silhouetteReads: score >= 74,
        summary: `round ${round}`,
        verdict: { score, criteria: [], summary: `round ${round}` },
        failures: score >= 82 ? [] : [`round ${round} failed`],
        triangleCount: 7128,
        viewCount: 6,
        durationMs: 120,
      });
    }

    const history = reviewHistory(id);
    expect(history.map((entry) => entry.round)).toEqual([0, 1, 2]);
    expect(history[0]?.failures).toEqual(['round 0 failed']);

    const best = bestVerdictFor(id);
    expect(best?.round).toBe(2);
    expect((best?.verdict as { score: number }).score).toBe(90);
  });
});

describe('failure modes', () => {
  it('groups the same complaint across different assets and different numbers', () => {
    expect(failureSignature('the post is not visibly thicker at the bottom (measured 12mm vs 13mm)')).toBe(
      failureSignature('the post is not visibly thicker at the bottom (measured 40 mm vs 41 mm)'),
    );
  });

  it('separates complaints that are genuinely different', () => {
    expect(failureSignature('the wheels are lying flat against the road')).not.toBe(
      failureSignature('the glazing is too dark to see the bulb through'),
    );
  });

  it('counts recurrences and recoveries separately', () => {
    recordFailureMode('the wheels are parallel to the road surface', { category: 'vehicle', step: 'wheel' });
    recordFailureMode('the wheels are parallel to the road surface', { category: 'vehicle', step: 'wheel' });
    recordFailureMode('the wheels are parallel to the road surface', { category: 'vehicle', recovered: true });

    const modes = topFailureModes(5);
    expect(modes).toHaveLength(1);
    expect(modes[0]?.occurrences).toBe(2);
    expect(modes[0]?.recoveries).toBe(1);
  });

  it('warns the author only about mistakes that have actually recurred', () => {
    recordFailureMode('a one-off complaint about this specific lamp');
    expect(renderFailureModesForPrompt(topFailureModes(5))).toBe('');

    recordFailureMode('the body is so wide the wheels are hidden', { category: 'vehicle' });
    recordFailureMode('the body is so wide the wheels are hidden', { category: 'vehicle' });
    const rendered = renderFailureModesForPrompt(topFailureModes(5));
    expect(rendered).toContain('the body is so wide the wheels are hidden');
    expect(rendered).not.toContain('a one-off complaint');
  });
});

describe('exemplars', () => {
  it('offers only work that passed review, best first', async () => {
    await remember('a lantern', { score: 96, accepted: true, name: 'excellent', category: 'prop' });
    await remember('a bollard', { score: 88, accepted: true, name: 'good', category: 'prop' });
    await remember('a bin', { score: 70, accepted: false, name: 'rejected', category: 'prop' });

    const examples = exemplarRecipes({ category: 'prop', limit: 5 });
    expect(examples.map((example) => example.name)).toEqual(['excellent', 'good']);
  });

  it('falls back to other categories so a new category still gets a worked example', async () => {
    await remember('a lantern', { score: 96, accepted: true, name: 'excellent', category: 'prop' });
    const examples = exemplarRecipes({ category: 'aircraft', limit: 2 });
    expect(examples.map((example) => example.name)).toEqual(['excellent']);
  });
});

describe('library statistics', () => {
  it('reports what the library holds, per category', async () => {
    await remember('a lantern', { score: 90, accepted: true, category: 'prop' });
    await remember('a hypercar', { score: 84, accepted: true, category: 'vehicle' });
    await remember('a hatchback', { score: 60, accepted: false, category: 'vehicle' });

    const stats = recipeLibraryStats();
    expect(stats.recipes).toBe(3);
    expect(stats.accepted).toBe(2);
    expect(stats.byCategory.find((entry) => entry.category === 'vehicle')?.count).toBe(2);
  });
});
