# Voice agent roadmap: multimodal input / agent executor / unified conversation-and-action

Status: living. Opened 2026-07-28; all three feasibility investigations completed
2026-07-29. Machine and deployment specifics live in the internal ops repo; this
document keeps only the architectural conclusions. Current state is at the end.

## Direction 1: LLM-native audio input (dual-channel user turns)

**Factual basis**: the local conversation LLM (Gemma 4 12B) is natively
multimodal; an internal test on 2026-06-13 confirmed llama.cpp accepts
`input_audio` content for it directly (audio is encoded to tokens by the mmproj
projector) — only video needs the MLX backend or frame extraction. The
llama-server instance conversation currently uses just doesn't mount mmproj:
enabling it is one launch flag away.

**Value**: not an ASR replacement — it restores the layer ASR throws away:
tone/emotion, hesitation and laughter, non-speech sound events, accents and
code-switching. Speaker identity needs sober expectations: an LLM compares
voices acceptably within one context window, but stable cross-session identity
belongs to a voiceprint-embedding sidecar (a CAM++/ECAPA-class small model).
The LLM understands and expresses; the voiceprint decides identity.

**Proposed architecture**: ASR keeps its job (live captions, keyterm
correction, history). The user-turn message body upgrades to two channels:
`input_audio` (raw audio) + the ASR text as a hint. The model fuses them
itself, which is naturally tolerant of ASR typos.

**Risks / open questions (answered by the evaluation below)**: mmproj vs. MTP
compatibility → they coexist, but draft acceleration dies on audio turns
(finding 3); mmproj memory +~1 GB → acceptable; QAT impact on audio
understanding → fine on routine tasks, and the domain-term weakness is not
quantization-related (plain text fails the same way — see the table).

**Offline evaluation results (2026-07-29, 202 real captures from the library +
TTS corpus with known ground truth)**:

| Task | Result |
|---|---|
| ASR correction (clean audio + typo'd hint) | ✅ Perfect — the single wrong character is fixed, everything else preserved verbatim |
| ASR correction (real capture, domain terms) | ⚠️ After ASR heard 「过拟合/欠拟合」 (overfitting/underfitting) as 「过你荷和欠你合」, audio input could not rescue it either (guessed 「权利和责任」) — domain terms still need keyterm biasing; audio is not a cure-all |
| Same/different speaker judgment (8 gold pairs) | ✅ 7/8 — in-context comparison usability exceeded expectations, 1–2.5 s per pair |
| Tone / paralinguistics (qualitative) | ✅ Reasonable descriptions for normal-length utterances (a lone 「诶」 judged as "tentative, probing, seeking confirmation") |

**Three key engineering findings**:

1. **Audio ≤1 s is silently dropped** (the model answers "I hear nothing";
   no audio tokens in the prompt) — padding with silence to ≥2 s restores
   perception. Production ingestion must pad short utterances;
2. Audio costs about **27 tokens/second** — a 5 s utterance ≈ 135 tokens,
   negligible;
3. **MTP and mmproj coexist** (no conflict in one instance), but with audio
   in context the draft acceptance rate falls from ~95% (text-only) to ~19% —
   decode speedup is effectively dead on audio turns; accept the slowdown or
   disable draft for those turns.

**Next (phase B)**: conversation-flow prototype — user-turn message body
becomes `input_audio` (padded) + ASR text hint, behind a session-level
gradual-rollout switch.

## Direction 2: pi as the agent executor

Evaluated as earendil-works/pi (formerly badlogic/pi-mono; a TypeScript agent
toolbox: provider-agnostic LLM client, tool harness, session management).

**Fit**: bun/TS like voxstudio, so it can be embedded in-process;
provider-agnostic, points at a local OpenAI-compatible endpoint with no cloud
tie. Mind the overlap with existing assets: the conversation package already
has typed tools + a spoken-confirmation flow + the MCP tool design
(docs/mcp-tools.md, docs/agent-voice-mcp.md) — pi's increment is the mature
multi-step execution loop and tool ecosystem, not "having tool calls at all."

**Risks**: young project, fast-moving API (the npm scope has already migrated
once; pin versions + isolate behind an adapter); bun compatibility → proven by
the spike; fitting long-running execution to voice-latency constraints → the
spike confirmed pi's native seams suffice (below).

**Spike results (2026-07-29 — verdict: adopt, embed in-process)**:

Identity first: badlogic/pi-mono has migrated to **earendil-works/pi** (the old
GitHub URL redirects); the current npm scope is `@earendil-works/*`
(`@mariozechner/*` is deprecated).

Measured (`pi-agent-core` + `pi-ai` under bun, pointed at the local
llama-server running Gemma 4 12B):

- ✅ `createProvider` + `openai-completions` works out of the box against a
  local endpoint (the official docs carry Ollama/vLLM recipes);
- ✅ A full multi-step tool chain ran clean: write_file → read_file → correct
  summary, three rounds in 6.6 s (12B QAT tool-call adherence is fine for
  simple chains; complex chains still to be assessed);
- ✅ **The integration surface matches voxstudio's needs point for point**:
  `Agent` event stream (`tool_execution_start` → progress narration;
  `text_delta` → speakable channel straight into SentenceAssembler),
  `abort()` → barge-in, the `beforeToolCall` hook → spoken confirmation gate,
  `queueMessage`/steering → conversational turns. Every seam direction 3
  needs exists natively in pi — no MCP indirection layer required;
- ⚠️ One pothole: the README's keyless-provider recipe fails with "No API
  key" in practice; a dummy key works around it (docs/implementation drift).

**Selection verdict**: embed pi-agent-core in the gateway as the executor; the
conversation package keeps the voice-frontend role; wire them per direction 3's
event mapping.

## Direction 3: unified conversation and agent action

**Key design judgment: no monolithic structured-JSON output** — unclosed JSON
cannot be sentence-split, which kills sentence-level streaming and TTS
first-audio. The correct dual channel is the existing tool-calling protocol:

- **text channel = the speakable channel**: naturally streaming, through the
  existing SentenceAssembler → TTS;
- **tool_calls channel = the action channel**: structured and type-safe;
  conversation already implements the `{type:"text"|"tool_calls"}` interleaved
  stream and the spoken confirmation gate for external tools.

Contract via system prompt: what is spoken stays short, colloquial,
conclusions-and-intent only; data, code, and long content go through tools and
artifacts, never into speech.

**Three new pieces to build**:

1. Progress narration: long-task milestone events → one-sentence spoken
   updates (agent event stream → toSpeakable mapping);
2. Interruption semantics: barge-in currently only stops playback; once
   unified, the proposal is "interruption stops the mouth; only an explicit
   'stop' stops the hands (through the confirmation gate)";
3. A `speak` tool: the agent's explicit channel for talking mid-execution,
   complementing the passive text stream.

**Dependencies**: the executor is decided (pi, direction 2); the event mapping
table is in direction 2's spike verdict. Direction 1 is its input upgrade (an
agent that hears tone) and can proceed in parallel, later.

## Ecosystem evaluation and watchlist (2026-07-29 hands-on addendum)

**audio.cpp (0xShug0; ggml-based all-in-one audio inference framework, 35+
model families)** — fully hands-on tested (M3 Max Metal build; clone / design /
streaming / ASR / VAD / forced alignment all exercised):

| Verdict | Evidence |
|---|---|
| ✅ **Qwen3-ASR-0.6B adopted** (final-pass revision tier, shipped) | Mandarin gold transcript character-perfect; nails 「过拟合/欠拟合」 in one shot where funasr (SenseVoice) and Gemma+audio both fail; ~0.5 s/utterance resident, RTF 0.15. Wiring: `revise=true` bypass in the funasr adapter (engines/qwen3-asr-revision/) |
| ❌ No TTS engine change | Their voxcpm2 on Metal is RTF 1.46 / qwen3_tts 1.18 (neither realtime) vs. our 0.41–0.63. Causes: the conv_transpose occupancy defect (the very kernel we fixed, still unmerged upstream) + per-step host round-trips between modules |
| ❌ Mandarin streaming-ASR gap still open | Nemotron 0.6B is fast but ~6% CER and misses every domain term; Voxtral 4B has substitutions + truncation + no punctuation. **Speculative turn-taking still has no Mandarin engine** |
| ➖ Bundled Silero VAD works but adds nothing for us | Its streaming `speech_start` events are fine, but voxstudio already embeds the same Silero v5 in-process (platforms/bun/silero.ts, the conversation default with an energy fallback) — no reason to route through it |
| ⚠️ Qwen3 forced aligner usable, but not the badcase tool of choice | Clean timestamps (0.16 s/char); a ghost sentence merely gets compressed (0.099 s/char) rather than flagged — ASR round-trip comparison with Qwen3-ASR is the more direct TTS badcase detector |
| No fork; cherry-pick + contribute upstream | One-month-old project shipping daily: a deep fork means rebase hell. Their CONTRIBUTING has no anti-AI clause, so our Metal conv_transpose occupancy fix went straight upstream: [0xShug0/audio.cpp#149](https://github.com/0xShug0/audio.cpp/pull/149) (AudioVAE decode 10.23 s → 1.81 s, bit-identical output) |

**Side discovery**: voice design (the `(style description)` prefix) is a prompt
convention of the VoxCPM2 model itself — our engine supported it all along; the
server merely demanded a `voice` parameter. Now optional
(liuzl/VoxCPM.cpp `9c5733c`); design mode works on the offline, SSE, and
streaming paths.

**Moonshine (moonshine-ai)** — watch only: Mandarin CER 25.76%, no Mandarin
streaming. Its thesis — streaming ASR as the default architecture — is right;
re-evaluate when it (or anything else) covers Mandarin.

**Watchlist triggers**: audio.cpp gains a Mandarin-capable streaming-ASR
family, or its voxcpm2 Metal path drops below RTF 0.7 after the occupancy fix
merges → re-evaluate.

## Current state and next steps (2026-07-29)

All groundwork is done:

| Item | State |
|---|---|
| Direction 1 offline evaluation | ✅ Done — dual-channel input is viable; three engineering constraints known (pad short audio / token cost negligible / drop MTP on audio turns) |
| Direction 2 pi spike | ✅ Done — verdict: embed pi-agent-core in-process |
| Direction 3 foundation inventory | ✅ Done — every seam needed exists natively in pi |

Integration work, suggested order:

1. **Direction 3 interruption-semantics design doc** (small; fix the
   interaction contract first: interruption stops the mouth, only an explicit
   stop halts the hands, through the confirmation gate);
2. **pi executor integration**: embed pi-agent-core in the gateway; land the
   event mapping (progress narration, speakable channel, barge-in → abort,
   beforeToolCall → spoken confirmation) and the `speak` tool;
3. **Direction 1 phase B**: dual-channel user-turn message body (padded audio
   + ASR hint) behind a session-level rollout switch — can run in parallel
   with 2. The voiceprint sidecar is its own project.

Addendum (07-29): direction 1's leftover — "domain terms still need keyterm
biasing" — has been solved by a simpler route: the Qwen3-ASR revision tier
(see the ecosystem section) fixes domain terms at the ASR layer, taking most
of the correction pressure off the hint channel.
