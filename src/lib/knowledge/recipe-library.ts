import crypto from 'node:crypto';
import { db, fromJson, newId, nowIso } from '@/lib/db/client';
import { attachEmbedding, embedTexts, searchSimilar } from './embeddings';
import { getEmbeddingProvider } from '@/lib/providers/registry';
import { createLogger } from '@/lib/observability/logger';
import { counter } from '@/lib/observability/metrics';
import { AssetRecipeSchema, type AssetRecipe } from '@/lib/generation/recipe/schema';

const log = createLogger('knowledge.recipe-library');

/**
 * The recipe library: durable memory of every asset the factory has authored.
 *
 * Three distinct jobs, all of which used to be paid for again on every run:
 *
 *  1. **Reuse.** A request for an object the factory has already worked out is
 *     answered from the library. The stored recipe rebuilds to the same mesh in
 *     milliseconds, for any palette, at no API cost. This is the single largest
 *     saving in the asset pipeline, because authoring a recipe is a long
 *     structured generation and reviewing it costs vision calls on top.
 *
 *  2. **Examples.** The recipes that scored highest are shown to the author as
 *     worked references. The prompt therefore improves as the library grows,
 *     rather than being frozen at whatever three examples were hand-written.
 *
 *  3. **Failure statistics.** A criterion that fails across many unrelated
 *     assets is not a fact about one asset; it is a missing operator or a gap in
 *     the authoring instructions. Counting them is what turns individual
 *     rejections into a change to this codebase.
 *
 * The recipe is stored, not the GLB. It is two orders of magnitude smaller, it
 * rebuilds deterministically, and — unlike a binary — a later model can read it
 * and adapt it.
 */

// --------------------------------------------------------------- identity --

/**
 * Normalises a request so trivially different phrasings share a cache key.
 * Deliberately conservative: it lowercases, collapses whitespace and strips
 * punctuation and leading politeness, and stops there. Anything more aggressive
 * (stemming, stop-word removal) risks collapsing "a red car" and "a red car
 * door" onto one key, and returning the wrong asset is far worse than missing a
 * cache hit — the semantic lookup exists to catch the near-misses safely.
 */
export function normaliseRequest(request: string): string {
  let text = request.toLowerCase();

  // Strip the whole run of leading politeness and imperatives, not just the
  // first word: "please generate a …" and "a …" must reach the same key.
  let previous = '';
  while (previous !== text) {
    previous = text;
    text = text.replace(
      /^\s*(please|kindly|can you|could you|i need|i want|i would like|generate|create|make|build|model|design|give me|a|an|the)\s+/,
      ' ',
    );
  }

  return (
    text
      // A full stop or hyphen only carries meaning between characters:
      // "cast-iron" and "1.5m" must survive, a trailing "." must not change the
      // key, or the same request typed with and without punctuation misses.
      .replace(/(?<![\p{L}\p{N}])[.-]|[.-](?![\p{L}\p{N}])/gu, ' ')
      .replace(/[^\p{L}\p{N}\s.-]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

export function requestHash(request: string, category: string): string {
  return crypto.createHash('sha256').update(`${category} ${normaliseRequest(request)}`).digest('hex').slice(0, 40);
}

// ------------------------------------------------------------------ types --

export interface StoredRecipe {
  readonly id: string;
  readonly requestHash: string;
  readonly request: string;
  readonly category: string;
  readonly name: string;
  readonly subject: string;
  readonly recipe: AssetRecipe;
  readonly stepCount: number;
  readonly triangleCount: number;
  readonly score: number;
  readonly accepted: boolean;
  readonly rounds: number;
  readonly glbSha256: string;
  readonly glbBytes: number;
  readonly palette: readonly string[];
  readonly seed: number;
  readonly reuseCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface RecalledRecipe extends StoredRecipe {
  /** 1 for an exact request match, otherwise the semantic similarity. */
  readonly relevance: number;
  readonly matchedBy: 'request' | 'semantic';
}

interface RecipeRow {
  id: string;
  request_hash: string;
  request: string;
  category: string;
  name: string;
  subject: string;
  brief: string;
  recipe: string;
  step_count: number;
  triangle_count: number;
  score: number;
  accepted: number;
  rounds: number;
  glb_sha256: string;
  glb_bytes: number;
  palette: string;
  seed: number;
  embedding_id: string | null;
  reuse_count: number;
  project_id: string | null;
  factory_run_id: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Parses a stored row back into a recipe.
 *
 * Returns null when the stored JSON no longer satisfies the current schema,
 * which happens legitimately when the schema is tightened. A stale row is
 * skipped rather than thrown on: the caller loses a cache hit and authors a
 * fresh recipe, which is the correct outcome. Failing the request because an
 * old row exists would be the schema change breaking the product.
 */
function toStored(row: RecipeRow): StoredRecipe | null {
  const parsed = AssetRecipeSchema.safeParse(fromJson<unknown>(row.recipe, null));
  if (!parsed.success) {
    log.debug('a stored recipe no longer validates against the current schema; ignoring it', {
      id: row.id,
      name: row.name,
      problem: parsed.error.issues[0]?.message ?? 'unknown',
    });
    return null;
  }
  return {
    id: row.id,
    requestHash: row.request_hash,
    request: row.request,
    category: row.category,
    name: row.name,
    subject: row.subject,
    recipe: parsed.data,
    stepCount: row.step_count,
    triangleCount: row.triangle_count,
    score: row.score,
    accepted: row.accepted === 1,
    rounds: row.rounds,
    glbSha256: row.glb_sha256,
    glbBytes: row.glb_bytes,
    palette: fromJson<string[]>(row.palette, []),
    seed: row.seed,
    reuseCount: row.reuse_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** The text the semantic index is built from: what the asset *is*, not how it was asked for. */
function indexText(request: string, recipe: AssetRecipe): string {
  return [
    recipe.brief.subject,
    request,
    recipe.brief.style,
    recipe.brief.mustRead.join('; '),
  ]
    .join('\n')
    .slice(0, 2000);
}

// ------------------------------------------------------------- persistence --

export interface RememberRecipeInput {
  readonly request: string;
  readonly category?: string;
  readonly recipe: AssetRecipe;
  readonly triangleCount: number;
  readonly score: number;
  readonly accepted: boolean;
  readonly rounds: number;
  readonly glb: Buffer;
  readonly palette: readonly string[];
  readonly seed: number;
  readonly projectId?: string;
  readonly factoryRunId?: string;
}

/**
 * Stores a finished recipe, or replaces the stored one when this attempt scored
 * better.
 *
 * A worse attempt at a request the library already answers well is *not*
 * written over the better one — otherwise a single unlucky run would poison a
 * cache entry that had been earned over several rounds. The review rows are
 * recorded either way, because a worse attempt is still evidence.
 */
export async function rememberRecipe(input: RememberRecipeInput): Promise<string> {
  const database = db();
  const category = input.category ?? 'other';
  const hash = requestHash(input.request, category);
  const now = nowIso();
  const sha = crypto.createHash('sha256').update(input.glb).digest('hex');

  const existing = database
    .prepare<[string], RecipeRow>('SELECT * FROM asset_recipes WHERE request_hash = ?')
    .get(hash);

  if (existing) {
    if (input.score <= existing.score) {
      log.debug('kept the stored recipe; this attempt did not beat it', {
        name: input.recipe.name,
        stored: existing.score,
        attempt: input.score,
      });
      counter('recipe_library.kept_existing', { category });
      return existing.id;
    }
    database
      .prepare(
        `UPDATE asset_recipes SET name = ?, subject = ?, brief = ?, recipe = ?, step_count = ?,
           triangle_count = ?, score = ?, accepted = ?, rounds = ?, glb_sha256 = ?, glb_bytes = ?,
           palette = ?, seed = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        input.recipe.name,
        input.recipe.brief.subject,
        JSON.stringify(input.recipe.brief),
        JSON.stringify(input.recipe),
        input.recipe.steps.length,
        Math.round(input.triangleCount),
        input.score,
        input.accepted ? 1 : 0,
        input.rounds,
        sha,
        input.glb.length,
        JSON.stringify(input.palette),
        input.seed,
        now,
        existing.id,
      );
    counter('recipe_library.improved', { category });
    log.info('a better recipe replaced the stored one', {
      name: input.recipe.name,
      from: existing.score,
      to: input.score,
    });
    return existing.id;
  }

  const id = newId('rcp');
  database
    .prepare(
      `INSERT INTO asset_recipes (id, request_hash, request, category, name, subject, brief, recipe,
         step_count, triangle_count, score, accepted, rounds, glb_sha256, glb_bytes, palette, seed,
         project_id, factory_run_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      hash,
      input.request.slice(0, 4000),
      category,
      input.recipe.name,
      input.recipe.brief.subject,
      JSON.stringify(input.recipe.brief),
      JSON.stringify(input.recipe),
      input.recipe.steps.length,
      Math.round(input.triangleCount),
      input.score,
      input.accepted ? 1 : 0,
      input.rounds,
      sha,
      input.glb.length,
      JSON.stringify(input.palette),
      input.seed,
      input.projectId ?? null,
      input.factoryRunId ?? null,
      now,
      now,
    );

  // Index what the asset is, so a differently-worded request for the same
  // object finds it. Failure here costs the semantic hit, not the row.
  try {
    const text = indexText(input.request, input.recipe);
    const [vector] = await embedTexts([text], {
      ownerType: 'recipe',
      ...(input.projectId ? { projectId: input.projectId } : {}),
    });
    if (vector) {
      const embeddingId = attachEmbedding('recipe', id, text, vector, getEmbeddingProvider().name);
      database.prepare('UPDATE asset_recipes SET embedding_id = ? WHERE id = ?').run(embeddingId, id);
    }
  } catch (error) {
    log.warn('could not index a recipe for semantic reuse; exact-request reuse still applies', {
      error: (error as Error).message,
    });
  }

  counter('recipe_library.stored', { category });
  return id;
}

export interface RecordReviewInput {
  readonly recipeId: string;
  readonly round: number;
  readonly score: number;
  readonly accepted: boolean;
  readonly silhouetteReads: boolean;
  readonly summary: string;
  /** The critic's full verdict object, stored verbatim. */
  readonly verdict: unknown;
  readonly failures: readonly string[];
  readonly triangleCount: number;
  readonly viewCount: number;
  readonly durationMs: number;
}

/** Records one round's verdict against the recipe it judged. */
export function recordReviewRound(input: RecordReviewInput): void {
  db()
    .prepare(
      `INSERT INTO asset_reviews (id, recipe_id, round, score, accepted, silhouette_ok, summary,
         verdict, failures, triangle_count, view_count, duration_ms, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId('arv'),
      input.recipeId,
      input.round,
      input.score,
      input.accepted ? 1 : 0,
      input.silhouetteReads ? 1 : 0,
      input.summary.slice(0, 4000),
      JSON.stringify(input.verdict ?? {}).slice(0, 40_000),
      JSON.stringify(input.failures).slice(0, 20_000),
      Math.round(input.triangleCount),
      input.viewCount,
      Math.round(input.durationMs),
      nowIso(),
    );
}

/**
 * The verdict that the stored recipe earned: the highest-scoring round recorded
 * for it. Returned as unknown and parsed by the caller against the critic's own
 * schema, so this module does not need to depend on the reviewer.
 */
export function bestVerdictFor(recipeId: string): { verdict: unknown; failures: string[]; round: number } | null {
  const row = db()
    .prepare<[string], { verdict: string; failures: string; round: number }>(
      'SELECT verdict, failures, round FROM asset_reviews WHERE recipe_id = ? ORDER BY score DESC, round DESC LIMIT 1',
    )
    .get(recipeId);
  if (!row) return null;
  const verdict = fromJson<unknown>(row.verdict, null);
  if (verdict === null) return null;
  return { verdict, failures: fromJson<string[]>(row.failures, []), round: row.round };
}

/**
 * Reduces a failed criterion to a signature that groups the same *kind* of
 * failure across different assets. Numbers, quoted step ids and the asset's own
 * nouns vary; the shape of the complaint does not.
 */
export function failureSignature(criterion: string): string {
  const normalised = criterion
    .toLowerCase()
    .replace(/`[^`]*`/g, ' ')
    .replace(/"[^"]*"/g, ' ')
    .replace(/\b\d+(\.\d+)?\s*(mm|cm|m|metres|meters|degrees|deg|%)?\b/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
  return crypto.createHash('sha256').update(normalised).digest('hex').slice(0, 32);
}

/**
 * Counts a failed criterion. `recovered` marks the same criterion passing in a
 * later round, which is what distinguishes a hard limitation of the kernel from
 * a mistake the repair loop reliably fixes on its own.
 */
export function recordFailureMode(
  criterion: string,
  options: { category?: string; step?: string; recovered?: boolean } = {},
): void {
  const signature = failureSignature(criterion);
  const database = db();
  const now = nowIso();
  const changes = database
    .prepare(
      `UPDATE asset_failure_modes
          SET occurrences = occurrences + ?, recoveries = recoveries + ?, last_step = ?, last_seen_at = ?
        WHERE signature = ?`,
    )
    .run(options.recovered ? 0 : 1, options.recovered ? 1 : 0, options.step ?? '', now, signature).changes;
  if (changes > 0) return;

  database
    .prepare(
      `INSERT INTO asset_failure_modes (id, signature, criterion, category, occurrences, recoveries,
         last_step, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      newId('afm'),
      signature,
      criterion.slice(0, 400),
      options.category ?? 'other',
      options.recovered ? 0 : 1,
      options.recovered ? 1 : 0,
      options.step ?? '',
      now,
      now,
    );
}

// ------------------------------------------------------------------ recall --

export interface RecallOptions {
  readonly request: string;
  readonly category?: string;
  /** Below this the stored recipe is not worth reusing; author a new one. */
  readonly minScore?: number;
  /** Cosine similarity a semantic match must clear. Deliberately high. */
  readonly threshold?: number;
}

/**
 * Finds a stored recipe that already answers this request.
 *
 * The exact-request hit is unconditional. The semantic hit is guarded by a high
 * threshold and by the stored score, because reusing an asset that is merely
 * *related* to what was asked for is the failure this whole pipeline exists to
 * prevent — it would return a hatchback for a request for a van, silently, and
 * the critic would never run.
 */
export async function recallRecipe(options: RecallOptions): Promise<RecalledRecipe | null> {
  const database = db();
  const category = options.category ?? 'other';
  const minScore = options.minScore ?? 78;
  const threshold = options.threshold ?? 0.92;

  const hash = requestHash(options.request, category);
  const exact = database.prepare<[string], RecipeRow>('SELECT * FROM asset_recipes WHERE request_hash = ?').get(hash);
  if (exact && exact.score >= minScore) {
    const stored = toStored(exact);
    if (stored) {
      database.prepare('UPDATE asset_recipes SET reuse_count = reuse_count + 1 WHERE id = ?').run(exact.id);
      counter('recipe_library.hit', { kind: 'request', category });
      log.info('reusing a stored recipe; no authoring or review calls needed', {
        name: stored.name,
        score: stored.score,
        reuseCount: stored.reuseCount + 1,
      });
      return { ...stored, relevance: 1, matchedBy: 'request' };
    }
  }

  try {
    const [vector] = await embedTexts([normaliseRequest(options.request).slice(0, 2000)], { ownerType: 'recipe' });
    if (!vector) return null;
    const hits = searchSimilar('recipe', vector, { limit: 8, threshold });
    for (const hit of hits) {
      const row = database.prepare<[string], RecipeRow>('SELECT * FROM asset_recipes WHERE id = ?').get(hit.ownerId);
      if (!row || row.score < minScore || row.category !== category) continue;
      const stored = toStored(row);
      if (!stored) continue;
      database.prepare('UPDATE asset_recipes SET reuse_count = reuse_count + 1 WHERE id = ?').run(row.id);
      counter('recipe_library.hit', { kind: 'semantic', category });
      log.info('reusing a semantically matching recipe', { name: stored.name, similarity: hit.score });
      return { ...stored, relevance: hit.score, matchedBy: 'semantic' };
    }
  } catch (error) {
    log.debug('semantic recall unavailable; exact-request reuse still applies', { error: (error as Error).message });
  }

  counter('recipe_library.miss', { category });
  return null;
}

/**
 * The library's own best work, for use as few-shot examples.
 *
 * Same-category examples first — a request for a building learns most from
 * another building — then the highest-scoring assets of any category, so a
 * category the library has never seen still gets shown what a good recipe looks
 * like.
 */
export function exemplarRecipes(options: { category?: string; limit?: number; minScore?: number } = {}): StoredRecipe[] {
  const limit = Math.max(1, Math.min(8, options.limit ?? 3));
  const minScore = options.minScore ?? 85;
  const database = db();
  const out: StoredRecipe[] = [];
  const seen = new Set<string>();

  const push = (rows: RecipeRow[]): void => {
    for (const row of rows) {
      if (seen.has(row.id) || out.length >= limit) continue;
      const stored = toStored(row);
      if (!stored) continue;
      seen.add(row.id);
      out.push(stored);
    }
  };

  if (options.category) {
    push(
      database
        .prepare<[string, number, number], RecipeRow>(
          `SELECT * FROM asset_recipes WHERE category = ? AND accepted = 1 AND score >= ?
            ORDER BY score DESC LIMIT ?`,
        )
        .all(options.category, minScore, limit),
    );
  }
  if (out.length < limit) {
    push(
      database
        .prepare<[number, number], RecipeRow>(
          `SELECT * FROM asset_recipes WHERE accepted = 1 AND score >= ? ORDER BY score DESC LIMIT ?`,
        )
        .all(minScore, limit),
    );
  }
  return out;
}

export interface FailureMode {
  readonly criterion: string;
  readonly category: string;
  readonly occurrences: number;
  readonly recoveries: number;
  readonly lastStep: string;
  readonly lastSeenAt: string;
}

/** The criteria that fail most often across the whole library. */
export function topFailureModes(limit = 10): FailureMode[] {
  return db()
    .prepare<[number], { criterion: string; category: string; occurrences: number; recoveries: number; last_step: string; last_seen_at: string }>(
      `SELECT criterion, category, occurrences, recoveries, last_step, last_seen_at
         FROM asset_failure_modes ORDER BY occurrences DESC, last_seen_at DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(50, limit)))
    .map((row) => ({
      criterion: row.criterion,
      category: row.category,
      occurrences: row.occurrences,
      recoveries: row.recoveries,
      lastStep: row.last_step,
      lastSeenAt: row.last_seen_at,
    }));
}

/**
 * Renders the recurring failures as a prompt section, so the author is warned
 * about the mistakes this pipeline actually makes before it makes them again.
 * Only failures seen more than once are worth the tokens — a one-off is noise.
 */
export function renderFailureModesForPrompt(modes: readonly FailureMode[]): string {
  const recurring = modes.filter((mode) => mode.occurrences > 1);
  if (recurring.length === 0) return '';
  return (
    'MISTAKES THIS PIPELINE HAS MADE REPEATEDLY — check your recipe against each one before returning it:\n' +
    recurring
      .map(
        (mode) =>
          `- (${mode.occurrences}x) ${mode.criterion}` +
          (mode.lastStep ? ` — last blamed on step "${mode.lastStep}"` : '') +
          (mode.recoveries > 0 ? ` [recovered on repair ${mode.recoveries}x]` : ' [never recovered on repair]'),
      )
      .join('\n')
  );
}

export interface RecipeLibraryStats {
  readonly recipes: number;
  readonly accepted: number;
  readonly averageScore: number;
  readonly totalReuse: number;
  readonly reviews: number;
  readonly failureModes: number;
  readonly byCategory: ReadonlyArray<{ category: string; count: number; averageScore: number }>;
}

export function recipeLibraryStats(): RecipeLibraryStats {
  const database = db();
  const totals = database
    .prepare<[], { recipes: number; accepted: number; average: number | null; reuse: number | null }>(
      `SELECT COUNT(*) AS recipes,
              SUM(CASE WHEN accepted = 1 THEN 1 ELSE 0 END) AS accepted,
              AVG(score) AS average,
              SUM(reuse_count) AS reuse
         FROM asset_recipes`,
    )
    .get() ?? { recipes: 0, accepted: 0, average: 0, reuse: 0 };

  const reviews = database.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM asset_reviews').get()?.n ?? 0;
  const failureModes = database.prepare<[], { n: number }>('SELECT COUNT(*) AS n FROM asset_failure_modes').get()?.n ?? 0;

  const byCategory = database
    .prepare<[], { category: string; count: number; average: number | null }>(
      `SELECT category, COUNT(*) AS count, AVG(score) AS average FROM asset_recipes
        GROUP BY category ORDER BY count DESC`,
    )
    .all()
    .map((row) => ({
      category: row.category,
      count: row.count,
      averageScore: Math.round((row.average ?? 0) * 10) / 10,
    }));

  return {
    recipes: totals.recipes,
    accepted: totals.accepted ?? 0,
    averageScore: Math.round((totals.average ?? 0) * 10) / 10,
    totalReuse: totals.reuse ?? 0,
    reviews,
    failureModes,
    byCategory,
  };
}

/** Every review round recorded for one recipe, oldest first. */
export function reviewHistory(recipeId: string): Array<{
  round: number;
  score: number;
  accepted: boolean;
  summary: string;
  failures: string[];
  createdAt: string;
}> {
  return db()
    .prepare<[string], { round: number; score: number; accepted: number; summary: string; failures: string; created_at: string }>(
      'SELECT round, score, accepted, summary, failures, created_at FROM asset_reviews WHERE recipe_id = ? ORDER BY round',
    )
    .all(recipeId)
    .map((row) => ({
      round: row.round,
      score: row.score,
      accepted: row.accepted === 1,
      summary: row.summary,
      failures: fromJson<string[]>(row.failures, []),
      createdAt: row.created_at,
    }));
}

export function getStoredRecipe(id: string): StoredRecipe | null {
  const row = db().prepare<[string], RecipeRow>('SELECT * FROM asset_recipes WHERE id = ?').get(id);
  return row ? toStored(row) : null;
}
