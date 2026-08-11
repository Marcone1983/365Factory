import { config } from '@/lib/config/env';
import { getEmbeddingProvider, getImageProvider, getLlmProvider, getSearchProvider, providerStatuses } from '@/lib/providers/registry';
import { androidToolchain } from '@/lib/build/toolchain';
import type { ProviderStatus } from '@/lib/providers/types';

/**
 * Honest capability reporting.
 *
 * The UI renders this verbatim. A capability is only `ready` when the platform
 * can actually perform it end to end; otherwise it says exactly what is missing
 * and which feature is therefore unavailable. Nothing is ever reported as
 * working when its dependency is absent.
 */

export type CapabilityState = 'ready' | 'degraded' | 'unavailable';

export interface Capability {
  readonly id: string;
  readonly title: string;
  readonly state: CapabilityState;
  readonly summary: string;
  readonly blocks: readonly string[];
  readonly remedy: readonly string[];
}

export interface CapabilityReport {
  readonly capabilities: readonly Capability[];
  readonly providers: readonly ProviderStatus[];
  readonly ready: boolean;
  readonly generatedAt: string;
}

export function capabilityReport(): CapabilityReport {
  const cfg = config();
  const llm = getLlmProvider().status();
  const search = getSearchProvider().status();
  const embedding = getEmbeddingProvider().status();
  const image = getImageProvider().status();
  const android = androidToolchain();

  const capabilities: Capability[] = [
    {
      id: 'reasoning',
      title: 'AI reasoning (agents, chat, product invention)',
      state: llm.configured ? 'ready' : 'unavailable',
      summary: llm.configured
        ? `${llm.name}: ${llm.detail}`
        : 'No LLM provider is configured. Agent reasoning, chat and product invention are disabled.',
      blocks: llm.configured ? [] : ['chat', 'gap analysis', 'product invention', 'coding agent'],
      remedy: llm.configured ? [] : [`Set ${llm.requires.join(' or ')} and LLM_PROVIDER.`],
    },
    {
      id: 'web_research',
      title: 'Web research (search + crawl)',
      state: search.configured ? 'ready' : 'unavailable',
      summary: search.configured
        ? `${search.name}: ${search.detail}. Crawling honours robots.txt and per-host rate limits.`
        : 'No web search provider is configured. Market scans cannot discover new sources.',
      blocks: search.configured ? [] : ['market scan', 'trend detection', 'competitive intelligence'],
      remedy: search.configured
        ? []
        : ['Set one of BRAVE_SEARCH_API_KEY, TAVILY_API_KEY, SERPER_API_KEY or SEARXNG_BASE_URL and select SEARCH_PROVIDER.'],
    },
    {
      id: 'embeddings',
      title: 'Semantic index (clustering, semantic cache)',
      state: embedding.name === 'openai' ? 'ready' : 'degraded',
      summary:
        embedding.name === 'openai'
          ? embedding.detail
          : `${embedding.detail} Recall on paraphrased text is lower than a hosted embedding model.`,
      blocks: [],
      remedy: embedding.name === 'openai' ? [] : ['Set EMBEDDING_PROVIDER=openai and OPENAI_API_KEY for higher-recall embeddings.'],
    },
    {
      id: 'imagery',
      title: 'Original artwork generation',
      state: image.name === 'procedural' ? 'degraded' : 'ready',
      summary:
        image.name === 'procedural'
          ? 'Procedural raster generator active: real, original, seed-reproducible PNG artwork at exact densities, no photoreal rendering.'
          : image.detail,
      blocks: [],
      remedy:
        image.name === 'procedural'
          ? ['Set IMAGE_PROVIDER=openai (OPENAI_API_KEY) or IMAGE_PROVIDER=stability (STABILITY_API_KEY) for photoreal concept art.']
          : [],
    },
    {
      id: 'web_build',
      title: 'Web build + live preview',
      state: 'ready',
      summary: 'esbuild bundles generated projects in a sandboxed process and the preview server serves the real build.',
      blocks: [],
      remedy: [],
    },
    {
      id: 'android_build',
      title: 'Android APK build + signing',
      state: android.ready ? 'ready' : 'unavailable',
      summary: android.ready
        ? `${android.gradle.version ? `Gradle ${android.gradle.version}` : 'Gradle'}, ${android.java.version ? `JDK ${android.java.version}` : 'JDK'}, ` +
          `SDK ${android.platform.version}, build-tools ${android.buildTools.version}. ` +
          (android.keystore.available ? 'Release keystore configured.' : 'Debug keystore will be generated per project.')
        : `Android toolchain incomplete: ${android.missing.join(', ')} missing. APK builds will fail with TOOLCHAIN_MISSING instead of producing an artifact.`,
      blocks: android.ready ? [] : ['APK build', 'APK signing', 'APK download'],
      remedy: android.ready
        ? []
        : [
            'Install a JDK 17+ and Gradle 8.5+.',
            `Install the Android SDK, then: sdkmanager "platforms;android-${cfg.ANDROID_COMPILE_SDK}" "build-tools;${cfg.ANDROID_BUILD_TOOLS}"`,
            'Set ANDROID_SDK_ROOT to the SDK location.',
            'Optionally set ANDROID_KEYSTORE_PATH, ANDROID_KEYSTORE_PASSWORD, ANDROID_KEY_ALIAS, ANDROID_KEY_PASSWORD for release signing.',
          ],
    },
    {
      id: 'scheduler',
      title: 'Daily autonomous cycle',
      state: cfg.SCHEDULER_ENABLED ? 'ready' : 'degraded',
      summary: cfg.SCHEDULER_ENABLED
        ? `Scheduler running in ${cfg.AUTONOMY_MODE} mode; the daily cycle fires on its configured cron expressions.`
        : 'Scheduler disabled: the daily cycle only runs when started manually.',
      blocks: [],
      remedy: cfg.SCHEDULER_ENABLED ? [] : ['Set SCHEDULER_ENABLED=true to run the cycle automatically.'],
    },
  ];

  return {
    capabilities,
    providers: providerStatuses(),
    ready: capabilities.every((c) => c.state !== 'unavailable'),
    generatedAt: new Date().toISOString(),
  };
}
