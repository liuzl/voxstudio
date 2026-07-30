# Product runtime and app architecture

Status: Accepted, 2026-07-10; migration delivered. The compiled TypeScript/Bun
CLI, Web Studio, and MCP surface now share the workspace core. Migration phases
and removal gates below are retained as the historical decision record.

## Decision

VoxStudio's product-side code has converged on TypeScript. Bun is the workspace,
development, test, and executable-build tool, but shared packages do not depend
on the Bun runtime. Model servers keep the runtime appropriate to their
upstream implementation (Python or C++); measurement tools use TypeScript for
product gates and Python for scientific/numerical analysis. Operating-system
integration may use a narrow platform-native helper, as the macOS Swift audio
host does.

The first migration target was the CLI. Its Python implementation remained the
behavioral reference until the compiled TypeScript replacement passed the same
contract fixtures and platform checks. The migration did not change the engine
HTTP contract or the user-visible CLI contract; the Python CLI has since been
removed.

## Why now

The repository has one product app and a small, tested orchestration core. Web, MCP,
desktop, and mobile apps have not started. Migrating after those apps exist would either
duplicate orchestration in Python and TypeScript or require a larger coordinated rewrite.

> *Update 2026-07-19*: the argument above carried — the migration happened while it was
> still cheap, and the apps then arrived on the shared TypeScript core as planned: the
> Web Studio ([web-studio.md](./web-studio.md)) and the MCP surface (`apps/mcp`,
> [agent-voice-mcp.md](./agent-voice-mcp.md); stdio delivered, HTTP is its phase 2).
> Desktop and mobile remain open. The rationale below is kept as written.

The goal is not to put every platform behind one runtime. It is to share contracts and
pure domain behavior while keeping recording, playback, files, credentials, and UI behind
platform adapters.

## Repository target

```text
apps/
  cli/                  compiled Bun executable
  web/                  browser UI
  realtime-gateway/     WebSocket sessions, REST facade, auth, and persistence
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
  macos-audio/          Swift voice-processing capture/playback helper
  browser/              MediaRecorder and Web Audio adapters
  tauri/                desktop adapters when the desktop app exists

engines/                model-serving processes and deployment entries; Python/C++ allowed
tools/                  TypeScript product gates and Python research instruments
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

## What remains outside the shared TypeScript core

`engines/voxcpm2-server` remains Python because it is coupled to PyTorch, CUDA, and the
upstream model package. C++ engine entries follow their upstream native
runtimes. Scientific measurement programs remain Python where their speaker
encoders and numerical tooling already live in that ecosystem; live product
acceptance gates are TypeScript where they exercise the shipped orchestration.

The transitional Python `core/` and `voxcli` fallback served as the migration's parity
oracle and were retired in 2026-07 once the TypeScript side had moved past them.
`tools/voxkit.py` keeps the minimal mirror the measurement scripts need, pinned to the
shared `fixtures/text/` contract.

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

## Historical migration phases

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
- Publish checksums and a minimal install path.
- Deferred until external distribution: signing and notarizing macOS artifacts and
  signing Windows artifacts. Self-hosted installs verify `SHA256SUMS` instead.

### Phase 5: first additional apps

- Build Web next, with credentials and engine access held by its backend.
- Build MCP from the same contracts and clients.
- Start desktop or mobile only after a concrete workflow requires it.

## Historical Python CLI removal gate

The Python CLI was removed only after all of the following were true:

- Shared parity fixtures pass in Python and TypeScript.
- All current commands and flags have compatibility coverage.
- Native CI smoke tests pass on macOS, Linux, and Windows.
- Long-text streaming has been tested against a live TTS engine.
- Voice recording, automatic ASR, editing, and failed-recording recovery are verified.
- Release artifacts have a documented installation and upgrade path.
- One release has been exercised without requiring the Python CLI as a fallback.

Until that gate passed, the implementations coexisted under explicit names and
`vox` continued to point at the production-ready implementation.

## Release and support policy

Cross-compilation is a build convenience, not a test strategy. Every supported operating
system executes its artifact in CI. Microphone and speaker tests need periodic real-device
checks because hosted CI runners cannot validate permissions, device selection, or audible
output.

The initial supported client matrix is macOS arm64, Linux x64, and Windows x64. Additional
artifacts may be built early, but they are not called supported until they receive native
execution coverage.

## Rollback

The migration phases were additive. The Python CLI remained runnable until the
removal gate was met, and engine contracts did not change. If a TypeScript
phase failed, `vox` stayed on the Python entry point while the incomplete
package was fixed or removed. No data migration was required because named
voices remained owned by the TTS engine.
