# VoxStudio Repository Guide

VoxStudio is a self-hosted, multilingual voice I/O product. ASR, LLM, and TTS
engines sit behind one OpenAI-compatible contract; shared orchestration lives in
the core packages, while CLI, Web, MCP, and future native clients remain thin
surfaces. Read [README.md](./README.md) for the architecture, supported workflows,
and current implementation status.

## Source of truth and repository scope

This public repository owns:

- engine wrappers and reusable deployment templates under `engines/`;
- platform-neutral contracts and orchestration under `packages/`;
- operating-system adapters under `platforms/`;
- product entry points under `apps/`;
- product design, protocols, and reproducible research under `docs/` and
  `research/`.

This repository does not own upstream engine source trees such as
`liuzl/VoxCPM.cpp` or `mudler/parakeet.cpp`. Keep only our wrappers, adapters,
configuration examples, and generic deployment material here. Machine inventories,
deployment timelines, incidents, and host-specific runbooks belong in the private
operations repository.

## Architecture rules

- Engines are accessed only through the shared OpenAI-compatible API:
  `/v1/audio/speech`, `/v1/audio/transcriptions`, `/v1/chat/completions`, and the
  documented extensions such as `/v1/voices` and `/v1/engines`.
- Keep shared packages platform-neutral. Bun, filesystem, process, audio-device,
  and other OS integration belongs in `platforms/` or an application boundary.
- Keep applications thin. Reusable behavior belongs in `packages/`; do not fork
  conversation semantics between CLI, WebSocket, LiveKit, and MCP surfaces.
- Engines are named, capability-routed instances. Do not couple core code to one
  engine implementation or assume that an engine is local.
- Preserve existing fail-closed behavior for authentication, authorization,
  quotas, retention, media limits, and deployment configuration.
- Treat tests and served contracts as executable specifications. When behavior
  changes, update the implementation, focused tests, and relevant documentation
  together.

## Development workflow

The workspace is pinned to Bun 1.3.14. Use Bun rather than npm, pnpm, or yarn.

```bash
bun ci                         # install the locked workspace
bun test path/to/file.test.ts  # run focused tests while iterating
bun run typecheck              # TypeScript checks for core and Web
bun run test:ts                # full TypeScript test suite
bun run build:cli              # Web build + compiled CLI + smoke checks
```

Run the smallest relevant test during development, then run checks proportional
to the change before handing it off. Changes to shared contracts, realtime media,
authentication, release packaging, or generated assets normally require the full
typecheck and TypeScript suite. Native macOS audio has separate build and test
commands documented in `package.json` and `platforms/macos-audio/`.

Python measurement tools use the root `uv` project. Engine directories keep their
own environments and lock files because their platform and model dependencies differ.

## Generated files and runtime data

- Do not hand-edit or commit `dist/`, `apps/cli/src/generated/`, or
  `platforms/bun/src/generated/`. The package scripts regenerate them.
- Do not commit models, generated audio, private transcripts, databases, runtime
  traces, local configuration, or benchmark output unless a documented public
  schema explicitly calls for a small sanitized fixture.
- Keep deployable wrappers and generic runbooks beside their engine under
  `engines/<name>/`. Use placeholders and environment variables instead of real
  machine values.

## Public-repository safety

Never commit:

- secrets, tokens, upstream API keys, cookies, or populated `.env` files;
- Tailnet addresses, private hostnames, machine topology, hardware utilization,
  or other internal infrastructure details;
- personal absolute paths—use environment variables, repository-relative paths,
  or `~` in documentation;
- large models, captured audio, participant data, or private operational logs.

Before committing, inspect the complete diff, preserve unrelated user changes,
and confirm that examples are safe for a public repository. When asked to commit,
follow the repository's existing Conventional Commit style.
