# Research registry

Status: initial historical backfill, 2026-07-30. This registry is incomplete by
design: it records only investigations for which the repository contains
substantive evidence or for which a new measured summary was produced during
the current research session. A project being mentioned elsewhere does not
qualify it for this list.

The registry answers:

- What did VoxStudio investigate?
- Which research domain owns the central question?
- What level of evidence was obtained?
- What decision followed?
- Where is the durable evidence?
- What would cause the decision to change?

It is not a dependency inventory, vendor catalog, roadmap, or claim that
results obtained on one system generalize to every deployment.

## Evidence levels

Evidence levels are cumulative:

| Level | Name | Minimum evidence |
|---|---|---|
| E1 | surveyed | Primary sources and implementation constraints were reviewed. |
| E2 | reproduced | The project was built, run, or exercised in an isolated proof of concept. |
| E3 | measured | Fixed inputs and explicit metrics produced empirical results. |
| E4 | integrated | The capability passed repository tests behind a Vox-owned contract. |
| E5 | field-validated | The integrated path passed a real-device or live-system gate representative of its intended use. |

`E3` does not imply a publication-grade benchmark. Each entry states important
limits. A result without a durable protocol and raw artifact manifest must be
treated as preliminary even when it is useful for an engineering decision.

## Dispositions

| Disposition | Meaning |
|---|---|
| adopted | Current preferred path for a defined role. |
| conditional | Adopted only for a bounded capability, environment, or fallback. |
| candidate | Worth a controlled experiment or adapter, but not promoted. |
| watch | Revisit when a named capability or performance condition changes. |
| not-promoted | Evidence did not clear the current promotion gate. |
| retired | A previously used approach was deliberately removed from a role. |

Disposition is scoped to the stated use case. `not-promoted` is not a universal
judgment about a project.

## Perception and generation

### Acoustic capture and audio front end

| Subject | Evidence | Disposition | Summary | Durable evidence |
|---|---:|---|---|---|
| Apple Voice Processing (`AUVoiceIO`) | E5 | conditional | Provides the macOS speaker-mode AEC/NS/AGC path. It is treated as one opaque voice-processing chain; measured attenuation must not be reported as AEC-only ERLE. Speaker mode remains route- and device-gated. | [`duplex-audio-architecture.md`](../../docs/duplex-audio-architecture.md), [`platforms/macos-audio/README.md`](../../platforms/macos-audio/README.md) |
| Browser `getUserMedia` voice processing | E4 | conditional | Browser AEC/NS/AGC negotiation is integrated, but the browser and operating system own the implementation. The negotiated capability snapshot is surfaced rather than assuming support. | [`duplex-audio-architecture.md`](../../docs/duplex-audio-architecture.md), [`web-studio.md`](../../docs/web-studio.md) |
| Silero VAD v5.1.2 | E5 | adopted | Default in-process VAD for native and web paths, pinned and checksum-verified. It replaced energy-only detection after residual playback and ambient-noise measurements exposed false interruption behavior. | [`duplex-audio-architecture.md`](../../docs/duplex-audio-architecture.md), [`platforms/macos-audio/README.md`](../../platforms/macos-audio/README.md) |
| Energy VAD | E5 | conditional | Retained as a dependency-light fallback and diagnostic control. It is not sufficient evidence of intentional interruption and is more sensitive to ambient noise. | [`duplex-audio-architecture.md`](../../docs/duplex-audio-architecture.md) |

### Speech and acoustic perception

| Subject | Evidence | Disposition | Summary | Durable evidence |
|---|---:|---|---|---|
| SenseVoice-Small via FunASR | E5 | adopted | Mandarin-first realtime-slot ASR with useful zh/en code switching. MPS reduced measured single-utterance inference from roughly 475 ms to 26 ms, making utterance-level batch inference sufficient for the current conversation path. | [`technical-report.md`](../../docs/technical-report.md), [`engines/funasr/`](../../engines/funasr/) |
| Qwen3-ASR-0.6B via audio.cpp | E4 | conditional | Adopted as the optional final revision tier behind `revise=true`, with SenseVoice retained as the low-latency draft and fallback. The evaluation reported an exact Mandarin gold transcript, correction of a domain error, about 0.5 s per utterance, and RTF 0.15. | [`voice-agent-roadmap.md`](../../docs/voice-agent-roadmap.md), [`engines/funasr/server_funasr.py`](../../engines/funasr/server_funasr.py) |
| parakeet.cpp with Nemotron 3.5 ASR 0.6B | E3 | conditional | CPU-compatible multilingual alternative. Prior Mandarin evaluation measured about 6% CER and missed domain terms, so it did not clear the speculative-turn-taking promotion gate. | [`voice-agent-roadmap.md`](../../docs/voice-agent-roadmap.md), [`engines/parakeet/`](../../engines/parakeet/) |
| MOSS Transcribe | E4 | adopted | Owns the long-form and diarization role rather than realtime conversation. The benchmark contract records CER, RTF, speaker/segment counts, and timestamp-boundary error where comparison is valid. | [`engine-registry.md`](../../docs/engine-registry.md), [`tools/README.md`](../../tools/README.md), [`engines/moss-transcribe/`](../../engines/moss-transcribe/) |
| Voxtral through audio.cpp | E3 | not-promoted | Mandarin experiment substituted terms, truncated content, and omitted punctuation. It did not clear the realtime promotion bar. | [`voice-agent-roadmap.md`](../../docs/voice-agent-roadmap.md) |
| Moonshine | E3 | watch | Mandarin CER was measured at 25.76%, and no usable Mandarin streaming path was found. Revisit only after material Mandarin model or streaming changes. | [`voice-agent-roadmap.md`](../../docs/voice-agent-roadmap.md) |
| Microsoft VibeASR.cpp / VibeVoice-ASR-BitNet | E3 | candidate | Official CPU C++ runtime with 1.70 GB I8/I2 GGUF weights. It built unchanged on Apple Silicon. On an M3 Max, one 5.02 s sample reached RTF 0.277 at 12 threads; 16 threads regressed to 0.559. An eight-utterance internal zh/en set produced preliminary normalized character error of 11.2% versus 1.9% for the current SenseVoice service. Context corrected the failed “鱼尾狮” entity exactly. Its “stream server” consumes complete WAV paths and streams output tokens only after full-audio encode/prefill; it is not streaming audio input. The released 1.5B model did not produce the source tree's JSON timestamp/speaker format. | [upstream](https://github.com/microsoft/VibeASR.cpp), [technical report](https://arxiv.org/abs/2607.21075), this registry entry; full protocol and artifacts not yet backfilled |

### Speech and audio generation

| Subject | Evidence | Disposition | Summary | Durable evidence |
|---|---:|---|---|---|
| OpenBMB VoxCPM2, PyTorch runtime | E5 | adopted | Quality TTS role: 48 kHz, multilingual cloning, voice design, prompt caching, continuation, and streamed delivery. Operational work established bounded locking, disconnect-safe generator closure, and Opus transport. | [`technical-report.md`](../../docs/technical-report.md), [`engines/voxcpm2-server/`](../../engines/voxcpm2-server/) |
| liuzl/VoxCPM.cpp | E4 | conditional | Local no-Python clone/design and fallback line. Earlier M3 Max measurements were slower than realtime at the tested settings; later upstream work improved Metal occupancy and added design support. It remains a local/offline fallback rather than the default conversation fast lane. | [`technical-report.md`](../../docs/technical-report.md), [`engines/voxcpm2-cpp/`](../../engines/voxcpm2-cpp/) |
| Kokoro-82M-v1.1-zh | E5 | adopted | Fixed-voice conversation fast lane. It has low first-audio latency and modest resources but no cloning or design; embedded English required an explicit English G2P path. | [`technical-report.md`](../../docs/technical-report.md), [`engines/kokoro/`](../../engines/kokoro/) |
| VoxCPM2 through audio.cpp | E3 | not-promoted | Measured RTF 1.46 in the evaluated Metal path versus VoxStudio's faster existing VoxCPM2 configurations. A 2026-07-31 retest after the merged conv-transpose occupancy fix (0xShug0/audio.cpp#149) measured RTF 0.79–0.84; the AR generator now dominates, the 0.7 re-evaluation trigger was not met, and no engine change followed. | [`voice-agent-roadmap.md`](../../docs/voice-agent-roadmap.md) |
| Qwen3-TTS through audio.cpp | E3 | not-promoted | Measured RTF 1.18 in the evaluated path and did not beat the existing quality or speed roles. | [`voice-agent-roadmap.md`](../../docs/voice-agent-roadmap.md) |
| Audio8-TTS Preview 0.6B | E3 | candidate | Apache-2.0, 44.1 kHz, 11-language zero-shot clone model. A controlled `hu` comparison found both Audio8 and VoxCPM2 highly similar by WavLM proxy (0.940 versus 0.951 mean). Audio8 had calmer, more stable prosody; VoxCPM2's mean F0 range was about 2.4× larger. Steady Audio8 RTF was about 0.49 with 2.1–2.4 GiB peak VRAM versus roughly 0.278 for the resident VoxCPM2 service in the systematic run. Audio8 currently lacks voice design, true output streaming, and a production server. | [upstream](https://github.com/Audio8-AI/Audio8_TTS), this registry entry; full protocol and artifacts not yet backfilled |
| macOS `say` | E3 | not-promoted | Useful as a zero-dependency system chime. Speed was competitive on a sample, but the parametric quality gap was unsuitable for a product voice. | [`technical-report.md`](../../docs/technical-report.md) |

### Multimodal perception, generation, and embodiment

| Subject | Evidence | Disposition | Summary | Durable evidence |
|---|---:|---|---|---|
| VoxStudio lip-sync bridge | E3 | candidate | Proved that streamed VoxStudio audio can drive a desktop character through a bounded mouth-signal bridge. A viseme channel and production avatar runtime remain future work. | [`lipsync-bridge.md`](../../docs/lipsync-bridge.md) |
| Expression-sheet PNGTuber route | E1 | candidate | Lowest-cost image-to-avatar route and recommended first full-chain experiment; amplitude is sufficient for closed/open mouth switching. | [`avatar-from-image.md`](../../docs/avatar-from-image.md) |
| See-through / ComfyUI See-through | E1 | candidate | Promising anime-image layer decomposition that removes manual segmentation and occlusion inpainting, but not Live2D rigging. Needs a local one-image evaluation. | [`avatar-from-image.md`](../../docs/avatar-from-image.md) |
| LivePortrait | E1 | candidate | Self-hostable single-photo talking-head foundation. It consumes generated audio through a neural animation path rather than VoxStudio visemes. | [`avatar-from-image.md`](../../docs/avatar-from-image.md) |
| Ditto TalkingHead | E1 | candidate | Realtime audio-driven motion-space diffusion built on LivePortrait. Requires a dedicated latency, quality, and GPU-residency experiment. | [`avatar-from-image.md`](../../docs/avatar-from-image.md) |
| VASA-3D and SEGA | E1 | watch | Research-frontier single-image Gaussian head avatars; monitored but not selected as implementation dependencies. | [`avatar-from-image.md`](../../docs/avatar-from-image.md) |
| CharacterGen, Make-A-Character 2, and Hunyuan3D route | E1 | watch | Image-to-3D geometry and body rigging are progressing, but automatic VRM facial viseme blendshapes remain the blocking link. Re-survey when that gap changes. | [`avatar-from-image.md`](../../docs/avatar-from-image.md) |

## Cognition, dialogue, and memory

### Language, reasoning, and knowledge

| Subject | Evidence | Disposition | Summary | Durable evidence |
|---|---:|---|---|---|
| Gemma 4 12B QAT through llama.cpp | E5 | adopted | Current local conversation LLM role behind an OpenAI-compatible llama-server. Apple Silicon guidance disables the MTP draft path until it provides a measured benefit without regressions. | [`engines/llamacpp/README.md`](../../engines/llamacpp/README.md), [`technical-report.md`](../../docs/technical-report.md) |
| Native LLM audio input | E3 | candidate | Offline evaluation found audio input viable for paralinguistic information and typo correction, with short-audio padding, history retention, and MTP interaction as known constraints. It complements rather than replaces ASR. | [`voice-agent-roadmap.md`](../../docs/voice-agent-roadmap.md) |

### Dialogue intelligence and social interaction

| Subject | Evidence | Disposition | Summary | Durable evidence |
|---|---:|---|---|---|
| Speculative turn-taking and reopen | E5 | adopted | Soft finalization and bounded reopening reduce avoidable delay while preserving correction when the user continues speaking. Promotion is based on real-device barge-in and interruption gates, not VAD alone. | [`duplex-audio-architecture.md`](../../docs/duplex-audio-architecture.md), [`technical-report.md`](../../docs/technical-report.md) |
| OpenAI Realtime compatibility | E4 | adopted | The gateway implements the compatibility surface while preserving Vox-owned turn state, engine routing, authentication, and cancellation behavior. | [`openai-realtime-adapter.md`](../../docs/openai-realtime-adapter.md), [`duplex-audio-architecture.md`](../../docs/duplex-audio-architecture.md) |
| Conversation etiquette layer | E4 | adopted | Separates social behavior such as concise spoken acknowledgements from core tool and turn semantics. Measured gates cover false triggers and policy adherence. | [`conversation-etiquette.md`](../../docs/conversation-etiquette.md) |

## Agency, tools, and extensions

### Agent reasoning, planning, and execution

| Subject | Evidence | Disposition | Summary | Durable evidence |
|---|---:|---|---|---|
| earendil-works/pi `pi-agent-core` | E3 | conditional | Feasibility spike completed a local OpenAI-compatible write → read → summarize chain in three tool rounds and 6.6 s. Adopt behind a Vox-owned adapter; the production dependency and gateway/session integration are not complete. | [`voice-agent-roadmap.md`](../../docs/voice-agent-roadmap.md), [`agent-lifecycle.md`](../../docs/agent-lifecycle.md) |
| Vox agent execution sandbox and tool broker | E1 | candidate | Security boundary and promotion gates are accepted, including filesystem, network, credentials, resource controls, effect commit points, and outcome integrity. A real isolated runner is not yet implemented. | [`agent-execution-sandbox.md`](../../docs/agent-execution-sandbox.md) |

### Tools, MCP, skills, and extension ecosystem

| Subject | Evidence | Disposition | Summary | Durable evidence |
|---|---:|---|---|---|
| MCP client tool bridge | E4 | adopted | Configured MCP tools join the conversation with deterministic name handling, typed arguments, effect policy, cancellation, and measured tool-selection gates. | [`mcp-tools.md`](../../docs/mcp-tools.md) |
| VoxStudio MCP server | E4 | adopted | Exposes Vox speech, transcription, generation, and curation capabilities to external agents without treating MCP as a live duplex transport. | [`agent-voice-mcp.md`](../../docs/agent-voice-mcp.md), [`apps/mcp/`](../../apps/mcp/) |
| Voice-design skill | E4 | adopted | Defines reproducible create, compare, register, audit, and reproduce behavior with explicit seeds and model/artifact hashes. | [`skills/voice-design/`](../../skills/voice-design/) |
| Vox API skill | E4 | adopted | Defines discovery-first, authenticated use of a hosted Vox deployment, including capability checks, retries, budgets, and conversational etiquette. | [`skills/vox-api/`](../../skills/vox-api/) |

## Runtime, platform, and operations

### Runtime, orchestration, and distributed systems

| Subject | Evidence | Disposition | Summary | Durable evidence |
|---|---:|---|---|---|
| Multi-engine registry and explicit route selection | E5 | adopted | Separates engine instances, role defaults, capability routing, and explicit user choice. Invalid explicit selections fail rather than silently falling back. | [`engine-registry.md`](../../docs/engine-registry.md), [`technical-report.md`](../../docs/technical-report.md) |
| Long-text TTS chunking and continuation | E4 | adopted | Uses predicted speech duration, language-aware seams, bounded chunk size, trimmed edges, loudness matching, and continuation state. Measurements explicitly account for stochastic duration and timbre drift. | [`chunking.md`](../../docs/chunking.md), [`tools/README.md`](../../tools/README.md) |

## Trust, safety, and governance

### Security, privacy, identity, and governance

| Subject | Evidence | Disposition | Summary | Durable evidence |
|---|---:|---|---|---|
| Vox authentication and identity model | E4 | adopted | Separates human sessions, machine API credentials, ownership, quota, and bounded operator capability. Public-demo restrictions remove writes and external MCP connectivity. | [`auth.md`](../../docs/auth.md), [`public-demo.md`](../../docs/public-demo.md) |
| Agent effect and confirmation policy | E4 | adopted | Read, session, and external effects have distinct execution rules. External effects require confirmation unless explicitly operator-trusted; invocation identity prevents duplicate confirmed actions. | [`agent-lifecycle.md`](../../docs/agent-lifecycle.md), [`tool-loop.md`](../../docs/tool-loop.md) |

## Evaluation and systems

### Evaluation science and reproducibility

| Subject | Evidence | Disposition | Summary | Durable evidence |
|---|---:|---|---|---|
| TTS speech-rate and timbre-drift instruments | E3 | adopted | Measurement scripts preserve repeated sampling, held-out validation, language/script caveats, and report-only reanalysis. They are instruments, not CI tests. | [`tools/README.md`](../../tools/README.md) |
| Long-form ASR benchmark contract | E3 | adopted | Records CER, RTF, speaker and segment count, and timestamp-boundary error only when segment alignment makes that comparison meaningful. Private media and transcripts remain outside the public repository. | [`tools/README.md`](../../tools/README.md), [`benchmark_longform_asr.py`](../../tools/benchmark_longform_asr.py) |

## Maintenance rules

Add an entry only when:

1. the subject received substantive source review, reproduction, measurement,
   integration, or field validation;
2. a concise decision and scope can be stated;
3. a durable evidence link or an explicit backfill gap is recorded;
4. private infrastructure, credentials, personal paths, and sensitive data are
   absent.

Update an entry when:

- a new evidence level is reached;
- the intended role or promotion gate changes;
- a model or runtime revision materially changes the result;
- a prior conclusion is contradicted;
- the missing protocol and artifact record is backfilled.

Do not silently rewrite a historical result to match a new model version.
Create a new experiment record, link it, and update the disposition with the
date and reason.

