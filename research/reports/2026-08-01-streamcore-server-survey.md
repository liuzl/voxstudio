# StreamCore Server survey: relationship to VoxStudio

Status: E1 source and implementation survey, 2026-08-01. This report records a
candidate and its promotion gates; it does not change VoxStudio's accepted
architecture.

```yaml
taxonomy_version: 1
primary_domain: runtime-orchestration-and-distributed-systems
secondary_domains:
  - reliability-observability-and-operations
  - acoustic-capture-and-audio-front-end
  - dialogue-intelligence-and-social-interaction
evaluation_lenses:
  - interoperability
  - latency-and-throughput
  - robustness
  - maintainability
  - security
system_level: subsystem
evidence_level: E1
disposition: candidate
```

## Decision summary

StreamCore Server is not a direct VoxStudio replacement. Its strongest role is
one layer below VoxStudio: a reference for a realtime media edge that terminates
WebRTC/WHIP, decodes Opus/RTP, and exposes bounded PCM plus control events to a
Vox-owned session.

VoxStudio should retain one authoritative implementation of turn state,
cancellation, tool policy, engine routing, and audible playback completion. A
future experiment may compare a narrow Pion/WHIP adapter with the current
WebSocket PCM transport and the planned LiveKit route. StreamCore's complete
agent pipeline should not be inserted in front of `DuplexSession`, because that
would create two VADs, two turn state machines, and two cancellation owners.

The candidate's scope is therefore:

- **candidate** as a media-edge architecture reference and controlled adapter
  experiment;
- core runtime replacement, agent runtime, provider registry, and plugin security
  boundary are outside this candidate's scope;
- revisit after a Vox-owned proof of concept supplies reproducible transport,
  latency, reconnect, and real-device evidence.

## Research question

What relationship does StreamCore Server have to VoxStudio, which parts can
materially improve VoxStudio, and does the current upstream implementation
justify adoption rather than reference or reimplementation behind a Vox-owned
contract?

## Snapshot and method

The surveyed upstream revision was:

```text
repository: https://github.com/streamcoreai/streamcore-server
branch: main
commit: a5cac73895ebcf61dd1ec5f91671d6c189c61b8a
commit date: 2026-07-29T22:10:36+12:00
license: Apache-2.0
```

The survey reviewed the pinned server README, configuration, Go module,
signaling, peer/session lifecycle, RTP/Opus path, inbound and outbound pipelines,
provider interfaces, plugin runtime, RAG integration, deployment files, and
roadmap. The JavaScript SDK README and interface were also reviewed at its
pinned revision. The Python, Go, and Rust SDKs and SIP server were inventoried
at their public repository HEADs but their implementations were not reviewed or
run. ESP32 support is reported by the server README; no ESP32 repository
revision was independently pinned in this survey.

The server repository was cloned in isolation and `go test ./...` was run with
Go 1.25.4. Every package compiled, but every package reported `[no test files]`;
the revision contains no `_test.go` files.

That compile check is not E2 reproduction. No authenticated WHIP exchange,
browser audio loop, TURN relay, provider-backed conversation, SIP bridge, packet
loss condition, or concurrent-session workload was exercised. Product claims
that depend on those paths remain upstream claims, not locally reproduced
results.

## Layer relationship

```text
browser / mobile / SIP / embedded device
                    │
          WebRTC · WHIP · RTP/Opus
        candidate realtime media edge
                    │
        bounded PCM + control/events
                    │
       Vox DuplexSession + conversation
                    │
       Vox engine registry and clients
                    │
     ASR · LLM · TTS · voices · captures
```

StreamCore starts at the media/network edge. Its server owns Pion peer
connections, WHIP signaling, ICE, RTP/Opus, VAD, STT/LLM/TTS orchestration, and
DataChannel events. VoxStudio starts higher as a multilingual voice product and
engine contract: it owns a reusable conversation loop, a versioned realtime
protocol, OpenAI Realtime compatibility, engine roles/capabilities, voice
cloning and design, capture curation, authentication, quota, and MCP surfaces.

The overlap is the cascaded realtime conversation loop. That overlap is a
boundary to resolve, not a reason to run both loops.

## Capability comparison

| Axis | StreamCore Server at the surveyed revision | VoxStudio at the survey date |
|---|---|---|
| Primary product | Realtime media infrastructure and optional agent runtime | Self-hosted multilingual voice studio and agent voice runtime |
| Browser transport | Pion WebRTC, WHIP, RTP/Opus, DataChannel | Versioned WebSocket control plus binary PCM; WebRTC/LiveKit remains planned |
| NAT traversal | Built-in Pion STUN/TURN option | No owned WebRTC/TURN path yet |
| Turn policy | Energy VAD, faster barge-in VAD, partial-STT confirmation, fixed backchannel suppression | Silero VAD default, certified energy fallback, provisional barge-in, speculative finalize/reopen, audible playback ownership |
| Model integration | Provider-specific Go clients for Deepgram, OpenAI, Ollama, Cartesia, ElevenLabs, and VibeVoice | OpenAI-compatible contract with named instances, role defaults, capability routing, and per-request pinning |
| TTS delivery | LLM sentence production overlaps TTS, while the provider interface returns one complete byte slice per sentence | Streaming speech chunks flow through the shared clients and endpoint-owned playback timeline |
| Events | Small DataChannel schema: transcript, response, state, timing | Versioned turn/session events, timing, reconnect snapshots, idempotent commands, playback acknowledgement |
| Client reach | The server README reports JS, Python, Go, and Rust SDKs, SIP, and experimental ESP32 support. Only the server and JavaScript SDK were source-reviewed here; the other public repositories were inventory-only, and ESP32 was not independently pinned. | CLI, Web Studio, OpenAI Realtime clients, and MCP; desktop/mobile/telephony remain open |
| Voice assets | Provider voice selection; no comparable curation studio in this server | Voice bank, cloning, design profiles, takes, captures, correction, promotion, audit, and reproduction |
| Tools and knowledge | Native/subprocess tools, Markdown skills, inline pgvector/Supabase RAG | Built-in tools, MCP client bridge, Vox MCP server, spoken confirmation, effect policy, and invocation ledger |
| Identity and tenancy | Optional shared JWT/API-key gate around WHIP/token issuance | Self-hosted owner or hosted accounts, human and machine doors, owner-scoped sessions/captures/voices, quota and capacity guards |
| Recovery and scale | In-memory single process; no ICE resume, horizontal coordination, or metrics export | Application-level reconnect grace, snapshot resync, stale/idempotent command handling; still single-node for several stateful services |

## Findings worth carrying forward

### 1. A narrow WHIP media edge is a credible candidate

The upstream signaling surface is intentionally small: create a session with an
SDP `POST`, return a complete SDP answer and session URL, and tear it down with
`DELETE`. The peer owns a send/receive Opus track and an `events` DataChannel.
Pion's shared UDP mux and optional built-in TURN configuration make the design
attractive for a single-node self-hosted deployment.

The architectural idea is more valuable than immediate code reuse. VoxStudio's
platform-neutral PCM frame boundary already permits a WebRTC endpoint without
changing `DuplexSession`. A narrow Go/Pion edge would also fit the existing
runtime rule that native code is introduced only for a measured platform
boundary, not for rewriting contracts or orchestration.

For public or multi-instance hosting, an in-process TURN server is not yet an
obvious preference over a dedicated TURN service or LiveKit. Relay operations,
port allocation, abuse controls, deployment topology, observability, and failure
isolation require their own evidence.

### 2. Keep the Vox turn kernel and event semantics

StreamCore's Go pipeline uses goroutines and bounded channels for RTP read,
decode, STT, agent response, TTS, encode, and send. The separation is useful,
but its lifecycle semantics are weaker than VoxStudio's current contract in
several important places:

- a disconnected peer is closed and a new connection creates a new session;
- the server marks listening after its outbound PCM queue drains plus a grace
  period, rather than after an endpoint acknowledgement of audible completion;
- the public event schema does not express Vox revisions, stale-turn rejection,
  idempotency, snapshot resync, or playback acknowledgement;
- horizontal session coordination and metrics export are roadmap items.

A WebRTC edge should therefore carry or adapt the existing Vox control protocol
over a DataChannel. It must not replace it with the smaller StreamCore event
schema.

### 3. STT-informed backchannel suppression is a useful research direction

StreamCore combines a fast energy detector with partial STT text. Sustained
speech interrupts; a short recognized item is checked against a backchannel
list such as “mm-hmm”, “okay”, or “right”. This is a valuable concept for
distinguishing “I am following” from “stop and let me speak”.

The current implementation should not be copied literally:

- the fixed vocabulary is English-only and not context-sensitive;
- a 600 ms suppression window trades interruption responsiveness for fewer false
  stops;
- the path requires partial STT text, while the upstream OpenAI Whisper adapter
  emits final transcripts only, so behavior depends on the selected provider;
- no upstream tests or multilingual measurements establish the claimed tradeoff.

For VoxStudio, the candidate is a locale-aware `barge_in_candidate` policy
measured against existing double-talk and false-barge-in gates. Mandarin
backchannels such as “嗯”, “对”, and “好的” must be evaluated as interaction
acts rather than blindly added to a token set.

### 4. The SDK shape is useful; duplicating five SDKs is not yet justified

The JavaScript SDK hides microphone permission, WebRTC/WHIP setup, mute state,
remote audio, transcripts, and timing behind a small event API. VoxStudio can
apply the same boundary by extracting a browser media client from the current
Web app when a second browser/mobile consumer exists.

Server-to-server clients already benefit from VoxStudio's OpenAI-compatible REST
and Realtime contracts. Language-specific SDKs should be added only when they
own meaningful media behavior that standard OpenAI clients cannot provide.

### 5. Telephony and embedded support belong at the edge

The server README and project-family repositories report SIP and ESP32 as
transports into the same media runtime. Those transport paths were not executed
in this survey, so this is ecosystem evidence rather than a reproduced
capability. The design still supports VoxStudio's revised positioning:
self-hosting does not exclude telephony, but carrier provisioning is not part of
the product.

A future SIP adapter can terminate a deployment owner's SIP trunk, convert
PCMU/RTP to the chosen media-edge format, and enter the Vox conversation
contract. It should remain an optional edge component rather than introducing
telephone concerns into the Web Studio or engine registry.

### 6. Long-running tools need feedback, but not StreamCore's execution boundary

An interruptible sound after a short grace period is a low-cost way to make a
slow tool feel alive. VoxStudio can test an optional earcon tied to the existing
tool lifecycle and stopped on cancellation or completion.

The upstream plugin runtime is not an acceptable Vox security boundary at the
surveyed revision:

- `confirmation_required` is parsed and exposed by the plugin interface, but
  the pipeline execution path does not check it before calling `Execute`;
- external Python/TypeScript/JavaScript plugins run as ordinary child processes;
- child processes inherit the server environment unless the operator has
  separately constrained it;
- there is a call timeout, but no filesystem, network, credential, process-tree,
  or resource isolation comparable to VoxStudio's accepted sandbox baseline.

This does not make the plugin mechanism unusable for a trusted local operator.
It means its convenience claims and its security properties must be evaluated
separately, and it must not displace Vox-owned effect, confirmation, ledger, and
future runner policy.

## Direct interoperability assessment

StreamCore cannot currently be placed in front of VoxStudio by changing one
base URL:

- its OpenAI LLM configuration has no OpenAI-compatible `base_url` field and
  constructs the default OpenAI client directly;
- its STT, TTS, and LLM factories are provider-specific Go switches;
- the TTS interface expects complete 16 kHz mono linear PCM per synthesis call,
  while Vox engines may return WAV, PCM, or streamed Opus at other sample rates;
- the generic OpenAI-compatible or webhook-style agent backend is explicitly an
  upstream roadmap item;
- its internal turn loop, rather than an external agent, owns conversation
  history, tool rounds, RAG injection, sentence splitting, and synthesis.

Three integration shapes are possible:

1. implement StreamCore STT/LLM/TTS clients for the Vox REST facade, accepting
   duplicate turn orchestration;
2. refactor StreamCore into a media-only edge that forwards PCM and events to
   VoxStudio, keeping Vox as the sole conversation owner but coupling the
   adapter to an upstream fork; or
3. implement an independent Vox-owned Pion/WHIP media edge behind the existing
   Vox PCM and control contract, using StreamCore as an architecture and
   implementation reference without taking a runtime dependency on it.

The third shape is the preferred candidate because it preserves VoxStudio's
existing ownership boundaries and avoids an upstream fork. It is an experiment
proposal, not a decision to ship a new transport today.

## Candidate experiment and promotion gates

### Question

Does a narrow WebRTC/WHIP edge materially improve remote browser connectivity,
bandwidth, AEC association, or network robustness without regressing Vox turn
semantics, latency, maintainability, or self-hosted deployment simplicity?

### Systems under comparison

1. current browser WebSocket control plus binary PCM baseline;
2. Pion/WHIP media edge adapting Opus tracks to the existing Vox PCM endpoint;
3. LiveKit transport adapter, if it is still the planned hosted comparison at
   protocol-freeze time.

The same browser, `DuplexSession`, conversation implementation, engines, text,
voices, network profiles, and hardware class must be used. Transport experiments
must not silently swap VAD, endpointing, TTS chunking, or playback ownership.

### Required observations

- connection setup time and failure classification;
- speech end to first audible reply audio;
- upstream and downstream bandwidth;
- process CPU, memory, goroutine/task count, and bounded queue behavior;
- jitter, packet loss, temporary disconnect, and route-change behavior;
- reconnect/resume outcome and duplicate/stale command behavior;
- false barge-ins, confirmed operator barge-ins, and backchannel handling;
- browser AEC/NS/AGC capability snapshot and real-device double-talk gate;
- shutdown, cancellation, and resource cleanup;
- authentication, TURN credential scope, origin policy, and cross-owner session
  isolation.

Thresholds, network profiles, repetitions, and artifact manifests must be fixed
before interpreting results.

### Evidence progression

- **E2**: build and exercise a local browser → WHIP → adapter → Vox → browser
  audio loop with teardown and cancellation.
- **E3**: run the controlled comparison above with fixed metrics, repetitions,
  raw artifact checksums, and documented limitations.
- **E4**: integrate the selected path behind a Vox-owned endpoint contract and
  pass repository protocol, reconnect, ownership, and regression tests.
- **E5**: pass representative real-browser, real-device, WAN, TURN, AEC, and
  barge-in gates in the intended deployment class.

## Change triggers

Re-survey or promote the candidate when any of the following occurs:

- VoxStudio measures a material limitation in the current remote WebSocket PCM
  path;
- the product commits to mobile, SIP, or embedded realtime clients;
- StreamCore ships tested media-only integration, configurable generic agent
  backends, session resume, or production observability;
- a Pion/WHIP or LiveKit proof of concept clears the fixed Vox promotion gates;
- the upstream license, protocol, provider interfaces, or maintenance state
  materially changes.

Do not promote based on README feature breadth, a successful compile, or a local
happy-path call alone.

## Sources

Primary upstream sources:

- [StreamCore Server repository](https://github.com/streamcoreai/streamcore-server)
  and [pinned README](https://github.com/streamcoreai/streamcore-server/blob/a5cac73895ebcf61dd1ec5f91671d6c189c61b8a/README.md)
- [WHIP signaling implementation](https://github.com/streamcoreai/streamcore-server/blob/a5cac73895ebcf61dd1ec5f91671d6c189c61b8a/internal/signaling/handler.go)
- [Pion peer and DataChannel implementation](https://github.com/streamcoreai/streamcore-server/blob/a5cac73895ebcf61dd1ec5f91671d6c189c61b8a/internal/peer/peer.go)
- [Inbound VAD, STT, and backchannel path](https://github.com/streamcoreai/streamcore-server/blob/a5cac73895ebcf61dd1ec5f91671d6c189c61b8a/internal/pipeline/inbound.go)
- [Agent and sentence/TTS path](https://github.com/streamcoreai/streamcore-server/blob/a5cac73895ebcf61dd1ec5f91671d6c189c61b8a/internal/pipeline/agent.go)
- [Plugin execution path](https://github.com/streamcoreai/streamcore-server/blob/a5cac73895ebcf61dd1ec5f91671d6c189c61b8a/internal/pipeline/pipeline.go)
  and [external process runtime](https://github.com/streamcoreai/streamcore-server/blob/a5cac73895ebcf61dd1ec5f91671d6c189c61b8a/internal/plugin/external.go)
- [Provider configuration](https://github.com/streamcoreai/streamcore-server/blob/a5cac73895ebcf61dd1ec5f91671d6c189c61b8a/internal/config/config.go)
- [JavaScript SDK at the reviewed revision](https://github.com/streamcoreai/js-sdk/tree/714349ef7150c5e202a02b5f2b7b25beea994e5a)
- [Apache-2.0 license](https://github.com/streamcoreai/streamcore-server/blob/a5cac73895ebcf61dd1ec5f91671d6c189c61b8a/LICENSE)

Project-family repository inventory (remote HEADs resolved on 2026-08-01;
listed as upstream ecosystem evidence and not exercised in this survey):

- [Python SDK](https://github.com/streamcoreai/python-sdk/tree/4bf008051ca5545439c7f6303dda46dec4cf4380)
- [Go SDK](https://github.com/streamcoreai/go-sdk/tree/4b6edc639cd275a70a0da1ba97ae673a4bfcc7d8)
- [Rust SDK](https://github.com/streamcoreai/rust-sdk/tree/ce8ab3aa1c1a61e54d0f369f0eed4a256836f2b4)
- [SIP server](https://github.com/streamcoreai/sip-server/tree/2daa5936a6dbd191f2bc183e9338f66dc6c74fbc)

Relevant VoxStudio records:

- [`duplex-audio-architecture.md`](../../docs/duplex-audio-architecture.md)
- [`product-runtime.md`](../../docs/product-runtime.md)
- [`engine-registry.md`](../../docs/engine-registry.md)
- [`openai-realtime-adapter.md`](../../docs/openai-realtime-adapter.md)
- [`mcp-tools.md`](../../docs/mcp-tools.md)
- [`agent-execution-sandbox.md`](../../docs/agent-execution-sandbox.md)
- [`competitive-voice-agents.md`](../../docs/competitive-voice-agents.md)

Apache-2.0 permits reuse subject to its terms. Architectural ideas can be
reimplemented independently; copied implementation code must preserve the
required license and notice obligations.
