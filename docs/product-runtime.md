# Product runtime and app architecture

Status: Accepted, 2026-07-10

## Decision

VoxStudio's product-side code will converge on TypeScript. Bun is the workspace,
development, test, and executable-build tool, but shared packages must not depend on the
Bun runtime. Python remains the implementation language for model engines and research
tools. Rust is reserved for native audio or operating-system integration when a measured
need justifies it.

The first migration target is the CLI. Its current Python implementation remains the
behavioral reference until a compiled TypeScript replacement passes the same contract
fixtures and platform checks. The migration must not change the engine HTTP contract or
the user-visible CLI contract.

## Why now

The repository has one product app and a small, tested orchestration core. Web, MCP,
desktop, and mobile apps have not started. Migrating after those apps exist would either
duplicate orchestration in Python and TypeScript or require a larger coordinated rewrite.

The goal is not to put every platform behind one runtime. It is to share contracts and
pure domain behavior while keeping recording, playback, files, credentials, and UI behind
platform adapters.

## Repository target

```text
apps/
  cli/                  compiled Bun executable
  web/                  browser UI and its backend
  mcp/                  stdio and HTTP MCP server
  desktop/              optional Tauri shell and TypeScript UI
  mobile/               mobile client

packages/
  contracts/            engine request, response, and error types
  clients/              OpenAI-compatible HTTP clients
  config/               schema, loading, expansion, and overrides
  text/                 sanitizing, duration estimation, and chunking
  orchestration/        app-independent voice workflows

platforms/
  bun/                  filesystem, process, recording, and playback adapters
  browser/              MediaRecorder and Web Audio adapters
  tauri/                desktop adapters when the desktop app exists

engines/                model-serving processes; Python is allowed here
tools/                  measurement and research programs; Python is allowed here
```

Directories are introduced only when their first owned module is implemented. The target
tree is an ownership map, not a request to create empty placeholders.

## Dependency rules

Shared packages may use TypeScript and standard Web APIs such as `fetch`, `FormData`,
`ReadableStream`, `URL`, `TextEncoder`, `Uint8Array`, and `Float32Array`.

Shared packages must not import:

- `Bun.*` APIs
- Node filesystem or child-process APIs
- browser DOM APIs
- React, Tauri, or mobile framework APIs
- platform-specific native addons

Platform adapters implement narrow capabilities owned by the calling app:

```ts
export interface AudioRecorder {
  record(options: RecordOptions): Promise<AudioSource>;
}

export interface AudioPlayer {
  play(chunks: AsyncIterable<AudioChunk>): Promise<void>;
}
```

The rule is enforced initially by package boundaries and review, then by lint rules once
the package graph exists.

## What remains in Python

`engines/voxcpm2-server` remains Python because it is coupled to PyTorch, CUDA, and the
upstream model package. The measurement programs remain Python because their speaker
encoders and numerical tooling already live in that ecosystem.

The Python `core/` and `apps/cli/` are transitional. They receive correctness fixes while
the replacement is incomplete, but new product surfaces are implemented in TypeScript.

## Why not Rust now

Rust would produce a smaller native CLI and offers stronger native-audio control, but it
would not remove the need for TypeScript in the Web and likely mobile apps. Moving HTTP,
configuration, and orchestration into Rust now would create a binding boundary or duplicate
product logic without addressing a measured bottleneck.

Rust becomes appropriate when at least one of these is demonstrated:

- FFmpeg is an unacceptable installation, licensing, or packaging dependency.
- Full-duplex audio cannot meet its latency or reliability target through platform tools.
- TypeScript PCM processing fails a measured throughput or memory target.
- A desktop feature requires native operating-system integration.
- A small native library materially reduces duplicated platform code.

Any Rust introduction starts as a narrow crate with a stable interface, not a rewrite of
HTTP clients or orchestration.

## CLI compatibility contract

The replacement keeps the `vox` program name and these commands:

```text
vox health
vox say
vox transcribe
vox chat
vox voices list|add|show|rm
```

Existing flags, stdin/stdout behavior, exit codes, JSON output, configuration keys, and
environment overrides remain compatible unless a separately documented breaking change is
approved. Engine errors must retain a stable normalized shape across FastAPI and C++ engine
implementations.

The compiled CLI contains its runtime and TypeScript dependencies. It does not contain
model engines. The first release treats `ffmpeg` and `ffplay` as optional external tools
for recording and playback; commands that do not need them remain self-contained.

## Behavioral parity

Python tests are converted into language-neutral fixtures before their modules migrate.
Both implementations consume the same inputs and expected outputs for:

- engine request bodies and normalized errors
- configuration lookup, expansion, overrides, and validation
- Unicode sanitization and reported dropped characters
- script-aware duration estimates
- exact text chunk boundaries
- WAV decoding, edge trimming, loudness matching, and joining

Audio comparisons specify tolerances explicitly. Text boundaries, sample counts, sample
rates, HTTP fields, and error codes are exact.

## Migration phases

### Phase 0: baseline

- Keep the Python suite green.
- Record the current CLI help for compatibility tests.
- Add shared fixtures without changing behavior.
- Keep unrelated feature commits separate from migration commits.

### Phase 1: workspace and contracts

- Add the root Bun workspace and strict TypeScript configuration.
- Add `packages/contracts` with engine and error types.
- Add formatting, typecheck, and test commands.
- Run Python and TypeScript checks in CI.

### Phase 2: pure core

- Migrate error normalization and HTTP clients.
- Migrate configuration semantics.
- Migrate sanitization, estimation, and chunking against shared fixtures.
- Add orchestration interfaces without platform I/O.

### Phase 3: CLI and platform adapters

- Implement compatible commands in TypeScript.
- Add Bun filesystem and process adapters.
- Keep FFmpeg as the first recording and playback implementation.
- Validate against live ASR, LLM, and TTS engines.

### Phase 4: release

- Build macOS arm64/x64, Linux x64/musl, and Windows x64 artifacts.
- Execute smoke tests on native CI runners even when cross-compilation is available.
- Sign and notarize macOS artifacts and sign Windows artifacts for public distribution.
- Publish checksums and a minimal install path.

### Phase 5: first additional apps

- Build Web next, with credentials and engine access held by its backend.
- Build MCP from the same contracts and clients.
- Start desktop or mobile only after a concrete workflow requires it.

## Python CLI removal gate

The Python CLI is removed only when all of the following are true:

- Shared parity fixtures pass in Python and TypeScript.
- All current commands and flags have compatibility coverage.
- Native CI smoke tests pass on macOS, Linux, and Windows.
- Long-text streaming has been tested against a live TTS engine.
- Voice recording, automatic ASR, editing, and failed-recording recovery are verified.
- Release artifacts have a documented installation and upgrade path.
- One release has been exercised without requiring the Python CLI as a fallback.

Until then, the implementations coexist under explicit names; `vox` continues to point at
the production-ready implementation.

## Release and support policy

Cross-compilation is a build convenience, not a test strategy. Every supported operating
system executes its artifact in CI. Microphone and speaker tests need periodic real-device
checks because hosted CI runners cannot validate permissions, device selection, or audible
output.

The initial supported client matrix is macOS arm64, Linux x64, and Windows x64. Additional
artifacts may be built early, but they are not called supported until they receive native
execution coverage.

## Rollback

Migration phases are additive. The Python CLI remains runnable until the removal gate is
met, and engine contracts do not change. If a TypeScript phase fails, `vox` stays on the
Python entry point while the incomplete package is fixed or removed. No data migration is
required because named voices remain owned by the TTS engine.
