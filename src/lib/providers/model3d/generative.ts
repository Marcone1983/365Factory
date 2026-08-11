import { config } from '@/lib/config/env';
import { request, requestJson, sleep } from '../http';
import { unitCost } from '../pricing';
import { validateGlb } from '@/lib/graphics/gltf';
import { createLogger } from '@/lib/observability/logger';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type Model3DProvider,
  type Model3DRequest,
  type Model3DResult,
  type ProviderStatus,
} from '../types';

const log = createLogger('providers.model3d');

/**
 * Generative 3D model services.
 *
 * These are the "ask an AI for a high-quality model" path: the coding agent
 * declares the assets it needs, the asset agent describes each one, the service
 * synthesises a textured mesh, and the platform downloads it as GLB, validates
 * it against a triangle and byte budget, and hands it to the game engine.
 *
 * Both integrations are asynchronous job APIs: submit, poll, download. Polling
 * is bounded by a wall-clock budget and the loop backs off, so a stuck job can
 * never hold a generation cycle open indefinitely.
 */

interface PollOptions {
  readonly provider: string;
  readonly timeoutMs: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly signal?: AbortSignal;
}

async function pollUntil<T>(
  fetchState: () => Promise<{ done: boolean; failed: boolean; detail: string; value?: T }>,
  options: PollOptions,
): Promise<T> {
  const deadline = Date.now() + options.timeoutMs;
  let delay = options.initialDelayMs;
  let lastDetail = '';

  while (Date.now() < deadline) {
    if (options.signal?.aborted) throw new Error(`${options.provider}: generation cancelled`);
    const state = await fetchState();
    lastDetail = state.detail;
    if (state.failed) throw new ProviderRequestError(options.provider, 502, `generation failed: ${state.detail}`, false);
    if (state.done && state.value !== undefined) return state.value;
    await sleep(delay);
    delay = Math.min(options.maxDelayMs, Math.round(delay * 1.4));
  }
  throw new ProviderRequestError(
    options.provider,
    504,
    `generation did not finish within ${Math.round(options.timeoutMs / 1000)}s (last state: ${lastDetail})`,
    true,
  );
}

/** Downloads and validates the produced GLB. */
async function downloadGlb(url: string, provider: string, budgetTriangles: number, signal?: AbortSignal): Promise<Buffer> {
  const response = await request({
    provider,
    url,
    timeoutMs: 180_000,
    maxAttempts: 3,
    signal,
  });
  const validation = validateGlb(response.body, { maxTriangles: budgetTriangles * 4, requireUvs: false });
  if (!validation.ok) {
    throw new ProviderRequestError(provider, 422, `returned an unusable model: ${validation.problems.join('; ')}`, false);
  }
  return response.body;
}

// ------------------------------------------------------------------- Meshy --

interface MeshyCreateResponse {
  result?: string;
  message?: string;
}

interface MeshyTaskResponse {
  id?: string;
  status?: 'PENDING' | 'IN_PROGRESS' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  progress?: number;
  model_urls?: { glb?: string };
  task_error?: { message?: string };
}

const MESHY_STYLES: Record<string, string> = {
  realistic: 'realistic',
  sculpture: 'sculpture',
  stylised: 'realistic',
  low_poly: 'realistic',
};

export class MeshyModel3DProvider implements Model3DProvider {
  readonly name = 'meshy';
  private static readonly REQUIRES = ['MESHY_API_KEY'];

  status(): ProviderStatus {
    const configured = Boolean(config().MESHY_API_KEY);
    return {
      name: this.name,
      kind: 'model3d',
      configured,
      detail: configured
        ? 'Meshy text-to-3D (preview + refine, PBR textures, GLB output)'
        : 'MESHY_API_KEY is not set; generative 3D models are unavailable from this provider.',
      requires: MeshyModel3DProvider.REQUIRES,
    };
  }

  async generate(req: Model3DRequest, signal?: AbortSignal): Promise<Model3DResult> {
    const cfg = config();
    const apiKey = cfg.MESHY_API_KEY;
    if (!apiKey) throw new ProviderNotConfiguredError(this.name, MeshyModel3DProvider.REQUIRES);

    const base = cfg.MESHY_BASE_URL.replace(/\/$/, '');
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
    const started = Date.now();
    const budget = req.targetTriangles ?? 30_000;

    // Stage 1 — geometry preview.
    const { data: created } = await requestJson<MeshyCreateResponse>({
      provider: this.name,
      url: `${base}/openapi/v2/text-to-3d`,
      method: 'POST',
      headers,
      body: JSON.stringify({
        mode: 'preview',
        prompt: req.prompt,
        negative_prompt: req.negativePrompt ?? 'low quality, blobby, deformed, extra limbs, floating parts',
        art_style: MESHY_STYLES[req.style ?? 'realistic'] ?? 'realistic',
        should_remesh: true,
        topology: 'quad',
        target_polycount: Math.max(2000, Math.min(300_000, budget)),
        ai_model: cfg.MESHY_MODEL,
        ...(req.seed !== undefined ? { seed: req.seed >>> 0 } : {}),
      }),
      timeoutMs: 60_000,
      maxAttempts: 2,
      signal,
    });
    const previewId = created.result;
    if (!previewId) throw new ProviderRequestError(this.name, 502, created.message ?? 'no task id returned', false);

    const readTask = (id: string) => async (): Promise<{ done: boolean; failed: boolean; detail: string; value?: MeshyTaskResponse }> => {
      const { data } = await requestJson<MeshyTaskResponse>({
        provider: this.name,
        url: `${base}/openapi/v2/text-to-3d/${id}`,
        headers: { authorization: `Bearer ${apiKey}` },
        timeoutMs: 30_000,
        maxAttempts: 3,
        signal,
      });
      const status = data.status ?? 'PENDING';
      return {
        done: status === 'SUCCEEDED',
        failed: status === 'FAILED' || status === 'CANCELED',
        detail: `${status} ${data.progress ?? 0}%${data.task_error?.message ? ` — ${data.task_error.message}` : ''}`,
        value: data,
      };
    };

    await pollUntil(readTask(previewId), {
      provider: this.name,
      timeoutMs: cfg.MODEL3D_TIMEOUT_MS,
      initialDelayMs: 5_000,
      maxDelayMs: 20_000,
      signal,
    });

    // Stage 2 — texture refinement. This is what turns a grey sculpt into a
    // shippable asset, so it is not optional when PBR was requested.
    let finalId = previewId;
    if (req.pbr !== false) {
      const { data: refined } = await requestJson<MeshyCreateResponse>({
        provider: this.name,
        url: `${base}/openapi/v2/text-to-3d`,
        method: 'POST',
        headers,
        body: JSON.stringify({ mode: 'refine', preview_task_id: previewId, enable_pbr: true }),
        timeoutMs: 60_000,
        maxAttempts: 2,
        signal,
      });
      if (refined.result) finalId = refined.result;
      else log.warn('meshy refine stage was not accepted; using the preview mesh', { previewId });
    }

    const final = await pollUntil(readTask(finalId), {
      provider: this.name,
      timeoutMs: cfg.MODEL3D_TIMEOUT_MS,
      initialDelayMs: 5_000,
      maxDelayMs: 20_000,
      signal,
    });

    const glbUrl = final.model_urls?.glb;
    if (!glbUrl) throw new ProviderRequestError(this.name, 502, 'task succeeded but returned no GLB url', false);
    const glb = await downloadGlb(glbUrl, this.name, budget, signal);

    return {
      glb,
      provider: this.name,
      model: cfg.MESHY_MODEL,
      latencyMs: Date.now() - started,
      costUsd: unitCost('model3d:meshy', req.pbr === false ? 1 : 2).costUsd,
      taskId: finalId,
    };
  }
}

// ------------------------------------------------------------------- Tripo --

interface TripoCreateResponse {
  code?: number;
  data?: { task_id?: string };
  message?: string;
}

interface TripoTaskResponse {
  code?: number;
  data?: {
    status?: 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'banned' | 'expired';
    progress?: number;
    output?: { pbr_model?: string; model?: string; base_model?: string };
  };
  message?: string;
}

export class TripoModel3DProvider implements Model3DProvider {
  readonly name = 'tripo';
  private static readonly REQUIRES = ['TRIPO_API_KEY'];

  status(): ProviderStatus {
    const configured = Boolean(config().TRIPO_API_KEY);
    return {
      name: this.name,
      kind: 'model3d',
      configured,
      detail: configured
        ? 'Tripo3D text-to-model (PBR output, GLB download)'
        : 'TRIPO_API_KEY is not set; generative 3D models are unavailable from this provider.',
      requires: TripoModel3DProvider.REQUIRES,
    };
  }

  async generate(req: Model3DRequest, signal?: AbortSignal): Promise<Model3DResult> {
    const cfg = config();
    const apiKey = cfg.TRIPO_API_KEY;
    if (!apiKey) throw new ProviderNotConfiguredError(this.name, TripoModel3DProvider.REQUIRES);

    const base = cfg.TRIPO_BASE_URL.replace(/\/$/, '');
    const headers = { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` };
    const started = Date.now();
    const budget = req.targetTriangles ?? 30_000;

    const { data: created } = await requestJson<TripoCreateResponse>({
      provider: this.name,
      url: `${base}/v2/openapi/task`,
      method: 'POST',
      headers,
      body: JSON.stringify({
        type: 'text_to_model',
        prompt: req.prompt,
        negative_prompt: req.negativePrompt,
        model_version: cfg.TRIPO_MODEL,
        texture: true,
        pbr: req.pbr !== false,
        face_limit: Math.max(2000, Math.min(300_000, budget)),
        ...(req.seed !== undefined ? { model_seed: req.seed >>> 0, texture_seed: req.seed >>> 0 } : {}),
      }),
      timeoutMs: 60_000,
      maxAttempts: 2,
      signal,
    });

    const taskId = created.data?.task_id;
    if (!taskId) throw new ProviderRequestError(this.name, 502, created.message ?? 'no task id returned', false);

    const final = await pollUntil<TripoTaskResponse['data']>(
      async () => {
        const { data } = await requestJson<TripoTaskResponse>({
          provider: this.name,
          url: `${base}/v2/openapi/task/${taskId}`,
          headers: { authorization: `Bearer ${apiKey}` },
          timeoutMs: 30_000,
          maxAttempts: 3,
          signal,
        });
        const status = data.data?.status ?? 'queued';
        return {
          done: status === 'success',
          failed: status === 'failed' || status === 'cancelled' || status === 'banned' || status === 'expired',
          detail: `${status} ${data.data?.progress ?? 0}%`,
          value: data.data,
        };
      },
      { provider: this.name, timeoutMs: cfg.MODEL3D_TIMEOUT_MS, initialDelayMs: 4_000, maxDelayMs: 20_000, signal },
    );

    const glbUrl = final?.output?.pbr_model ?? final?.output?.model ?? final?.output?.base_model;
    if (!glbUrl) throw new ProviderRequestError(this.name, 502, 'task succeeded but returned no model url', false);
    const glb = await downloadGlb(glbUrl, this.name, budget, signal);

    return {
      glb,
      provider: this.name,
      model: cfg.TRIPO_MODEL,
      latencyMs: Date.now() - started,
      costUsd: unitCost('model3d:tripo', 1).costUsd,
      taskId,
    };
  }
}
