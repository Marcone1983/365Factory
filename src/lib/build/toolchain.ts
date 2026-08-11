import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { config } from '@/lib/config/env';

/**
 * Build toolchain discovery.
 *
 * The Android pipeline is real: it drives Gradle and the Android SDK build
 * tools. When those are absent the platform reports precisely what is missing
 * and fails the build with a TOOLCHAIN_MISSING diagnostic. It never emits a
 * placeholder artifact.
 */

export interface ToolInfo {
  readonly available: boolean;
  readonly path?: string;
  readonly version?: string;
  readonly detail: string;
}

export interface AndroidToolchain {
  readonly java: ToolInfo;
  readonly gradle: ToolInfo;
  readonly sdk: ToolInfo;
  readonly platform: ToolInfo;
  readonly buildTools: ToolInfo;
  readonly apksigner: ToolInfo;
  readonly zipalign: ToolInfo;
  readonly keystore: ToolInfo;
  readonly ready: boolean;
  readonly missing: readonly string[];
}

/**
 * Runs a version probe and returns stdout and stderr combined — `java -version`
 * and several SDK tools report their version on stderr.
 */
function run(command: string, args: string[]): string | null {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: process.env,
  });
  if (result.error) return null;
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

function whichSync(binary: string): string | null {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, binary);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

export function detectJava(): ToolInfo {
  const cfg = config();
  const explicit = cfg.JAVA_HOME ? path.join(cfg.JAVA_HOME, 'bin', 'java') : null;
  const binary = explicit && fs.existsSync(explicit) ? explicit : whichSync('java');
  if (!binary) {
    return { available: false, detail: 'java not found on PATH and JAVA_HOME is unset (JDK 17+ required).' };
  }
  const output = run(binary, ['-version']) ?? '';
  const match = /version "?(\d+)([.\d_]*)"?/.exec(output);
  const major = match?.[1] ? Number.parseInt(match[1], 10) : 0;
  return {
    available: major >= 17,
    path: binary,
    version: match ? `${match[1]}${match[2] ?? ''}` : 'unknown',
    detail: major >= 17 ? `JDK ${major} detected` : `JDK ${major || 'unknown'} detected; the Android Gradle Plugin requires JDK 17 or newer.`,
  };
}

export function detectGradle(): ToolInfo {
  const cfg = config();
  const binary = cfg.GRADLE_BIN && fs.existsSync(cfg.GRADLE_BIN) ? cfg.GRADLE_BIN : whichSync('gradle');
  if (!binary) {
    return {
      available: false,
      detail: 'gradle not found. Install Gradle 8.5+ or set GRADLE_BIN. Generated projects also ship a Gradle wrapper.',
    };
  }
  const output = run(binary, ['--version']) ?? '';
  const version = /Gradle\s+([\d.]+)/.exec(output)?.[1];
  return { available: Boolean(version), path: binary, version, detail: version ? `Gradle ${version}` : 'gradle present but version could not be read' };
}

function findSdkRoot(): string | null {
  const cfg = config();
  const candidates = [cfg.ANDROID_SDK_ROOT, cfg.ANDROID_HOME, process.env.ANDROID_SDK_ROOT, process.env.ANDROID_HOME]
    .filter((c): c is string => Boolean(c));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'platforms')) || fs.existsSync(path.join(candidate, 'build-tools'))) {
      return candidate;
    }
  }
  return null;
}

/** Highest installed build-tools revision, or the configured one when present. */
function pickBuildTools(sdkRoot: string): string | null {
  const dir = path.join(sdkRoot, 'build-tools');
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const wanted = config().ANDROID_BUILD_TOOLS;
  if (entries.includes(wanted)) return wanted;
  const sorted = entries
    .filter((e) => /^\d+\.\d+\.\d+$/.test(e))
    .sort((a, b) => compareVersions(b, a));
  return sorted[0] ?? null;
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function detectAndroidToolchain(): AndroidToolchain {
  const cfg = config();
  const java = detectJava();
  const gradle = detectGradle();
  const sdkRoot = findSdkRoot();

  const sdk: ToolInfo = sdkRoot
    ? { available: true, path: sdkRoot, detail: `Android SDK at ${sdkRoot}` }
    : {
        available: false,
        detail:
          'Android SDK not found. Set ANDROID_SDK_ROOT (or ANDROID_HOME) to an SDK containing ' +
          `platforms/android-${cfg.ANDROID_COMPILE_SDK} and build-tools.`,
      };

  let platform: ToolInfo = { available: false, detail: 'Android SDK missing.' };
  let buildTools: ToolInfo = { available: false, detail: 'Android SDK missing.' };
  let apksigner: ToolInfo = { available: false, detail: 'Android SDK missing.' };
  let zipalign: ToolInfo = { available: false, detail: 'Android SDK missing.' };

  if (sdkRoot) {
    const platformDir = path.join(sdkRoot, 'platforms', `android-${cfg.ANDROID_COMPILE_SDK}`);
    const hasPlatform = fs.existsSync(path.join(platformDir, 'android.jar'));
    platform = {
      available: hasPlatform,
      path: hasPlatform ? platformDir : undefined,
      version: String(cfg.ANDROID_COMPILE_SDK),
      detail: hasPlatform
        ? `Platform android-${cfg.ANDROID_COMPILE_SDK} installed`
        : `Platform android-${cfg.ANDROID_COMPILE_SDK} missing. Install it with: sdkmanager "platforms;android-${cfg.ANDROID_COMPILE_SDK}"`,
    };

    const revision = pickBuildTools(sdkRoot);
    const btDir = revision ? path.join(sdkRoot, 'build-tools', revision) : null;
    buildTools = {
      available: Boolean(btDir),
      path: btDir ?? undefined,
      version: revision ?? undefined,
      detail: revision
        ? `Build tools ${revision} installed`
        : `No build-tools installed. Install with: sdkmanager "build-tools;${cfg.ANDROID_BUILD_TOOLS}"`,
    };

    if (btDir) {
      const apksignerPath = path.join(btDir, 'apksigner');
      const zipalignPath = path.join(btDir, 'zipalign');
      apksigner = fs.existsSync(apksignerPath)
        ? { available: true, path: apksignerPath, detail: 'apksigner available' }
        : { available: false, detail: `apksigner not found in ${btDir}` };
      zipalign = fs.existsSync(zipalignPath)
        ? { available: true, path: zipalignPath, detail: 'zipalign available' }
        : { available: false, detail: `zipalign not found in ${btDir}` };
    }
  }

  const keystorePath = cfg.ANDROID_KEYSTORE_PATH;
  const keystoreConfigured =
    Boolean(keystorePath) &&
    Boolean(cfg.ANDROID_KEYSTORE_PASSWORD) &&
    Boolean(cfg.ANDROID_KEY_ALIAS) &&
    Boolean(cfg.ANDROID_KEY_PASSWORD);
  const keystoreExists = keystorePath ? fs.existsSync(keystorePath) : false;
  const keystore: ToolInfo = {
    available: keystoreConfigured && keystoreExists,
    path: keystoreExists ? keystorePath : undefined,
    detail: !keystorePath
      ? 'No release keystore configured; release builds will be signed with a per-project debug keystore generated by keytool.'
      : !keystoreExists
        ? `Keystore path ${keystorePath} does not exist.`
        : keystoreConfigured
          ? 'Release keystore configured'
          : 'Keystore path set but ANDROID_KEYSTORE_PASSWORD / ANDROID_KEY_ALIAS / ANDROID_KEY_PASSWORD are incomplete.',
  };

  const missing: string[] = [];
  if (!java.available) missing.push('JDK 17+');
  if (!gradle.available) missing.push('Gradle');
  if (!sdk.available) missing.push('Android SDK');
  else {
    if (!platform.available) missing.push(`platforms;android-${cfg.ANDROID_COMPILE_SDK}`);
    if (!buildTools.available) missing.push('build-tools');
    if (!apksigner.available) missing.push('apksigner');
  }

  return {
    java,
    gradle,
    sdk,
    platform,
    buildTools,
    apksigner,
    zipalign,
    keystore,
    ready: missing.length === 0,
    missing,
  };
}

let cached: { value: AndroidToolchain; at: number } | null = null;

/** Cached for 60 seconds; detection shells out and is used by health endpoints. */
export function androidToolchain(force = false): AndroidToolchain {
  if (!force && cached && Date.now() - cached.at < 60_000) return cached.value;
  const value = detectAndroidToolchain();
  cached = { value, at: Date.now() };
  return value;
}
