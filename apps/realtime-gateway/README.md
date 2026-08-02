# realtime-gateway

The Web Studio's server: the duplex session protocol over WebSocket at `/v1/realtime`,
plus a REST facade over the OpenAI-compatible engine contract. The browser talks to this
gateway and never to an engine — engine addresses and credentials stay server-side.

It began as Phase 1 of [docs/web-studio.md](../../docs/web-studio.md); the session contract it
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

Binds `127.0.0.1` by default and never defaults to `0.0.0.0`. Self-hosted
deployments use no authentication by default or an optional bearer token. Hosted
deployments use product-owned accounts and quotas; private allow-listed deployments
may put Cloudflare Access in front. See [docs/auth.md](../../docs/auth.md).

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
  `tool.call|result|pending`, `studio.take`, `command.accepted|duplicate|rejected`,
  and `error`.

Reconnect: the session outlives its socket by a grace period (default 30s). A client
reattaches with `session.attach` and resynchronizes from the pushed `session.snapshot` —
events during the gap are not replayed. Replayed commands are acknowledged
(`command.duplicate`) but never re-executed, and a `turn.interrupt` naming a superseded
turn is rejected as `stale_turn`, so a stale stop can never kill the reply now playing.

`session.start` can select a saved Agent with `agent`; ordinary callers get its latest
published version, while Builder preview can select an exact `agentVersion` or a
revision-checked draft with `agentSource=draft` and `agentRevision`. The remaining options
mirror `vox listen`: `language`, `system`, `maxTokens`, `voice`, named-instance overrides
(`asrEngine`, `llmEngine`, `ttsEngine`),
`studioTools`, `welcome`, `nudgeAfterSeconds`, `bargeIn` (default false —
protected mode until the endpoint has negotiated AEC), `turnTaking` (default
speculative), `reopenMs`, `vad` (Silero where available, loud degrade to
energy), `threshold`, `silenceMs`, and `minSpeechMs`. With `playbackAck`, the
endpoint owns the audible-playback clock: after the last piece is sent the turn
stays `speaking` until the client's `playback.complete` for that turn (capped by
the audio's own duration plus slack), so speech during the still-audible tail
barges in instead of opening a turn beside the playing reply.

## REST facade

The facade covers speech, transcription, chat, the sanitized engine registry,
voice registration and mutation, design profiles, the optional capture library, and the
Agent registry under `/v1/*`. Agent routes provide owner-scoped list/create/get/update/delete,
publish, audit, and immutable version history. `?engine=` explicitly selects a kind-checked
named instance where supported. Hosted deployments additionally expose discovery at
`/agent`, `/llms.txt`, and `/openapi.json`, while Better Auth owns
`/v1/auth/*`. The route catalog in `src/routes.ts` is the authoritative method,
parameter, quota, and demo-policy list and generates the OpenAPI surface.
`GET /healthz` reports liveness. Engine credentials and identifying headers do
not leave the gateway.

## Known limits

- Without `playbackAck`, `playback.ended` means the last piece was sent, not audibly
  finished; endpoints that render audio should always opt in (the web Conversation panel
  does).
- Events emitted while no socket is attached are dropped by design; the snapshot is the
  resync mechanism.
