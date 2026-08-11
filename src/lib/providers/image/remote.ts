import crypto from 'node:crypto';
import { config } from '@/lib/config/env';
import { request } from '../http';
import { unitCost } from '../pricing';
import { resizePng } from '@/lib/graphics/image-ops';
import { decodePng, encodePng } from '@/lib/graphics/png';
import {
  ProviderNotConfiguredError,
  ProviderRequestError,
  type ImageGenerationProvider,
  type ImageRequest,
  type ImageResult,
  type ProviderStatus,
} from '../types';

/** Snaps a requested size to the closest size the vendor actually renders. */
function nearestSupported(width: number, height: number, supported: ReadonlyArray<[number, number]>): [number, number] {
  const targetAspect = width / height;
  let best = supported[0] as [number, number];
  let bestScore = Number.POSITIVE_INFINITY;
  for (const candidate of supported) {
    const aspect = candidate[0] / candidate[1];
    const score = Math.abs(Math.log(aspect / targetAspect));
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

/** Ensures the returned bytes are a PNG of exactly the requested dimensions. */
function normalise(data: Buffer, width: number, height: number): Buffer {
  const decoded = decodePng(data);
  if (decoded.width === width && decoded.height === height) {
    return encodePng(decoded.width, decoded.height, decoded.rgba);
  }
  return resizePng(data, width, height);
}

// ------------------------------------------------------------------- OpenAI --

interface OpenAiImageBody {
  data?: Array<{ b64_json?: string; url?: string }>;
  error?: { message?: string };
}

const OPENAI_SIZES: ReadonlyArray<[number, number]> = [
  [1024, 1024],
  [1024, 1536],
  [1536, 1024],
];

export class OpenAiImageProvider implements ImageGenerationProvider {
  readonly name = 'openai';
  private static readonly REQUIRES = ['OPENAI_API_KEY'];

  status(): ProviderStatus {
    const configured = Boolean(config().OPENAI_API_KEY);
    return {
      name: this.name,
      kind: 'image',
      configured,
      detail: configured
        ? `OpenAI image generation (${config().OPENAI_IMAGE_MODEL})`
        : 'OPENAI_API_KEY is not set; remote image generation is refused.',
      requires: OpenAiImageProvider.REQUIRES,
    };
  }

  async generate(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
    const cfg = config();
    const apiKey = cfg.OPENAI_API_KEY;
    if (!apiKey) throw new ProviderNotConfiguredError(this.name, OpenAiImageProvider.REQUIRES);

    const [rw, rh] = nearestSupported(req.width, req.height, OPENAI_SIZES);
    const started = Date.now();
    const raw = await request({
      provider: this.name,
      limiterKey: 'openai-images',
      url: `${cfg.OPENAI_BASE_URL.replace(/\/$/, '')}/images/generations`,
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: cfg.OPENAI_IMAGE_MODEL,
        prompt: req.prompt,
        size: `${rw}x${rh}`,
        n: 1,
        output_format: 'png',
      }),
      timeoutMs: 180_000,
      maxAttempts: 2,
      signal,
    });

    const parsed = JSON.parse(raw.body.toString('utf8')) as OpenAiImageBody;
    const b64 = parsed.data?.[0]?.b64_json;
    if (!b64) {
      throw new ProviderRequestError(this.name, raw.status, parsed.error?.message ?? 'response contained no image data', false);
    }
    const png = normalise(Buffer.from(b64, 'base64'), req.width, req.height);
    return {
      data: png,
      mime: 'image/png',
      width: req.width,
      height: req.height,
      provider: this.name,
      model: cfg.OPENAI_IMAGE_MODEL,
      latencyMs: Date.now() - started,
      costUsd: unitCost(`image:${cfg.OPENAI_IMAGE_MODEL}`, 1).costUsd,
    };
  }
}

// ---------------------------------------------------------------- Stability --

function multipart(fields: Record<string, string>): { body: Buffer; contentType: string } {
  const boundary = `----adaf${crypto.randomBytes(12).toString('hex')}`;
  const parts: Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`, 'utf8'),
    );
  }
  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf8'));
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` };
}

const STABILITY_RATIOS: ReadonlyArray<[string, number]> = [
  ['1:1', 1],
  ['3:2', 1.5],
  ['2:3', 2 / 3],
  ['16:9', 16 / 9],
  ['9:16', 9 / 16],
  ['4:5', 0.8],
  ['5:4', 1.25],
  ['21:9', 21 / 9],
  ['9:21', 9 / 21],
];

export class StabilityImageProvider implements ImageGenerationProvider {
  readonly name = 'stability';
  private static readonly REQUIRES = ['STABILITY_API_KEY'];

  status(): ProviderStatus {
    const configured = Boolean(config().STABILITY_API_KEY);
    return {
      name: this.name,
      kind: 'image',
      configured,
      detail: configured
        ? `Stability AI Stable Image (${config().STABILITY_MODEL})`
        : 'STABILITY_API_KEY is not set; remote image generation is refused.',
      requires: StabilityImageProvider.REQUIRES,
    };
  }

  async generate(req: ImageRequest, signal?: AbortSignal): Promise<ImageResult> {
    const cfg = config();
    const apiKey = cfg.STABILITY_API_KEY;
    if (!apiKey) throw new ProviderNotConfiguredError(this.name, StabilityImageProvider.REQUIRES);

    const target = req.width / req.height;
    const ratio = STABILITY_RATIOS.reduce((best, candidate) =>
      Math.abs(Math.log(candidate[1] / target)) < Math.abs(Math.log(best[1] / target)) ? candidate : best,
    )[0];

    const fields: Record<string, string> = {
      prompt: req.prompt,
      output_format: 'png',
      aspect_ratio: ratio,
      model: cfg.STABILITY_MODEL,
      seed: String(req.seed >>> 0),
    };
    if (req.negativePrompt) fields.negative_prompt = req.negativePrompt;
    const { body, contentType } = multipart(fields);

    const started = Date.now();
    const raw = await request({
      provider: this.name,
      limiterKey: 'stability-images',
      url: `${cfg.STABILITY_BASE_URL.replace(/\/$/, '')}/v2beta/stable-image/generate/core`,
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, accept: 'image/*', 'content-type': contentType },
      body,
      timeoutMs: 180_000,
      maxAttempts: 2,
      signal,
    });

    if (!raw.headers.get('content-type')?.startsWith('image/')) {
      throw new ProviderRequestError(this.name, raw.status, raw.body.toString('utf8').slice(0, 300), false);
    }
    const png = normalise(raw.body, req.width, req.height);
    return {
      data: png,
      mime: 'image/png',
      width: req.width,
      height: req.height,
      provider: this.name,
      model: cfg.STABILITY_MODEL,
      latencyMs: Date.now() - started,
      costUsd: unitCost(`image:${cfg.STABILITY_MODEL}`, 1).costUsd,
    };
  }
}
