# Build system

Two pipelines — web and Android — plus a preview server and a runtime validator
that actually runs what was built.

## Web build

`src/lib/build/web.ts` bundles the generated product with esbuild: TypeScript
and TSX, tree shaking, minification, source maps in development, and a
content-hashed output name. esbuild is loaded lazily through `createRequire`
because it ships a native binary that a bundler must not try to parse.

Output goes to the project's `build/` directory and is copied to `preview/`,
which is what the preview server serves. Every build writes a `builds` row with
its log, duration, diagnostics and output size.

## Android build

`src/lib/build/android.ts` generates a **real Android Gradle project** — not a
template with holes:

- `settings.gradle`, `build.gradle`, `gradle.properties`
- `AndroidManifest.xml` with the resolved application id, permissions and
  intent filters the product actually needs
- a `WebView` host activity configured for the product (hardware acceleration,
  DOM storage, media playback, no debugging in release)
- resources: launcher icons at every density, adaptive icon layers, splash,
  strings, colours, themes, network security config
- the web build output as assets

Then it runs Gradle in the sandbox, signs with a keystore created via `keytool`
if one is not supplied, and **verifies the signature with `apksigner`**,
recording which signature schemes (v1/v2/v3) the artifact actually carries. An
APK whose signature does not verify is recorded as unverified.

### When the toolchain is missing

`src/lib/build/toolchain.ts` detects Java, Gradle, the Android SDK, build-tools,
`apksigner` and `zipalign` before anything is attempted. If any are absent the
build fails with a `TOOLCHAIN_MISSING` diagnostic naming exactly what is missing
and how to install it.

**It produces no artifact.** There is no fallback that writes a file with an
`.apk` extension. An APK that is not a signed APK is worse than no APK: it looks
like success and fails at the only moment that matters.

> Java version detection uses `spawnSync` with stdout and stderr merged, because
> `java -version` writes to stderr and a stdout-only capture reports "unknown"
> for a perfectly good JDK.

## Preview

`src/lib/preview/server.ts` serves a project's built output over HTTP with
correct MIME types, byte-range support and cache headers. It serves only from
that project's `preview/` directory.

**The preview is the real build.** It is not a screenshot, a mock or a
description. If there is no build output there is no preview, and the console
says so. Previews are restored at boot for projects that already have output on
disk.

## Runtime validation

`src/lib/qa/runtime.ts` boots the built product in headless Chromium
(`playwright-core`) and observes it. Fourteen checks, of which the critical ones
fail the run:

| Check | Critical | What it proves |
|---|---|---|
| `boot` | yes | The page loads at all |
| `no_runtime_errors` | yes | No uncaught exception |
| `no_console_errors` | no | Nothing logged an error |
| `scene_load` | yes | The 3D scene reports itself loaded |
| `webgl_context` | yes | A real WebGL 2.0 context exists |
| `rendering` | yes | Draw calls and triangles are non-zero — pixels are being produced |
| `player_spawn` | yes | The player entity exists in the world |
| `input_response` | yes | Synthetic input changes game state |
| `save_load` | yes | State survives a save/load round trip |
| `app_boot` / `renders_content` / `interactive` | yes | Non-game equivalents |
| `performance` | conditional | Frame rate meets its floor |
| `offline_shell` | no | The service worker serves offline |

`rendering` is the check that matters most: a scene can "load" with nothing on
screen. Asserting non-zero draw calls and triangles is what distinguishes a
working product from a black canvas — and it is how a real bug was found, where
the sky dome was placed outside the camera's far plane and rendered black.

### Software rendering

On a server without a GPU, Chromium uses SwiftShader and frame rates are a
fraction of hardware. `detectRenderer()` identifies the software rasteriser,
applies a 3 fps floor instead of the hardware target, and makes the performance
check **non-blocking with an explicit note**. Failing a good product because the
CI machine has no GPU would be a false negative; silently passing it at the
hardware threshold would be a lie. The note says which happened.

## Artifacts

`src/lib/build/store.ts` records every artifact with its SHA-256, size, type and
signature verification state. Downloads go through a permission-checked route
that serves by id, never by a client-supplied path.

## Versions

Every change — agent or operator — commits a version: a full snapshot directory,
per-file changes, and diff statistics. `rollbackTo` restores a snapshot and
records the rollback as a *new* version, so history is never rewritten and the
fact that a rollback happened is never lost.

## Environment in this sandbox

For transparency about what has and has not been exercised here:

- The **web pipeline, preview and runtime validation are fully verified** —
  generated products have been built and driven in headless Chromium with all
  runtime checks passing.
- The **Android pipeline cannot be exercised in this environment**:
  `dl.google.com` is blocked, so the Android SDK cannot be installed. The code
  path is complete and reports `TOOLCHAIN_MISSING` correctly, which is the
  honest behaviour. It has not been run against a real SDK here.
