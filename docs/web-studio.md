# Web Studio

Status: Accepted, 2026-07-14. Phase 1 (realtime gateway) delivered 2026-07-15.

## Scope

A browser studio for the voxstudio stack, hosted at **voxstudio.cc**. It is the Web
surface from the product architecture: the same core loop, voice profiles, chunking, and
engines the CLI drives, behind a browser UI — plus the one capability none of its design
lineage has, a live full-duplex conversation.

## Design lineage

The information architecture follows **jamiepine/voicebox** (MIT), the strongest open
studio of this kind: a generation panel, voice-profile management, a captures library
pairing audio with transcripts, and a settings surface. Its own documentation states it
has no bidirectional conversation — generation is batch with async queues. That gap is
this product's centerpiece: the measured conversation loop (sub-2s reply, certified
barge-in, conversation memory) becomes the first tab rather than a missing feature.

Where the lineage and this design diverge, the reasons are recorded in the decisions
below rather than relitigated per feature.

## Decisions

1. **Live conversation is the headline tab.** The studio opens on it. It renders the
   duplex session — captions, turn states, barge-in and reopen events, per-turn timing —
   over the realtime gateway specified in
   [duplex-audio-architecture.md](./duplex-audio-architecture.md); this document does not
   redefine that contract.
2. **Web-first, no desktop shell.** Capabilities that require system integration — global
   hotkey dictation, focus-follows push-to-talk — are physically unavailable to a browser
   and belong to the CLI (which already has them) or a future menubar companion. They are
   never allowed to block or complicate the web app.
3. **The browser talks to one gateway, never to engines.** A thin service exposes the
   realtime session (WebSocket / LiveKit per the duplex doc) and a REST facade over the
   engine contract. Engine addresses and credentials never reach the browser; the duplex
   doc's privacy rules apply unchanged.
4. **Frontend stack: React + TypeScript + Tailwind + Zustand.** Validated by the lineage
   and compatible with the workspace's TypeScript core. Lives in `apps/web`; shared
   contracts come from `packages/contracts`.
5. **Server-side persistence is SQLite at the gateway.** Library metadata, generation
   takes, and capture transcripts. Audio artifacts stay on the filesystem next to it.
6. **Curated engines, not an engine zoo.** The lineage ships seven TTS engines; this
   product ships the certified few behind one contract (quality line + fast lane) and adds
   engines by demonstrated need. The UI selects by *capability* (clone / preset / fast),
   not by engine brand.
7. **Reproducibility is a UI feature.** Design profiles carry SHA-256 fingerprints and
   audit status today; the studio surfaces them as badges and one-click `audit`/`verify`
   actions instead of burying the product's strongest guarantee in a CLI.
8. **Hosting is Cloudflare-native.** Static assets on Pages at voxstudio.cc; the gateway
   reached through a tunnel; private deployments gated by Cloudflare Access. A public
   demo mode is a separate, explicit decision with its own abuse and cost review — not a
   default.

## Non-goals

- Global hotkeys or system-wide dictation in the browser (decision 2).
- Supporting every lineage engine (decision 6).
- The multi-track Stories editor in v1 — a large timeline UI, deferred whole.
- Accounts or multi-tenancy in v1: one owner, Cloudflare Access at the door.
- Claiming end-to-end encryption beyond what the duplex document already scopes.

## Panels

1. **对话 Conversation** — live duplex session: mic capture with negotiated AEC (browser
   constraints verified per the duplex doc), agent audio playback, streaming captions,
   visible turn/barge-in/reopen state, per-turn latency readout (the `turn.timing`
   event), push-to-talk and mute as first-class controls.
2. **生成 Generate** — text in, audio out: voice/profile picker, capability toggles
   (clone / design / fast lane), chunking preview for long text, takes history per
   prompt, effect chain slot (v2).
3. **音色 Voices** — registered voices and design profiles with fingerprint badges,
   audit status against the running engine, create/reproduce/verify/audition flows
   mirroring the CLI verbs.
4. **素材库 Library** — the captures surface: every recording/utterance with its
   transcript, re-transcribe, inline correction (feeding the ASR reference workflow),
   promote-to-voice-sample.
5. **设置 Settings** — engine health (the four-slot table), model identities and
   manifests, gateway status, MCP bindings (v2).

## Delivery phases

1. **Realtime gateway** (`apps/realtime-gateway`): the duplex doc's session event schema
   over WebSocket, plus the REST facade. Gate: the existing simulated duplex tests run
   against it; reconnect/idempotency tests from the duplex doc's remaining Phase 1 work.
   **Delivered 2026-07-15.** The conversation loop was extracted into
   `packages/conversation` (one certified implementation behind `vox listen` and the
   gateway — the CLI's simulated duplex suite passes unchanged on top of it), and the
   gateway's own suite covers a simulated turn over a real WebSocket, snapshot resync
   after a dropped socket, duplicate-command acknowledgement, stale-interrupt rejection,
   expired-grace teardown, credential-injecting facade proxying, and token gating.
2. **Conversation panel**: browser endpoint with `getUserMedia` AEC. Gate: the duplex
   doc's browser quality measurements (negotiated-capability snapshot, double-talk and
   barge-in behavior on a real browser/route) — the same discipline as the macOS gate.
   **Implemented 2026-07-15, gate pending.** `apps/web` (React + Tailwind + Zustand)
   ships the studio shell with 对话 as the opening tab: AudioWorklet microphone capture
   resampled to the protocol's 16kHz frames, gapless streamed playback, live captions
   with turn/reopen/false-barge-in state and per-turn timing chips, mute and manual
   stop, and the negotiated AEC/NS/AGC snapshot surfaced in 对话 and 设置. The endpoint
   owns the audible-playback clock via the protocol's `playbackAck`/`playback.complete`
   (a reply stays interruptible through its audible tail). The client/resampler/playback
   math is unit-tested; the real-browser double-talk and barge-in measurement remains
   before the panel is declared supported.
3. **Generate + Voices panels**: REST facade parity with `say`/`voices`/`profiles`.
   Gate: every CLI verb reachable and producing identical artifacts (fingerprints match).
   **Generate and voice-bank flows delivered 2026-07-15**: the facade now proxies the
   full voice registry (list/register/delete, credential-injecting, traversal-safe), the
   生成 panel synthesizes through it with a voice picker, duration/chunk estimate, and a
   takes history, and the 音色 panel lists the bank with one-click audition, registration
   (clone engines), and delete — verified live against the local stack.
   **Design profiles delivered 2026-07-15, closing the phase.** The deferral premise
   was wrong: profiles live on the TTS engine (voices with `design_profile` metadata),
   so the facade only needed `/v1/design-profiles` (routed by the `design` capability)
   and design metadata riding through the union bank. The 音色 panel lists profiles
   with SHA-256 fingerprint badges, audits each against its engine's live model
   identity (`/v1/engines` runtime fields), creates new profiles, and verifies
   reproducibility by regenerating under a throwaway id and comparing fingerprints.
   **Fingerprint-parity gate passed**: a CLI-created profile (`design-calm-clear`)
   reproduced byte-identically through the web path against the live engine.
4. **Library panel**: SQLite persistence, capture ingest from gateway sessions,
   promote-to-sample. Gate (`bun run measure:library`): the ASR reference-correction
   workflow runs end-to-end — a live spoken turn is retained, re-transcribes through
   the facade, corrects, and promotes to a clone voice sample.
   **Delivered 2026-07-20.** The gateway grew a capture store (`bun:sqlite` metadata,
   WAV + `.txt`/`.ref.txt` sidecars on disk — the exact pairing `tools/compare_asr.py`
   scores, so corrected captures feed the ASR reference set with no export step) behind
   an explicit retention opt-in: `vox studio --library DIR` / `VOX_GATEWAY_LIBRARY`,
   off by default, and demo mode keeps it off regardless — a public demo must not
   retain visitor audio. Every finalized utterance (the conversation package's
   `onUtterance`, raw ASR text by design) lands in `/v1/library`; the 素材库 panel
   lists, plays, re-transcribes, corrects inline (the raw transcript is never
   rewritten — the correction lives beside it), promotes with the corrected text as
   the reference transcript, and deletes. Gate passed against the live stack the same
   day; the empty-transcript refusal, demo-off, and capacity paths are unit-tested.
   A same-day adversarial review (codex) added three hardenings, each with its race
   test: per-capture mutation serialization (a delete queues behind a promote's engine
   round-trip instead of leaving the clone engine holding a voice the library no longer
   records, and can no longer resurrect a deleted capture's `.ref.txt`), a draining
   close (shutdown finishes in-flight library work against an open database, then
   closes; late arrivals get a structured 503), and atomic ingest (tmp-file writes
   with the row insert as commit point, plus startup reconciliation that drops
   audio-less rows and sweeps unowned files). **Retention quota delivered 2026-07-21**:
   `--library-max-bytes SIZE` / `VOX_GATEWAY_LIBRARY_MAX_BYTES` (plain bytes or binary
   K/M/G; typos fail closed, a quota without `--library` is refused) bounds retained
   audio. Over quota, the oldest *unpinned* captures are evicted — a capture with a
   human correction or a promotion is curated work and is never auto-deleted; once
   pinned captures alone fill the quota, new ingests are refused with a logged reason,
   so disk stays bounded without touching human work. Enforced at ingest (each victim
   removed through its own mutation queue — an eviction queues behind an in-flight
   promote and re-checks pinnedness under that lock; if the last candidate got
   pinned while the eviction waited, the newcomer itself is rolled back and refused,
   so the bound is hard even under that race — a codex adversarial-review finding,
   2026-07-21) and again on open, where a
   lowered quota takes effect and pre-quota databases gain a backfilled `bytes`
   column. `/v1/library` reports `bytes`/`max_bytes` and the 素材库 panel shows usage
   in the header. All paths unit-tested, including the promote/evict race.
5. **Settings & hosting**: health surface; voxstudio.cc deployment behind Access.
   **Single-binary packaging delivered 2026-07-16**: `vox studio` serves the browser
   app, the realtime WebSocket, and the credential-hiding REST facade from the one
   compiled `vox` executable. The vite build is embedded at compile time —
   `tools/ensure-web-assets.ts` generates a manifest of `with { type: "file" }`
   imports from `apps/web/dist` (or an empty stub without it, so typecheck and tests
   never require a frontend build), and `bun build --compile` packs the files;
   verified by running the binary from an unrelated directory with `dist` removed.
   The gateway serves the shell GET/HEAD-only around the guarded API: the app shell
   loads without the bearer token (a page load cannot carry a header, and the shell
   holds no secrets) while every `/v1` route stays gated; hashed `/assets/*` are
   immutable-cached, the SPA entry revalidates, unknown non-API paths fall back to
   `index.html`. **WASM Silero delivered 2026-07-22**, closing the known limit: the
   compiled binary embeds onnxruntime-web's WASM backend (the `.wasm` and its loader
   as file assets, the same mechanism as the web shell), so barge-in detection runs
   the certified Silero model everywhere — native ONNX runtime in the workspace,
   WASM in the binary, chosen at load with a logged fallback. Probe-measured before
   adoption: outputs identical to the native runtime within 2.4e-7 on shared frames,
   0.2ms per 32ms window. The energy detector remains only as the both-runtimes-failed
   loud fallback. The voxstudio.cc deployment itself remains;
   its access model and gateway guardrails are designed and delivered in
   [public-demo.md](./public-demo.md) — what remains is the ops half (tunnel +
   Access configuration, internal repo).
6. **v2**: effects chain, Stories editor, MCP management panel.

**Shell updates, 2026-07-17…19** (delivered incrementally, each with its commit):
Chinese/English i18n with the source string as the key; the start card reduced to
one decision (the voice — the ASR hint is fixed to auto by measurement); tool
caption chips, including the amber pending-confirmation chip
([mcp-tools.md](./mcp-tools.md)); conversation-etiquette fields in Settings,
persisted in localStorage ([conversation-etiquette.md](./conversation-etiquette.md));
and every tab a URL over the History API — deep links and refresh land on the
right panel through the gateway's existing SPA fallback.

No phase creates empty directories; each is introduced with its first tested module
(the same rule the duplex phases follow).

## References

- [jamiepine/voicebox](https://github.com/jamiepine/voicebox) — IA lineage; MIT.
- [duplex-audio-architecture.md](./duplex-audio-architecture.md) — session contract,
  event schema, browser endpoint requirements, privacy rules, quality gates.
- [product-runtime.md](./product-runtime.md) — core loop and engine contract.
