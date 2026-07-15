# realtime-gateway

The Web Studio's server: the duplex session protocol over WebSocket at `/v1/realtime`,
plus a REST facade over the OpenAI-compatible engine contract. The browser talks to this
gateway and never to an engine — engine addresses and credentials stay server-side.

This is Phase 1 of [docs/web-studio.md](../../docs/web-studio.md); the session contract it
speaks is specified in [docs/duplex-audio-architecture.md](../../docs/duplex-audio-architecture.md).
The conversation behavior itself — VAD segmentation, provisional barge-in, speculative
turn-taking, the streaming reply pipeline — is `@voxstudio/conversation`, the same loop
`vox listen` runs.

## Run

```bash
bun run apps/realtime-gateway/src/main.ts --config voxstudio.yaml --port 8790
# or with a token at the door:
VOX_GATEWAY_TOKEN=... bun run apps/realtime-gateway/src/main.ts
```

Binds `127.0.0.1` by default. Exposing it is a deployment decision: a tunnel in front,
Cloudflare Access at the door (web-studio decision 8) — never a `0.0.0.0` default.

## Protocol (v1)

Control is JSON text frames; media is binary frames, never base64 JSON.

- **Client → server binary**: mono float32 PCM at 16kHz, raw samples. The gateway stamps
  timestamps server-side from the sample count, so client clocks stay out of the protocol.
- **Server → client binary**: mono float32 reply audio; the sample rate is announced by
  the preceding `playback.format` event.
- **Commands** (all carry `v` and a unique `idempotencyKey`): `session.start {options}`,
  `session.attach {sessionId}`, `session.snapshot.request`, `turn.interrupt {turnId}`,
  `playback.complete {turnId}`, `session.stop`.
- **Events** all carry `v`, a monotonic `sequence`, `sessionId`, and `timestampMs`: the
  duplex kernel's events (`session.state`, `turn.*`, `vad.end`, `turn.timing`,
  `audio.*`) plus `transcript.final`, `response.text.delta|final`, `playback.format`,
  `playback.ended|interrupted`, `session.snapshot`, `session.notice`,
  `command.accepted|duplicate|rejected`, and `error`.

Reconnect: the session outlives its socket by a grace period (default 30s). A client
reattaches with `session.attach` and resynchronizes from the pushed `session.snapshot` —
events during the gap are not replayed. Replayed commands are acknowledged
(`command.duplicate`) but never re-executed, and a `turn.interrupt` naming a superseded
turn is rejected as `stale_turn`, so a stale stop can never kill the reply now playing.

`session.start` options mirror `vox listen`: `language`, `system`, `maxTokens`, `voice`,
`bargeIn` (default false — protected mode until the endpoint has negotiated AEC),
`turnTaking` (default speculative), `reopenMs`, `vad` (silero where available, loud
degrade to energy), `threshold`, `silenceMs`, `minSpeechMs`, plus `playbackAck`: with it,
the endpoint owns the audible-playback clock — after the last piece is sent the turn stays
`speaking` until the client's `playback.complete` for that turn (capped by the audio's own
duration plus slack), so speech during the still-audible tail barges in instead of opening
a turn beside the playing reply.

## REST facade

`POST /v1/audio/speech`, `POST /v1/audio/transcriptions`, `POST /v1/chat/completions`,
`GET /v1/voices` forward to the configured engines with credentials injected server-side;
`GET /healthz` reports liveness. Body and status pass through; engine-identifying headers
do not.

## Known limits

- Without `playbackAck`, `playback.ended` means the last piece was sent, not audibly
  finished; endpoints that render audio should always opt in (the web Conversation panel
  does).
- Events emitted while no socket is attached are dropped by design; the snapshot is the
  resync mechanism.
