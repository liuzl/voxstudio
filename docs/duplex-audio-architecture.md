# Duplex audio architecture

Status: Proposed, 2026-07-12

## Scope

VoxStudio needs one conversational-audio design that serves the local `vox`
CLI first and a browser client later. The product must support a user speaking
while synthesized speech is playing, allow a deliberate interruption to stop
the active reply, and avoid treating the product's own playback as user speech.

This document covers real-time capture, playback, acoustic echo cancellation
(AEC), turn control, and transport. It does not change the existing engine
contract for batch ASR, LLM, or TTS requests.

## Decisions

1. Duplex conversation is a shared TypeScript workflow, not a CLI or Web UI
   feature. Platform code owns audio devices and transport; the workflow owns
   turns, cancellation, VAD policy, engine calls, and observable events.
2. AEC is performed at the endpoint that owns both microphone capture and
   speaker rendering. It must not be attempted in a remote engine service.
3. The macOS CLI uses a native audio helper for speaker-mode duplex. The helper
   owns both I/O nodes in one `AVAudioEngine` with voice processing enabled.
   `ffmpeg` plus `ffplay` remains suitable for recording or headset playback,
   but is not an AEC implementation.
4. The browser uses `getUserMedia` echo cancellation and a WebRTC transport.
   LiveKit is the preferred WebRTC room and media adapter, not a dependency of
   the session workflow or model-engine contract. Requested browser constraints
   are verified from the acquired track's settings; they are not treated as a
   guarantee.
5. Every audio, transcript, generation, and playback event carries a session
   and turn identifier. A newer valid user turn cancels all work and buffered
   playback for the previous turn.
6. Turn detection and interruption are policy plug-ins. Manual push-to-talk,
   VAD endpointing, semantic end-of-turn detection, and adaptive interruption
   share the same session state and cancellation contract.

## Non-goals

- Claiming that a cloned voice identifies a person.
- Recording audio or transcripts by default after a session ends.
- Treating VAD alone as proof that a user intended to interrupt.
- Replacing existing one-shot commands such as `vox reply`, `vox say`, or
  batch transcription.
- Requiring LiveKit for local CLI conversations.

## Architecture

```text
                 platform endpoint                         product service

 macOS helper: AVAudioEngine + AEC  -- PCM/event IPC --\
 CLI headset: ffmpeg capture/playback -- PCM/event IPC ----> DuplexSession
 browser: capture AEC + WebRTC -------- LiveKit tracks ---/       |
                                                                  |
                  VAD -> streaming ASR -> LLM -> sentence TTS -> playback
```

`DuplexSession` is platform-neutral code. It consumes clean, timestamped input
PCM frames and emits output PCM frames plus state events. It has no Bun,
browser, LiveKit, Swift, filesystem, or subprocess import. Platform adapters
must provide the following capabilities:

```ts
interface DuplexAudioEndpoint {
  input: AsyncIterable<InputAudioFrame>;       // AEC-cleaned microphone PCM
  play(audio: AsyncIterable<OutputAudioFrame>): PlaybackHandle;
  events: AsyncIterable<AudioEndpointEvent>;   // device, permission, route
  close(): Promise<void>;
}

interface PlaybackHandle {
  done: Promise<void>;
  stop(reason: "barge_in" | "cancel" | "shutdown"): Promise<void>;
}
```

Frames include a monotonic capture/render timestamp, sample rate, channel
count, and `sessionId`/`turnId` where applicable. Platform adapters must use
bounded queues and report overflow; silently accumulating audio is forbidden.

The initial codec inside a local endpoint is PCM16 mono at 16 kHz for ASR and
PCM16 or float PCM at the TTS sample rate for playback. Resampling happens at
the endpoint boundary. WebRTC/LiveKit may use Opus on the network but does not
change the core frame contract.

## Acoustic echo cancellation

AEC needs two synchronized signals:

```text
render reference = the exact PCM submitted to the local output device
capture signal   = microphone PCM = user + speaker leakage + room reflection
```

The endpoint applies an adaptive filter to the capture signal using the render
reference. It then applies residual echo suppression, noise suppression, and
automatic gain control before emitting input frames to `DuplexSession`. The
render reference must be taken before hardware output, not reconstructed from
the received TTS request. Device latency and route changes are part of the
audio endpoint's responsibility.

### macOS CLI endpoint

The first speaker-mode implementation is a small Swift executable under a
future `platforms/macos-audio/` directory. It uses one `AVAudioEngine` for
`AVAudioInputNode`, `AVAudioPlayerNode`, and `AVAudioOutputNode`, enables voice
processing before starting the engine, and exposes a versioned local IPC
protocol to the Bun CLI. It is available only on supported macOS versions and
reports an explicit capability error otherwise.

The helper is deliberately narrow:

- accepts output PCM and renders it through the same engine;
- returns AEC-processed capture PCM and route/device events;
- supports `start`, `stopPlayback`, `setDevice`, `mute`, `health`, and
  `shutdown`;
- never calls ASR, LLM, TTS, stores transcripts, or handles credentials.

Voice processing is configured before the engine starts. A device or route
change that requires reconfiguration moves the endpoint through an explicit
`reconfiguring` state: stop playback/capture safely, rebuild the graph, verify
voice processing, then resume listening. It must not try to toggle voice
processing on a running engine.

For the first CLI release, a wired or USB headset is the supported duplex
baseline. Speaker mode is enabled only after the native helper passes the AEC
test suite. Bluetooth routes are supported as best effort because profile
switching can alter sample rate, latency, and microphone quality.

### Browser endpoint

The Web app requests microphone access with `echoCancellation`,
`noiseSuppression`, and `autoGainControl` enabled. It publishes the microphone
track and renders agent audio through the browser's WebRTC audio path. The
browser and operating system retain control over the exact AEC implementation;
the UI exposes the selected device, active route, and a headset recommendation
when AEC capabilities are unavailable.

After capture starts, the browser reads `MediaStreamTrack.getSettings()` and
records the negotiated AEC/NS/AGC state as an endpoint capability snapshot. A
browser may accept a constraint without providing the desired quality on a
particular route. When AEC is unavailable or fails the route-specific smoke
test, speaker-mode auto-barge-in is disabled and the user can use a headset,
push-to-talk, or explicit stop control. Browser audio requires HTTPS; microphone
permission denial is a first-class recoverable state, not a generic failure.

The browser must not bypass this route by independently capturing with
`MediaRecorder` while playing the agent through an unrelated element. That
breaks the browser's ability to associate capture and render paths. Raw PCM is
processed in an `AudioWorklet` only when a measured requirement cannot be met
by the standard WebRTC path.

### Transport choice

The browser uses LiveKit for authenticated WebRTC media rooms when it connects
to a remote product service. LiveKit carries continuous microphone and agent
audio tracks, plus data messages for state and captions. A LiveKit agent/gateway
adapts tracks to `DuplexSession`; it does not contain turn policy.

The local CLI bypasses LiveKit and connects to `DuplexSession` through local
IPC. This keeps the CLI usable without a room server and makes local-device AEC
testable independently from network conditions.

## Turn state and cancellation

```text
idle -> listening -> speech_started -> finalizing -> thinking -> speaking
 ^        ^                                                   |
 |        +------------------ barge_in -----------------------+
 +--------------------------- shutdown -----------------------+
```

While `speaking`, capture continues. The initial policy requires post-AEC VAD
speech for a configurable minimum duration and level. The threshold is
calibrated by test data; it is not a fixed product constant. It is deliberately
replaceable by a semantic end-of-turn detector or an adaptive interruption
model, which can distinguish a real interruption from short acknowledgements.
On confirmation:

1. mark the active turn `interrupted`;
2. abort streaming ASR/LLM/TTS requests with an `AbortSignal`;
3. invoke `PlaybackHandle.stop()` to discard local output immediately;
4. keep capture frames and begin the new user turn without reopening the
   microphone;
5. ignore late audio, text, or completion events whose turn ID is no longer
   current.

The user can also explicitly mute, stop, or switch back to push-to-talk. These
controls are distinct from VAD and always take precedence.

An interruption is provisional until a policy confirms it. If a VAD-only
interruption later has no usable speech, the session records `false_barge_in`.
The initial CLI does not resume partially played audio because that can be more
confusing than restarting the reply; it offers an explicit replay action. A
future endpoint may resume only from a recorded, timestamped playback
checkpoint after usability tests demonstrate that behavior is preferable.

## Realtime gateway and events

Existing OpenAI-compatible engine endpoints remain valid for one-shot work.
The product adds a realtime gateway above them rather than adding WebRTC
semantics to each engine:

```text
apps/realtime-gateway
  -> packages/duplex-session
  -> packages/clients (ASR, LLM, TTS adapters)
```

The gateway exposes a versioned session event schema over local IPC and, for
remote clients, a WebSocket/data-track control channel. Media is carried as
endpoint PCM or WebRTC tracks, not base64 JSON. Every control message has a
monotonic `sequence`, `sessionId`, and schema version. On reconnect, a client
requests a state snapshot and must not replay stale `stop` or `commit-turn`
commands; commands use an idempotency key.

Minimum event types:

```text
session.state       { state, sessionId, turnId? }
audio.level         { rmsDb, clipped, source }
vad.start|end       { turnId, timestampMs }
transcript.partial|final { turnId, text, confidence? }
response.text.delta|final { turnId, text }
playback.started|ended|interrupted { turnId }
timing              { turnId, captureMs, vadEndMs, asrMs, llmFirstMs,
                       ttsFirstMs, playbackFirstMs }
error               { code, recoverable, turnId? }
endpoint.capability { aec, ns, agc, route, sampleRate }
session.snapshot    { state, currentTurnId, lastSequence }
```

The gateway initially adapts the current file-based ASR and one-shot LLM/TTS
clients: VAD closes a short temporary utterance, ASR transcribes it, then the
reply is generated and played. Streaming ASR, LLM token streaming, and TTS
audio streaming are independent adapter upgrades. The session contract stays
unchanged as those engines improve. The fallback has a maximum utterance
duration and explicit overflow behavior; it never retains an unbounded live
recording while waiting for an engine response.

## Provider requirements

Realtime-capable client methods accept an `AbortSignal`, an optional turn ID,
and emit timing information. The existing `LlmClient.chat()` and
`TtsClient.speech()` are retained for batch commands; new streaming methods are
additive:

```ts
transcribeStream(frames, options, signal): AsyncIterable<TranscriptEvent>
chatStream(messages, options, signal): AsyncIterable<TextDelta>
speakStream(text, options, signal): AsyncIterable<PcmAudio>
```

Sentence segmentation bridges an LLM text stream to TTS. It sends complete
sentences early but preserves unfinished text until a valid boundary or flush.
The playback queue has a duration limit; when it exceeds that limit, the
gateway applies backpressure rather than generating unbounded audio.

## Privacy and safety

- Microphone permission is requested by the endpoint and visibly represented
  in CLI/Web state.
- Raw microphone audio is in memory only by default. Saving a recording is an
  explicit command or UI action with a path/retention choice.
- Transcripts, timing telemetry, and debug PCM are opt-in. Production logs use
  IDs and aggregate counters, not transcript text or raw audio.
- Web session tokens are short-lived and scoped to one room/session. Engine
  credentials never reach the browser.
- WebRTC media and control traffic use TLS/DTLS/SRTP. End-to-end encryption is
  an explicit deployment mode: a server-side agent can process E2EE media only
  when it is admitted as a participant with the required key. It is not claimed
  merely because the LiveKit transport supports E2EE.
- Voice registration keeps consent/provenance as a separate future workflow;
  duplex audio does not loosen that requirement.

## Quality gates

The feature is not accepted based on subjective demos alone. The test corpus
contains replayed agent speech, near-end user speech, double-talk, quiet rooms,
speaker routes, wired headsets, Bluetooth routes, and device changes.

Required measurements per supported endpoint:

- false barge-in rate during agent-only playback;
- missed barge-in rate during overlapping near-end speech;
- echo return loss enhancement (ERLE) and near-end speech distortion;
- capture-to-local-mute latency after a confirmed barge-in;
- VAD end to ASR final, first LLM token, first TTS audio, and audible first
  playback latency (p50/p95);
- queue overflow, device-route change, permission-denied, and cancellation
  recovery tests.
- negotiated AEC/NS/AGC capability coverage by browser, operating system, and
  audio route, with the chosen fallback recorded.

The first release target is deterministic cancellation and no self-interruption
with a wired headset. Speaker-mode AEC requires a separate empirical gate on
supported macOS hardware. Browser and CLI metrics are reported separately.

## Delivery phases

1. **Session contract and test harness**: add `packages/duplex-session`, event
   fixtures, fake endpoint, cancellation/reconnect/idempotency tests, timing
   schema, and bounded-queue tests. No device behavior changes.
2. **CLI headset duplex**: add `vox listen` using continuous capture, VAD
   segmentation, cancellation, bounded playback, and clear headset mode. This
   establishes the user workflow without claiming speaker AEC.
3. **Streaming adapters**: add abortable ASR/LLM/TTS adapters and sentence-level
   LLM-to-TTS pipelining. Keep one-shot engine fallbacks.
4. **macOS audio helper**: build and test the `AVAudioEngine` endpoint with
   Voice Processing, route changes, capability detection, and speaker-mode AEC.
5. **Web Studio realtime**: add a browser endpoint and LiveKit room/gateway,
   reusing the same session events, policy, and provider adapters.
6. **Cross-platform endpoints**: evaluate native platform voice-processing APIs
   or standalone WebRTC APM for Windows/Linux only after the macOS and browser
   measurements demonstrate a concrete gap.

No phase creates empty Web, desktop, or native directories. Each is introduced
with its first tested owned module.

## References

- Apple, [AVAudioIONode voice processing](https://developer.apple.com/documentation/avfaudio/avaudioionode): macOS input and output nodes expose voice-processing controls.
- Apple, [What's new in voice processing](https://developer.apple.com/videos/play/wwdc2023/10235/): macOS 14 availability, AEC/NS/AGC behavior, and `AVAudioEngine` versus `AUVoiceIO` options.
- WebRTC, [Audio Processing Module](https://webrtc.googlesource.com/src/%2B/refs/heads/main/modules/audio_processing/g3doc/audio_processing_module.md): capture and reverse-render streams for AEC, NS, and AGC.
- LiveKit, [Realtime media and data](https://docs.livekit.io/frontends/build/media-data/): WebRTC media tracks and data/state channels for agent clients.
- W3C, [Media Capture and Streams](https://www.w3.org/TR/mediacapture-streams/): browser AEC constraint semantics and route-dependent negotiated settings.
- LiveKit, [Turns overview](https://docs.livekit.io/agents/logic/turns/): turn detection, interruption, false-interruption recovery, and manual control patterns.
