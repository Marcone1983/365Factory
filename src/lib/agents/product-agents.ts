import { z } from 'zod';
import { Agent, AgentError, type AgentContext } from './base';
import { completeJson } from '@/lib/ai/router';
import { db, newId, nowIso, toJson } from '@/lib/db/client';
import { embedTexts, cosineSimilarity } from '@/lib/knowledge/embeddings';
import { scoringModel } from '@/lib/market/scoring';
import { deriveBrand, generateBrandAssets, generateMeshAssets, generateTextures, validateAssets, type AssetRecord, type MeshBrief } from '@/lib/generation/assets';
import { scaffoldProject, type BrandIdentity } from '@/lib/generation/scaffold';
import { createProject, updateProject, workspaceFor, type Project, type ProjectKind } from '@/lib/workspace/project';
import { seedFrom } from '@/lib/util/random';
import type { CompetitiveMap } from '@/lib/market/competitive';
import type { MarketGap, ProductForm } from '@/lib/market/gaps';
import type { FilePlanEntry } from './coding';

/**
 * Product agents: invention, architecture and asset production.
 *
 * The invention step is where originality is enforced. A concept is embedded and
 * compared against every incumbent discovered during competitive research and
 * against every concept the factory has produced before; if it is too close to
 * either, it is sent back for differentiation rather than shipped as a
 * near-duplicate.
 */

// -------------------------------------------------------------- inventor ----

const ConceptSchema = z.object({
  name: z.string().min(3).max(60),
  tagline: z.string().min(10).max(140),
  productType: z.enum(['mobile_app', 'productivity_app', 'utility', 'educational_app', 'simulation', 'game', 'hybrid']),
  targetUsers: z.array(z.string().max(160)).min(1).max(5),
  coreProblem: z.string().min(30).max(800),
  solution: z.string().min(40).max(1500),
  usp: z.string().min(20).max(500),
  features: z
    .array(z.object({ name: z.string().max(80), description: z.string().max(400), priority: z.enum(['core', 'important', 'later']) }))
    .min(3)
    .max(12),
  gameplay: z
    .object({
      genre: z.string().max(80),
      perspective: z.enum(['first_person', 'third_person', 'top_down', 'isometric', 'cockpit']),
      coreLoop: z.string().max(600),
      winCondition: z.string().max(400),
      progression: z.string().max(400),
      controls: z.string().max(400),
      /** Which virtual gamepad layout the product should use. */
      controlLayout: z.enum(['twin-stick', 'driving', 'arcade']),
      difficultyCurve: z.string().max(300),
    })
    .nullable()
    .default(null),
  monetization: z.object({ model: z.string().max(120), rationale: z.string().max(600) }),
  techArchitecture: z.object({
    summary: z.string().max(1200),
    modules: z.array(z.object({ name: z.string().max(60), responsibility: z.string().max(300) })).min(2).max(14),
    dataModel: z.array(z.object({ entity: z.string().max(60), fields: z.string().max(300) })).max(12).default([]),
  }),
  requiredAssets: z
    .array(
      z.object({
        name: z.string().max(60),
        kind: z.enum(['character', 'creature', 'vehicle', 'track', 'weapon', 'prop', 'building', 'flora', 'rock', 'collectible', 'texture']),
        /** Art-direction brief used by the generative-3D service. */
        prompt: z.string().min(15).max(500),
      }),
    )
    .max(14)
    .default([]),
  brandTone: z.array(z.string().max(30)).min(2).max(6),
  developmentPlan: z.array(z.string().max(200)).min(3).max(12),
  risks: z.array(z.object({ risk: z.string().max(200), mitigation: z.string().max(300) })).min(1).max(6),
  decisionSummary: z.object({
    whyThisProblem: z.string().max(600),
    whyNow: z.string().max(400),
    whyThisAudience: z.string().max(400),
    whyThisSolution: z.string().max(600),
    whyThisMonetization: z.string().max(400),
    whyThisTechnology: z.string().max(400),
    whyThisMechanic: z.string().max(400).default(''),
  }),
});

export type ProductConcept = z.infer<typeof ConceptSchema>;

export interface InventorInput {
  readonly gap: MarketGap;
  readonly opportunityId: string;
  readonly competitive: CompetitiveMap;
  readonly productForm: ProductForm;
  readonly constraints?: readonly string[];
  readonly maxRevisions?: number;
}

export interface SimilarityReport {
  readonly closestCompetitor: string | null;
  readonly competitorSimilarity: number;
  readonly closestPriorConcept: string | null;
  readonly priorSimilarity: number;
  readonly originality: number;
  readonly revisions: number;
}

export interface InventorOutput {
  readonly concept: ProductConcept;
  readonly conceptId: string;
  readonly similarity: SimilarityReport;
  readonly kind: ProjectKind;
}

const INVENTOR_SYSTEM = `You invent a product that resolves a specific, evidenced market gap.

Rules:
- The product must follow from the gap and the evidence. Do not invent a product you find interesting and retrofit a justification.
- It must be materially different from every incumbent listed. Differentiation means a different mechanism, a different data model, a different interaction, or a different economic model — not a different colour scheme or a shorter feature list.
- Name it with a real, memorable, ownable name. Never a generic compound like "TaskFlow Pro" or "SmartHabit".
- If the product form is a game or a simulation it will be built as a 3D product with a WebGL engine packaged for Android. Design the gameplay for touch first: a virtual gamepad, short sessions, no precision mouse aiming.
- "requiredAssets" is the brief the asset pipeline works from. Describe each asset as art direction a 3D artist could execute: silhouette, material, era, mood. Be specific.
- Never claim the product has never existed. Speak only about how it differs from what was actually discovered.`;

export class ProductInventorAgent extends Agent<InventorInput, InventorOutput> {
  readonly name = 'inventor';
  readonly description = 'Invents an original product concept from a scored opportunity';

  constructor() {
    super({ maxAttempts: 2, timeoutMs: 900_000 });
  }

  protected async execute(input: InventorInput, context: AgentContext): Promise<InventorOutput> {
    const maxRevisions = input.maxRevisions ?? 2;
    const threshold = scoringModel().maximumSimilarity;
    const competitorText = input.competitive.competitors.map(
      (c) => `${c.name}: ${c.strengths.join(', ')} | weaknesses: ${c.weaknesses.join(', ')} | complaints: ${c.complaints.join('; ')}`,
    );

    let concept: ProductConcept | null = null;
    let similarity: SimilarityReport | null = null;
    let feedback = '';

    for (let revision = 0; revision <= maxRevisions; revision += 1) {
      const task = revision === 0 ? 'product_invention' : 'concept_revision';
      context.progress(revision === 0 ? 'inventing the product concept' : `differentiating (revision ${revision})`);

      const { data } = await completeJson({
        task,
        schema: ConceptSchema,
        system: INVENTOR_SYSTEM,
        signal: context.signal,
        maxOutputTokens: 12_000,
        bypassCache: true,
        context: { factoryRunId: context.factoryRunId },
        messages: [
          {
            role: 'user',
            content:
              `GAP: ${input.gap.title}\n${input.gap.description}\nAUDIENCE: ${input.gap.audience}\nTYPE: ${input.gap.gapType}\n\n` +
              `RECOMMENDED PRODUCT FORM: ${input.productForm}\n\n` +
              `INCUMBENTS:\n${competitorText.length > 0 ? competitorText.join('\n') : '(none were discoverable)'}\n\n` +
              `DIFFERENTIATION ANGLES FOUND IN RESEARCH:\n${input.competitive.differentiation.unexploitedAngles.join('\n')}\n` +
              `HARDEST TO COPY: ${input.competitive.differentiation.hardestToCopy}\n` +
              `MARKET SATURATION: ${input.competitive.saturation.level} — ${input.competitive.saturation.reasoning}\n\n` +
              (input.constraints?.length ? `OPERATOR CONSTRAINTS (must respect):\n${input.constraints.map((c) => `- ${c}`).join('\n')}\n\n` : '') +
              (feedback ? `${feedback}\n\n` : '') +
              'Return the product concept as JSON.',
          },
        ],
      });

      concept = data;
      similarity = await this.assessOriginality(data, input.competitive, revision);
      context.progress(
        `originality ${(similarity.originality * 100).toFixed(0)}% (closest incumbent ${(similarity.competitorSimilarity * 100).toFixed(0)}%, closest prior concept ${(similarity.priorSimilarity * 100).toFixed(0)}%)`,
      );

      const tooSimilar = Math.max(similarity.competitorSimilarity, similarity.priorSimilarity) >= threshold;
      if (!tooSimilar) break;
      if (revision === maxRevisions) {
        throw new AgentError(
          `The concept remained too close to ${similarity.competitorSimilarity >= similarity.priorSimilarity ? similarity.closestCompetitor : similarity.closestPriorConcept} ` +
            `after ${maxRevisions} differentiation attempts. Rejecting rather than shipping a near-duplicate.`,
          false,
          'INSUFFICIENT_ORIGINALITY',
        );
      }
      feedback =
        `YOUR PREVIOUS CONCEPT "${data.name}" WAS REJECTED: it is ${(Math.max(similarity.competitorSimilarity, similarity.priorSimilarity) * 100).toFixed(0)}% similar to ` +
        `${similarity.competitorSimilarity >= similarity.priorSimilarity ? `the incumbent "${similarity.closestCompetitor}"` : `the earlier product "${similarity.closestPriorConcept}"`}. ` +
        'Change the mechanism, not the wording. A different core interaction, a different data model, or a different economic model — not a renamed feature list.';
    }

    if (!concept || !similarity) throw new AgentError('No concept was produced.', false, 'NO_CONCEPT');

    const kind: ProjectKind =
      concept.productType === 'game' || concept.productType === 'simulation'
        ? 'game'
        : concept.productType === 'hybrid'
          ? 'hybrid'
          : 'app';

    const conceptId = this.persist(concept, input, similarity, context.factoryRunId);
    return { concept, conceptId, similarity, kind };
  }

  /**
   * Semantic originality check against incumbents and against everything the
   * factory has already built, so it cannot converge on one idea over time.
   */
  private async assessOriginality(concept: ProductConcept, competitive: CompetitiveMap, revisions: number): Promise<SimilarityReport> {
    const describe = (name: string, text: string): string => `${name}: ${text}`.slice(0, 1200);
    const conceptText = describe(concept.name, `${concept.tagline} ${concept.coreProblem} ${concept.solution} ${concept.usp}`);

    const priorRows = db()
      .prepare<[], { name: string; tagline: string; core_problem: string; solution: string; usp: string }>(
        'SELECT name, tagline, core_problem, solution, usp FROM product_concepts ORDER BY created_at DESC LIMIT 60',
      )
      .all();

    const competitorTexts = competitive.competitors.map((c) =>
      describe(c.name, `${c.strengths.join(' ')} ${c.weaknesses.join(' ')} ${c.monetization}`),
    );
    const priorTexts = priorRows.map((r) => describe(r.name, `${r.tagline} ${r.core_problem} ${r.solution} ${r.usp}`));

    const vectors = await embedTexts([conceptText, ...competitorTexts, ...priorTexts], { ownerType: 'concept' });
    const conceptVector = vectors[0] as Float32Array;

    let competitorSimilarity = 0;
    let closestCompetitor: string | null = null;
    competitorTexts.forEach((_text, i) => {
      const score = cosineSimilarity(conceptVector, vectors[1 + i] as Float32Array);
      if (score > competitorSimilarity) {
        competitorSimilarity = score;
        closestCompetitor = competitive.competitors[i]?.name ?? null;
      }
    });

    let priorSimilarity = 0;
    let closestPriorConcept: string | null = null;
    priorTexts.forEach((_text, i) => {
      const score = cosineSimilarity(conceptVector, vectors[1 + competitorTexts.length + i] as Float32Array);
      if (score > priorSimilarity) {
        priorSimilarity = score;
        closestPriorConcept = priorRows[i]?.name ?? null;
      }
    });

    return {
      closestCompetitor,
      competitorSimilarity: Number(competitorSimilarity.toFixed(4)),
      closestPriorConcept,
      priorSimilarity: Number(priorSimilarity.toFixed(4)),
      originality: Number((1 - Math.max(competitorSimilarity, priorSimilarity)).toFixed(4)),
      revisions,
    };
  }

  private persist(concept: ProductConcept, input: InventorInput, similarity: SimilarityReport, factoryRunId?: string): string {
    const id = newId('cpt');
    const now = nowIso();
    db()
      .prepare(
        `INSERT INTO product_concepts (id, opportunity_id, factory_run_id, name, slug, product_type, tagline,
           target_users, core_problem, solution, usp, features, gameplay, monetization, tech_architecture,
           required_assets, development_plan, risks, brand, originality_score, similarity_report,
           decision_summary, status, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '{}', ?, ?, ?, 'APPROVED', ?, ?, ?)`,
      )
      .run(
        id,
        input.opportunityId,
        factoryRunId ?? null,
        concept.name,
        concept.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''),
        concept.productType,
        concept.tagline,
        toJson(concept.targetUsers),
        concept.coreProblem,
        concept.solution,
        concept.usp,
        toJson(concept.features),
        toJson(concept.gameplay),
        toJson(concept.monetization),
        toJson(concept.techArchitecture),
        toJson(concept.requiredAssets),
        toJson(concept.developmentPlan),
        toJson(concept.risks),
        similarity.originality,
        toJson(similarity),
        toJson(concept.decisionSummary),
        similarity.revisions + 1,
        now,
        now,
      );
    return id;
  }
}

// ------------------------------------------------------------- architect ----

const PlanSchema = z.object({
  files: z
    .array(
      z.object({
        path: z.string().min(3).max(160),
        purpose: z.string().min(15).max(400),
        uses: z.array(z.string().max(60)).max(8).default([]),
      }),
    )
    .min(2)
    .max(18),
  systems: z.array(z.object({ name: z.string().max(60), responsibility: z.string().max(300) })).min(1).max(12),
  runtimeNotes: z.string().max(1500),
  performanceBudget: z.object({
    targetFps: z.number().min(24).max(120),
    maxDrawCalls: z.number().min(10).max(400),
    maxTriangles: z.number().min(10_000).max(2_000_000),
    maxTextureMemoryMb: z.number().min(8).max(512),
  }),
});

export interface ArchitectInput {
  readonly concept: ProductConcept;
  readonly kind: ProjectKind;
  readonly assetPaths: readonly string[];
}

export interface ArchitectOutput {
  readonly plan: readonly FilePlanEntry[];
  readonly design: Record<string, unknown>;
}

export class ArchitectAgent extends Agent<ArchitectInput, ArchitectOutput> {
  readonly name = 'architect';
  readonly description = 'Designs the module structure, file plan and performance budget';

  protected async execute(input: ArchitectInput, context: AgentContext): Promise<ArchitectOutput> {
    const runtime = input.kind === 'app' ? 'appkit' : 'engine';
    const { data } = await completeJson({
      task: input.kind === 'app' ? 'architecture_design' : 'game_design',
      schema: PlanSchema,
      signal: context.signal,
      maxOutputTokens: 8000,
      context: { factoryRunId: context.factoryRunId },
      system:
        `You design the implementation of a product that will be built on an existing runtime SDK at src/${runtime}/.\n` +
        'Produce a file plan the coding agent will implement literally. Every file must have a single clear responsibility.\n' +
        'Do not plan files inside the SDK directory — it already exists and is not modifiable.\n' +
        'src/main.ts is mandatory and is the entry point. Keep the plan between 4 and 12 files; more than that produces thin, incoherent modules.\n' +
        'The performance budget targets a mid-range Android phone rendering through a WebView.',
      messages: [
        {
          role: 'user',
          content:
            `PRODUCT: ${input.concept.name} — ${input.concept.tagline}\n` +
            `TYPE: ${input.concept.productType}\n` +
            `SOLUTION: ${input.concept.solution}\n` +
            `FEATURES:\n${input.concept.features.map((f) => `- [${f.priority}] ${f.name}: ${f.description}`).join('\n')}\n` +
            (input.concept.gameplay
              ? `GAMEPLAY: ${input.concept.gameplay.genre}, ${input.concept.gameplay.perspective}\nLOOP: ${input.concept.gameplay.coreLoop}\nCONTROLS: ${input.concept.gameplay.controls} (layout: ${input.concept.gameplay.controlLayout})\n`
              : '') +
            `MODULES SUGGESTED BY THE CONCEPT:\n${input.concept.techArchitecture.modules.map((m) => `- ${m.name}: ${m.responsibility}`).join('\n')}\n` +
            `ASSETS AVAILABLE:\n${input.assetPaths.map((p) => `- assets/${p}`).join('\n')}\n\n` +
            'Return the JSON plan.',
        },
      ],
    });

    return {
      plan: data.files.map((file) => ({ path: file.path, purpose: file.purpose, uses: file.uses })),
      design: {
        systems: data.systems,
        runtimeNotes: data.runtimeNotes,
        performanceBudget: data.performanceBudget,
        gameplay: input.concept.gameplay,
        features: input.concept.features,
        dataModel: input.concept.techArchitecture.dataModel,
        monetization: input.concept.monetization,
      },
    };
  }
}

// ----------------------------------------------------------------- asset ----

export interface AssetAgentInput {
  readonly concept: ProductConcept;
  readonly kind: ProjectKind;
  readonly userId?: string;
}

export interface AssetAgentOutput {
  readonly project: Project;
  readonly brand: BrandIdentity;
  readonly assets: readonly AssetRecord[];
  readonly validation: ReturnType<typeof validateAssets>;
  readonly modelData: Record<string, unknown>;
}

const MESH_KINDS = new Set(['character', 'creature', 'vehicle', 'track', 'weapon', 'prop', 'building', 'flora', 'rock', 'collectible']);

export class AssetAgent extends Agent<AssetAgentInput, AssetAgentOutput> {
  readonly name = 'asset';
  readonly description = 'Creates the project workspace, brand identity and every generated asset';

  constructor() {
    super({ maxAttempts: 1, timeoutMs: 1_800_000 });
  }

  protected async execute(input: AssetAgentInput, context: AgentContext): Promise<AssetAgentOutput> {
    const seed = seedFrom(`${input.concept.name}:${input.concept.tagline}`);
    const brand = deriveBrand({
      name: input.concept.name,
      tagline: input.concept.tagline,
      tone: input.concept.brandTone,
      seed,
    });

    const project = createProject({
      name: input.concept.name,
      kind: input.kind,
      description: input.concept.tagline,
      userId: input.userId,
      brand: brand as unknown as Record<string, unknown>,
      metadata: { productType: input.concept.productType, controlLayout: input.concept.gameplay?.controlLayout ?? null },
      status: 'GENERATING',
    });
    context.progress(`workspace created for ${project.name}`, { projectId: project.id });

    scaffoldProject({ project, kind: input.kind, brand, description: input.concept.tagline, seed });

    const assets: AssetRecord[] = [];
    context.progress('generating brand identity and launcher assets');
    const brandAssets = await generateBrandAssets(project, brand, seed, { factoryRunId: context.factoryRunId });
    assets.push(...brandAssets.assets);

    const textureBriefs = input.concept.requiredAssets.filter((a) => a.kind === 'texture');
    if (textureBriefs.length > 0) {
      context.progress(`generating ${textureBriefs.length} material textures`);
      assets.push(
        ...(await generateTextures(project, textureBriefs.map((t) => ({ name: t.name, description: t.prompt })), brand, seed)),
      );
    }

    const meshBriefs: MeshBrief[] = input.concept.requiredAssets
      .filter((a) => MESH_KINDS.has(a.kind))
      .map((a) => ({ name: a.name, archetype: a.kind as MeshBrief['archetype'], prompt: a.prompt }));
    if (meshBriefs.length > 0) {
      context.progress(`generating ${meshBriefs.length} 3D assets`);
      assets.push(...(await generateMeshAssets(project, meshBriefs, brand, seed)));
    }

    // Gameplay data emitted next to generated models travels with the plan so the
    // coding agent can consume track layouts and rig joints directly.
    const workspace = workspaceFor(project, 'assets');
    const modelData: Record<string, unknown> = {};
    for (const asset of assets) {
      if (asset.kind !== 'model_data') continue;
      try {
        modelData[asset.path] = JSON.parse(workspace.readText(asset.path)) as unknown;
      } catch {
        context.logger.warn('model data could not be parsed', { path: asset.path });
      }
    }

    const validation = validateAssets(project, ['icons/icon-512.png', 'android/drawable/splash.png']);
    if (!validation.ok) {
      throw new AgentError(
        `Asset validation failed: ${validation.issues.filter((i) => i.severity === 'error').map((i) => `${i.path}: ${i.message}`).join('; ')}`,
        false,
        'ASSET_VALIDATION',
      );
    }
    context.progress(`${assets.length} assets generated and validated`);

    updateProject(project.id, { metadata: { assetCount: assets.length } });
    return { project, brand, assets, validation, modelData };
  }
}
