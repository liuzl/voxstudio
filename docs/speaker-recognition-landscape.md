# Speaker recognition landscape — survey 2026-08-02

Status: research snapshot, surveyed 2026-08-02. Purpose: ground VoxStudio's
speaker/voiceprint decisions in the current state of the field — models,
commercial reality, realtime diarization, anti-spoofing, and what audio LLMs
can and cannot do. Numbers are as reported on the survey date; benchmark
figures across sources use inconsistent protocols, so treat cross-source
comparisons as directional.

## TL;DR

The field split cleanly in 2025–2026: **voiceprint-as-authentication is
retreating commercially** (all three Western hyperscalers retired their
speaker-recognition APIs; adversarial attacks reach 100% success against ASV),
while **speaker signals as personalization/conversation-understanding are
becoming standard voice-agent infrastructure** (diarization is table stakes in
LiveKit/Pipecat and most streaming STT). Technically, SSL frontends have
saturated the classic benchmarks; the hard problems that remain are exactly
the production conditions: short utterances, domain/language transfer,
realtime constraints, and spoofing.

Product conclusion for VoxStudio: treat speaker identity as a **soft
personalization router with graceful degradation** (the smart-speaker
contract, ~8 years of precedent), never as a sole authentication factor (the
bank contract, now collapsing under deepfakes).

## 1. Models and toolkits

**Accuracy is solved on-benchmark; conditions are not.**

- SOTA on VoxCeleb1-O is **0.12% EER** (w2v-BERT 2.0 frontend + MFA/LoRA,
  open weights); KD-guided structured pruning removes 80% of parameters for
  only +0.04% EER — high-accuracy embeddings now fit edge deployments.
  VoxCeleb is effectively saturated; leaderboard numbers no longer
  discriminate for product choices.
- **Out-of-domain collapse is the single most important practical fact**:
  VoxCeleb-trained SOTA models (e.g. ReDimNet2 — MIT license, 0.29% EER at
  12.3M params, best accuracy/compute Pareto today) degrade from ~0.5% to
  **12%+ EER on CN-Celeb**. For Chinese, the only in-domain trained options
  remain the **3D-Speaker family** (CAM++ / ERes2NetV2, ~200k Mandarin
  speakers, Apache 2.0, ONNX-ready). Caveat: 3D-Speaker maintenance is
  slowing (README news stops at 2024-12).
- **Toolkit tiers**: WeSpeaker is the most production-hardened and actively
  maintained classic toolkit (ONNX + MNN, 2025–26 additions include ReDimNet2
  and SSL frontends). **sherpa-onnx is the deployment layer to know** — it
  wraps WeSpeaker, 3D-Speaker, and NeMo speaker models as CPU-runnable ONNX
  across embedded/mobile targets, so the backbone stays swappable.
  SpeechBrain ECAPA (frozen since 2021) and Resemblyzer (2019 GE2E) are
  legacy; do not use for new work. pyannote is for diarization, not as an
  embedding source.
- **Short utterances (1–3 s) are the real product bottleneck** — dialog turns
  are often one second. ERes2NetV2 was designed for this (48–55% relative EER
  improvement at 2–3 s vs ERes2Net). Research directions: hybrid enrollment +
  frame-level re-scoring (Interspeech 2026, with the new VoxPhrase corpus),
  multi-resolution encoders compensating SSL's 20 ms frame shift.
- **Score post-processing beats backbone swaps**: AS-Norm + QMF alone gave a
  32% relative gain in Kiwano's ablation (0.50% → 0.34%). Calibrate
  thresholds on your own enrollment data.
- Licensing trap: toolkit code license ≠ weight license. VoxCeleb-derived
  WeSpeaker/NeMo weights are CC-BY-4.0 (attribution); 3D-Speaker weights are
  Apache 2.0; ReDimNet2 is MIT.
- Open gap worth watching: no public in-domain CN-Celeb evaluation of
  ReDimNet2 exists yet — that benchmark decides whether it can displace
  CAM++/ERes2NetV2 for Chinese.

## 2. Commercial reality

**Western clouds exited voiceprint auth; Chinese vendors stayed; diarization
got promoted.**

- **Retirements**: Azure Speaker Recognition retired 2025-09-30. AWS Connect
  Voice ID reaches end-of-support 2026-05-20 (official migration path:
  Pindrop). Google quietly de-documented Speaker ID. Attributed causes are
  fourfold: real-world accuracy failures (noise/illness/accents), weak
  adoption, better alternatives, and deepfake spoofing — not deepfakes alone.
  Alibaba/iFlytek/Tencent voiceprint services remain live (finance/public-
  security demand, mostly on-prem).
- **Banks demoted rather than deleted voice auth**: 91% of US banks are
  rethinking it (BioCatch), but HSBC (£249M fraud blocked), Lloyds, ANZ still
  ship it — as one factor in a layered stack with liveness/deepfake
  detection. The winner of the retreat is Pindrop-style
  voiceprint+liveness specialists.
- **Voice-agent infra**: diarization is standard (LiveKit's
  `MultiSpeakerAdapter` supports 7 diarization-capable STT plugins; its
  primary-speaker detection is plain RMS loudness). True enrolled-speaker
  identification is rare: **Speechmatics** is the outlier (5–30 s enrollment
  clips, enrolled names appear directly in transcripts, streaming-friendly);
  ElevenLabs Scribe has a batch speaker library. AWS Voice ID's spec — 30 s
  net speech to enroll, 10 s to verify — is a useful floor for
  text-independent enrollment budgets.
- **OpenAI Realtime API has no speaker capability at all**; diarization only
  exists in the file-transcription path (`gpt-4o-transcribe-diarize`). The
  established pattern for live who-said-what on Realtime is a parallel
  third-party STT stream injected as text context.
- **The durable product precedent is smart speakers**: Alexa Voice ID and
  Google Voice Match (~8 years in production) use voiceprints strictly as a
  personalization router — wrong match degrades to a generic experience,
  never grants irreversible authority. That is why they never became a
  deepfake target: there is nothing to steal.

## 3. Realtime diarization

**The paradigm shifted from sliding-window clustering patches to natively
streaming end-to-end models.**

- **NVIDIA Streaming Sortformer** is the self-hosted default: 117M params,
  CC-BY-4.0, an ultra-low 0.32 s latency mode (RTF 0.18), DER 6.6–12.4% on
  2–4-speaker CALLHOME. Its key idea — arrival-order speaker labels (first
  speaker is always spk0) — solves cross-chunk label stability, which is the
  prerequisite for turn attribution and barge-in gating in an agent. Hard
  limits: 4 speakers max (5+ collapses to 42% DER), English + Mandarin focus.
- Academic online SOTA is **LS-EEND** (8 speakers, RTF 0.028 — 6× lighter),
  but without a production toolchain. Commercial: pyannoteAI Live-1
  (sub-300 ms, 8 speakers). Research → LS-EEND; product → Sortformer.
- Deployment consensus is **layering**: the 0.3 s tier does realtime turn
  attribution and suppresses bystander-triggered barge-in; an async offline
  pipeline produces the final high-quality transcript.
- Discipline note: DER is not comparable across sources (collar/overlap/oracle-
  VAD conventions differ wildly). Always re-measure on your own
  Opus/WebRTC-conditioned audio.

## 4. Anti-spoofing

**Voiceprint as a standalone authentication factor is over.**

- Attack side: **Malacopula** adversarial filtering achieves **100% attack
  success** against tested ASV systems; zero-shot TTS (CosyVoice, ElevenLabs,
  and open models) lowered the bar to "a few seconds of reference audio".
  One financial institution logged 8,065 biometric-injection attempts against
  KYC liveness in 8 months of 2025.
- Detection side: lab numbers are inflated. ASVspoof 5's most telling result
  is open-condition (SSL pretraining allowed) beating closed-condition by
  3.7× — detection capability comes mostly from large-scale pretrained
  representations, not anti-spoofing architectures. **RTCFake** (2026-04)
  shows detection degrades sharply under low-bitrate codecs + packet loss +
  realtime constraints — an ASVspoof-trained model dropped onto a WebRTC path
  will underperform its paper numbers.
- Industry consensus: passive liveness + active challenge-response + channel
  fingerprinting + behavioral signals, layered; voiceprint is one signal.
- **VoxStudio-specific angle**: this repo ships cloning-capable TTS (VoxCPM),
  so we sit on both sides of the attack surface. VoxCPM's spoofing rate
  against mainstream ASV is a blank spot in public literature — measuring it
  (Malacopula-style) and considering output watermarking belong on the
  responsible-release roadmap; provenance marking is more reliable than
  after-the-fact detection.

## 5. Audio LLMs cannot hear speakers (yet)

The most architecture-relevant finding: **do not expect an omni model to
handle speaker identity as a side effect.**

- MSU-Bench (16 speaker-centric tasks): open audio LLMs score 0.19–0.56
  (Qwen2.5-Omni at 0.19); the best closed model (Gemini-3-Flash) reaches
  only 0.77.
- SpeakerSleuth: LALMs are dominated by text coherence — **as long as the
  text flows, they miss even an obvious gender switch mid-conversation**.
  Yet with an explicit reference clip they discriminate at ~81%: they can
  hear, they just don't attend unprompted.
- An unmodified speech-aware LLM does speaker verification at >20% EER
  (useless); injecting a frozen ECAPA embedding via adapters recovers ~1%.
  **The only viable architecture today: a dedicated speaker encoder emits
  structured labels, which are fed to the LLM** (SpeakerLM, ECAPA-LLM, AFA
  identity-aware memory — the latter lifts multi-user persona attribution
  from 35.7% to 61.3%).
- Adjacent trends: speaker-attributed ASR is moving from cascades to
  end-to-end serialized output (`[Speaker 1]:` tokens in the transcript);
  on-device personal VAD is production-ready (2 ms algorithmic latency,
  KB-scale models) with `tiny VAD → pVAD/device-addressing → TSE → ASR` as
  the emerging edge stack.

## Implications for VoxStudio

1. **Embedding engine**: Chinese → 3D-Speaker **ERes2NetV2** (short-utterance
   hardened); English/multilingual → WeSpeaker ResNet34; both via ONNX,
   served behind **sherpa-onnx** so backbones stay swappable without touching
   the service. Re-evaluate ReDimNet2 once in-domain Chinese numbers exist.
2. **Contract shape**: a `/v1/audio/speakers` extension family (embed /
   enroll / identify) alongside the existing `/v1/voices` extension keeps the
   OpenAI-compatible boundary. Stateless embedding in the engine layer;
   voiceprint store + accumulation state machine in the orchestration layer
   (192-dim vectors; SQLite suffices to thousands of users); realtime surface
   emits `speaker.identified` / `speaker.changed` events.
3. **Realtime pipeline**: speaker extraction is a parallel side-path off VAD
   segments, never on the latency-critical ASR→LLM→TTS chain. Accumulate
   confidence across turns (unknown → tentative → confirmed) instead of
   judging single short segments. Store the agent's own TTS voiceprint to
   discard echo pickup.
4. **Product contract: copy smart speakers, not banks.** Speaker ID =
   personalization router + target-speaker filtering with graceful
   degradation to an anonymous experience. No sole-factor authentication —
   this is both the security verdict and the commercially validated one.
5. **Cheap wins**: AS-Norm score normalization + thresholds calibrated on our
   own enrollment data outperform backbone upgrades.
6. **Security roadmap items**: measure VoxCPM's ASV spoofing rate; evaluate
   TTS output watermarking; if diarization ships, benchmark DER on our own
   Opus-conditioned audio, not paper numbers.
7. **Track**: AT-ADD 2026 challenge results (Aug 2026), the RTCFake dataset
   (HuggingFace, directly usable for RTC-condition evaluation), pyannote 4.x
   per-dataset DER, ReDimNet2 CN-Celeb evaluations.

## Key sources

Models/toolkits: [3D-Speaker](https://github.com/modelscope/3D-Speaker) ·
[WeSpeaker](https://github.com/wenet-e2e/wespeaker) ·
[sherpa-onnx speaker ID](https://k2-fsa.github.io/sherpa/onnx/speaker-identification/index.html) ·
[ReDimNet2](https://github.com/PalabraAI/redimnet2) ·
[w2v-BERT 2.0 SV, 0.12% EER](https://arxiv.org/abs/2510.04213) ·
[ERes2NetV2](https://arxiv.org/pdf/2406.02167) ·
[Kiwano](https://arxiv.org/html/2606.22369v1)

Commercial: [Azure retirement](https://learn.microsoft.com/en-us/azure/ai-services/speech-service/releasenotes) ·
[AWS Voice ID EOS](https://docs.aws.amazon.com/connect/latest/adminguide/amazonconnect-voiceid-end-of-support.html) ·
[hyperscaler exit analysis](https://idtechwire.com/aws-and-microsoft-exit-voice-biometrics-as-google-pulls-back-amid-deepfake-risks/) ·
[Speechmatics speaker ID](https://docs.speechmatics.com/speech-to-text/realtime/speaker-identification) ·
[LiveKit MultiSpeakerAdapter](https://docs.livekit.io/agents/models/stt/) ·
[Google Voice Match](https://support.google.com/assistant/answer/9071681)

Realtime diarization: [Streaming Sortformer](https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2) ·
[Sortformer paper](https://arxiv.org/abs/2409.06656) ·
[LS-EEND](https://arxiv.org/abs/2410.06670) ·
[pyannoteAI Live-1](https://www.pyannote.ai/blog/introducing-live-1-streaming-diarization) ·
[diart](https://github.com/juanmc2005/diart)

Anti-spoofing: [ASVspoof 5](https://arxiv.org/abs/2408.08739) ·
[ASVspoof 5 evaluation](https://arxiv.org/pdf/2601.03944) ·
[Malacopula](https://arxiv.org/pdf/2408.09300) ·
[RTCFake](https://arxiv.org/pdf/2604.23742) ·
[voice-auth threat survey](https://arxiv.org/html/2508.16843v1)

Audio LLMs: [MSU-Bench](https://arxiv.org/pdf/2606.22868) ·
[SpeakerSleuth](https://arxiv.org/html/2601.04029v2) ·
[ECAPA-LLM](https://arxiv.org/html/2603.10827) ·
[SpeakerLM](https://arxiv.org/html/2508.06372v1) ·
[AFA identity-aware memory](https://arxiv.org/html/2604.25022v1)
