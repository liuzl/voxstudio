---
name: vox-api
description: Reach a hosted voxstudio deployment as an agent — discover its contract from /agent, /llms.txt and /openapi.json, authenticate with an API key over Authorization Bearer, call the OpenAI-compatible /v1 routes for speech, transcription and chat, and recover correctly from 401/403/429/502. Use when asked to speak, transcribe, or manage voices against a voxstudio server (a URL plus an API key), not against a local checkout.
---

# Talking to a hosted voxstudio

A voxstudio deployment serves speech synthesis, transcription, chat, and a live duplex
conversation behind one OpenAI-compatible contract. This skill is only about **reaching
it correctly**: discovery, credentials, calls, and failure handling. What to synthesize,
which voice suits a purpose, or how to design one is not here — for voice-design
discipline on a local checkout, use the `voice-design` skill and the `vox` CLI instead.

Nothing in this skill installs, configures, or runs a deployment. If there is no server
and no key, stop and say so.

## 1. Discover before assuming

Every deployment publishes its own contract. Read it rather than trusting this page:

```bash
curl -s "$VOX_URL/llms.txt"       # compact index: routes, auth, rules
curl -s "$VOX_URL/agent"          # the onboarding page, for humans and agents
curl -s "$VOX_URL/openapi.json"   # OpenAPI 3.1 for the implemented routes
curl -s "$VOX_URL/healthz"        # liveness; `auth` is "accounts" or "self"
```

`/healthz` needs no credential and tells you which kind of deployment you found:

- `"auth": "accounts"` — a hosted deployment. It has the discovery surface above and
  requires an API key. Continue.
- `"auth": "self"` — somebody's own machine, no accounts. There is no key to get and no
  `/agent` page; those paths return the web app. Ask the human how they want you to
  reach it (usually: they run commands themselves, or hand you a gateway token).

The OpenAPI document is the authority on what exists. If a route is not in it, it is not
implemented — do not probe for it.

## 2. Authenticate

A key is minted by a signed-in human in the Studio's settings page (**API 密钥 / API
keys**) and shown exactly once. There is no signup API, no device flow, and no way for an
agent to mint its own. If you have no key, ask for one; do not attempt to register.

Send it on every request. Prefer the first form:

```bash
curl -s "$VOX_URL/v1/voices" -H "Authorization: Bearer $VOX_API_KEY"
curl -s "$VOX_URL/v1/voices" -H "x-api-key: $VOX_API_KEY"      # also accepted
```

Rules that matter:

- A presented key decides the request. A bad key is 401 even if a browser cookie is also
  present — you can never fall back onto somebody's session.
- Never send or try to obtain a cookie. Cookies are the browser's.
- The key carries its owner's full authority. Do not log it, print it into artifacts you
  produce, or forward it to another service.

Because the base URL is OpenAI-compatible, an OpenAI client library works directly:
point `base_url` at `$VOX_URL/v1` and pass the key as the API key.

## 3. Call

```bash
# Speech: text in, WAV out. `voice` is a display name from /v1/voices; omit for default.
curl -s "$VOX_URL/v1/audio/speech" \
  -H "Authorization: Bearer $VOX_API_KEY" -H "content-type: application/json" \
  -d '{"input":"你好，世界","voice":"my-voice"}' -o reply.wav

# Transcription: multipart audio in, {"text": "..."} out.
curl -s "$VOX_URL/v1/audio/transcriptions" \
  -H "Authorization: Bearer $VOX_API_KEY" \
  -F file=@clip.wav -F language=auto

# Chat: the OpenAI shape.
curl -s "$VOX_URL/v1/chat/completions" \
  -H "Authorization: Bearer $VOX_API_KEY" -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"用一句话介绍你自己"}]}'

# What this deployment can do, and whether it is healthy right now.
curl -s "$VOX_URL/v1/engines" -H "Authorization: Bearer $VOX_API_KEY"
```

Working with voices:

- `GET /v1/voices` returns **display names in your owner's namespace**. Use them verbatim.
- Internal engine ids are not part of the contract. A raw one is refused with
  `bad_voice_id` — if you find yourself constructing an id, stop and list instead.
- `POST /v1/voices` (multipart `id`, `text`, `audio`) registers a clone voice. Registering
  someone's voice is a consent decision that belongs to a person: do it only when
  explicitly asked, with audio the asker provided.

Live conversation runs over the WebSocket at `/v1/realtime` with the same auth header. It
is a stateful session protocol, not a REST call; only use it when a task genuinely needs
full-duplex audio, and read the deployment's docs first.

## 4. Recover from failures correctly

| Status | Meaning | What to do |
|---|---|---|
| 401 | Missing, malformed, revoked, or expired key | Stop. Do not retry the same key, do not try other headers. Ask the human for a new key. |
| 403 `demo_mode` | Registry writes are disabled on this deployment | Stop writing. Reads still work. |
| 403 (other) | The action is refused, not unauthenticated | Do not retry. Report it. |
| 404 `library_disabled` | The capture library is off here | Stop asking; it is a deployment choice, not a missing item. |
| 400 `bad_voice_id` | Malformed, too long, or a raw internal id | Re-list `/v1/voices` and use a returned name. |
| 429 `quota_exceeded` | The account's quota for this window is spent | Honor `Retry-After` (seconds) exactly. Do not retry sooner, do not parallelize around it, do not switch keys to evade it — the quota follows the account, not the key. |
| 502 `engine_unreachable` | The engine behind this route is down | Retry with exponential backoff, a few attempts, then report. |
| 503 | The gateway is shutting down | Do not hammer; the connection will not recover. |

Errors are JSON — `{"error":{"message":"...","code":"..."}}`. Branch on `code`, never on
message text. A 429 body adds `retryAfterSeconds` and a `requestId`; the same values ride
the `Retry-After` and `x-request-id` headers, and the id is what to quote when reporting
a refusal you believe is wrong.

## 5. Budget your calls

A hosted deployment may enforce a **per-account quota**: N chargeable operations per
window. Read the real numbers from `/agent` or `/openapi.json` — do not assume, and do not
discover them by getting refused.

- **Chargeable** (each costs one): `POST /v1/audio/speech`, `/v1/audio/transcriptions`,
  `/v1/chat/completions`, `/v1/voices`, `/v1/design-profiles`,
  `/v1/library/{id}/promote`, and starting a realtime session (`session.start`).
- **Free**: every GET (listing voices, engines, captures, fetching audio), correcting or
  deleting a capture, deleting a voice, `/healthz`, and the discovery pages.
- The window is anchored at your first charged call, and a refusal does not extend it.
- The allowance belongs to the **account**, so a human and all their agents share one
  budget. Minting another key does not buy more.

Plan work against this: list before you synthesize, reuse a take instead of regenerating
it, and prefer one realtime session over repeated one-shot calls when the task is
conversational. If you are refused mid-task, report what remains undone rather than
retrying in a loop.

## 6. Etiquette

- Poll no faster than once per 60 seconds. Nothing here needs tailing; `/v1/realtime`
  exists for anything that must be live.
- Synthesis runs on a GPU that serializes. Issue requests **serially** and expect seconds
  per call. Concurrency does not make it faster; it makes it worse for everyone.
- A self-hosted deployment has no SLA. Cache what you fetched, back off on failure, and
  degrade instead of retrying in a loop.
- Every voice and capture belongs to the key's owner. There is no shared pool, no admin
  scope, and no cross-account visibility — if you cannot see something, it is not yours.
- Captures are recordings of humans. Do not copy them out of the deployment.
