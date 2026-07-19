# Public demo hardening

Status: Accepted, 2026-07-19. Phase 1 (the guardrails) delivered the same day —
suite green and the live probe passed (see Phases). What it takes to put the Web
Studio on voxstudio.cc
without donating the host machine to the internet: an access model that is mostly
someone else's product, and three gateway guardrails that are ours.

## Access model (layered, mostly zero-code)

1. **Cloudflare Access in front of the tunnel** — allow-listed emails, one-time
   PIN login, WebSocket-aware, audit log. Who is not on the list never reaches
   the gateway. This layer is configuration, not code, and its concrete setup
   (tunnel id, hostnames, team domain) belongs to the internal ops repo — this
   public repo carries only the placeholder runbook below.
2. **The gateway bearer token** (existing `--token`) stays on as the second
   layer: a shared secret that survives an Access misconfiguration.
3. **The guardrails below** protect the machine when both layers admit someone —
   or when the operator deliberately opens the door wider.

An open self-serve demo (per-visitor tokens with quotas) is a separate, real
feature — priced only when the need is real.

## Gateway guardrails (this repo)

1. **Session capacity** (`--max-sessions`, `VOX_GATEWAY_MAX_SESSIONS`). The
   engines behind a demo are one machine; concurrency is the resource. At the
   cap, a native `session.start` is rejected (`session_capacity`) and an
   OpenAI-dialect connection gets a structured error and a close — the session
   that never starts costs nothing. Attach/reconnect of live sessions is exempt:
   capacity gates new conversations, not resumed ones.
2. **Session duration** (`--max-session-seconds`,
   `VOX_GATEWAY_MAX_SESSION_SECONDS`). A demo conversation ends; a forgotten tab
   does not hold a slot forever. At the ceiling the session emits a
   `session.notice` and stops through the ordinary lifecycle — the same teardown
   an `end_call` reaches, minus the farewell.
3. **Demo mode** (`--demo`, `VOX_GATEWAY_DEMO=1`) — the deployment is
   read-only where it must be:
   - registry writes refuse: `POST /v1/voices`, `DELETE /v1/voices/{id}`,
     `POST /v1/design-profiles` answer 403 `demo_mode`; the voice bank stays
     readable — picking voices *is* the demo;
   - MCP servers are not connected regardless of config: external tools have no
     business in an anonymous-ish demo, and `trust` least of all.

Defaults: all three off. Hardening is a deployment decision, exactly like
binding beyond loopback.

## Runbook shape (placeholders only — concrete values live in the ops repo)

```
cloudflared tunnel:  <tunnel-name> → http://127.0.0.1:<gateway-port>
Access application:  https://demo.<domain>  policy: allow-list emails, OTP login
gateway service:     vox studio --config <config> --token $VOX_GATEWAY_TOKEN \
                       --max-sessions 3 --max-session-seconds 600 --demo
```

The gateway keeps binding loopback; the tunnel is the only ingress. Engine
addresses and credentials never leave the gateway host (the existing facade
contract). Deployment events, the tunnel id, and the machine's name go to the
internal ops log, never here.

## Phases and gates

1. **The three guardrails, flagged and tested.** Unit tests: the cap rejects the
   N+1th native start and the OpenAI dialect start while attach stays exempt; an
   expired session notices and stops while a fresh one does not; demo mode 403s
   every registry write, keeps reads, and refuses to connect MCP. **Gate**: suite
   green; a live gateway started with all three flags behaves as configured
   against real clients.
   **Delivered 2026-07-19.** Four new tests green (cap refuse/reuse, ceiling
   notice-and-stop, demo 403s with reads intact and MCP unconnected, the OpenAI
   dialect's structured capacity error); the live probe with
   `--max-sessions 1 --max-session-seconds 6 --demo`: the second conversation
   was refused `session_capacity` while the first ran, registry writes answered
   403 with `GET /v1/voices` at 200, and the first session noticed the demo
   ceiling and closed on schedule. A same-day adversarial review added three
   hardenings: a stopped session's socket close no longer re-arms the reconnect
   grace (each start/stop/close cycle was retaining the dead session for 30 s —
   a resource gap in exactly the deployment this document is for); guardrail
   env/flag typos fail closed instead of silently running unguarded; and the
   session cap requires an integer.
2. **The ops half** (internal repo): tunnel + Access configuration, the demo
   config file, and the go-live checklist — including rotating the token and a
   teardown drill.
