# Web Studio

Status: Accepted, 2026-07-14. Not yet started; this document scopes the first delivery.

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
2. **Conversation panel**: browser endpoint with `getUserMedia` AEC. Gate: the duplex
   doc's browser quality measurements (negotiated-capability snapshot, double-talk and
   barge-in behavior on a real browser/route) — the same discipline as the macOS gate.
3. **Generate + Voices panels**: REST facade parity with `say`/`voices`/`profiles`.
   Gate: every CLI verb reachable and producing identical artifacts (fingerprints match).
4. **Library panel**: SQLite persistence, capture ingest from gateway sessions,
   promote-to-sample. Gate: the ASR reference-correction workflow runs end-to-end in UI.
5. **Settings & hosting**: health surface; voxstudio.cc deployment behind Access.
6. **v2**: effects chain, Stories editor, MCP management panel, public demo decision.

No phase creates empty directories; each is introduced with its first tested module
(the same rule the duplex phases follow).

## References

- [jamiepine/voicebox](https://github.com/jamiepine/voicebox) — IA lineage; MIT.
- [duplex-audio-architecture.md](./duplex-audio-architecture.md) — session contract,
  event schema, browser endpoint requirements, privacy rules, quality gates.
- [product-runtime.md](./product-runtime.md) — core loop and engine contract.
