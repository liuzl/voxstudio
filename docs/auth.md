# Authentication and identity

Status: Accepted, 2026-07-26.

## Scope

How voxstudio gains accounts: identity for the hosted product at **voxstudio.cc** (a
public, self-serve entrance — not an owner-only console), and the explicit guarantee
that the self-hosted product keeps its current zero-auth / optional-token shape
untouched. This document records the architecture review's conclusions and the v1
decisions; it deliberately scopes out everything a first version does not need.

Supersedes one earlier stance: [competitive-voice-agents.md](./competitive-voice-agents.md)
sketched an OIDC-first identity abstraction (Keycloak / Authentik / Cloudflare Access).
That remains right for *enterprise SSO later*, but it is the wrong first move for a
public product entrance: Access-style gating is an allow-list door, it produces no
product-owned user record, and resource ownership built against its JWT claims would be
rebuilt the day real accounts arrive. The hosted product owns its identity; OIDC/SSO
demotes to a future plugin.

## Where the architecture already stands

The review that produced this document found the boundary the design needs is already
in place:

- **No auth in shared packages.** The nine `packages/*` have no HTTP server, no cookie,
  no auth dependency; every `token`/`Authorization` hit is upstream-engine API-key
  injection (`packages/clients/src/http.ts`) or outbound MCP-client bearer
  (`packages/mcp/src/index.ts`). The dependency graph is strictly one-way
  (packages → nothing app-side).
- **One choke point.** Gateway admission is a single `authorized()` function with a
  single call site (`apps/realtime-gateway/src/server.ts`), placed after `/healthz` and
  static assets, before every `/v1` route including the WebSocket upgrade.
- **Engines never see identity.** Engines are separate processes with no auth of their
  own; the gateway strips the caller's authorization and injects the engine credential
  at exactly one layer ("injected here and only here"). This survives every phase below
  unchanged.
- **WebSocket auth happens once**, at upgrade; message handlers do no per-frame checks.

The debts are not in authentication but in **ownership**:

- Voice ids are user-visible names used directly as engine-side directory names,
  engine-local, and re-registration silently overwrites (`engines/voxcpm2-server`).
- Captures record a `session_id` but reads never filter by it; one bearer token reads,
  edits, and deletes everything (`apps/realtime-gateway/src/library.ts`).
- No owner/user/tenant field exists anywhere in code.
- The web client has **no credential path at all**: bare same-origin fetches, and the
  realtime URL constructor drops the page query string — a token-gated gateway serves a
  shell whose every `/v1` call 401s. The browser's answer is a cookie, not a token.
- The upgrade path checks no `Origin`, so a token-less loopback gateway accepts
  cross-site WebSocket connections today; once cookies exist this would become CSRF.

## Decisions

1. **Two product shapes, not an auth-mode framework.** Self-hosted / local
   (`vox studio`, localhost) keeps today's behavior byte-for-byte: no auth by default,
   `VOX_GATEWAY_TOKEN` optional, loopback bind. Hosted (voxstudio.cc) is account-based.
   One startup branch — auth configured or not — no `none|token|accounts|hybrid` mode
   enum. Hosted does **not** also accept the shared token: cookie session or API key,
   nothing else.
2. **Better Auth, directly, for hosted v1.** No Cloudflare-Access-first detour: the
   migration cost (user table, ownership keys, and front-end login state all redone)
   exceeds the cost of doing it right once. Access remains available as an *optional*
   edge layer for private self-hosted deployments — zero code in this repo.
3. **Auth lives in one gateway directory.** `better-auth` is imported only under
   `apps/realtime-gateway/src/auth/`, loaded dynamically only when auth is configured;
   the compiled single binary without auth config never loads it. Shared packages,
   engine contracts, and the credential-injecting facade are not touched.
4. **A two-field AuthContext.** `{ userId: string; via: "session" | "apiKey" }` —
   resolved once per HTTP request and once per WebSocket upgrade (stored on the
   connection state), then threaded to handlers. No scopes, no roles: in v1 a key's
   authority equals its owner's.
5. **Human door: email + password + email verification, cookie session.** No social
   login in v1 (adding it later is configuration, not schema). Verification is not
   ceremony — this is a public GPU-backed service where signup grants synthesis; it is
   the minimum abuse floor, delivered via a transactional email provider.
6. **Machine door: API keys, same contract, same day.** Better Auth's api-key plugin;
   keys are created and revoked on the web settings page and ride
   `Authorization: Bearer` to the *existing* OpenAI-compatible `/v1` routes and the
   realtime WebSocket. Machine-door parity is a v1 acceptance gate, not a roadmap item.

   The wire contract, as delivered:

   ```text
   Authorization: Bearer <key>   # preferred — what OpenAI-compatible clients,
                                 # agent frameworks, and CLIs already send
   x-api-key: <key>              # also accepted (the plugin's native header)
   ```

   A presented key decides the request: if it fails, the request is 401 even when a
   browser cookie is also present, so an agent's broken credential can never silently
   borrow a signed-in browser's identity. Cookies are the browser's alone — no machine
   client is ever issued or expected to send one. Keys are shown once at creation, listed
   afterwards by name and prefix only, and revocation takes effect on the next request.
7. **WebSocket: authenticate at upgrade, verify Origin.** Browser upgrades carry the
   cookie, agents carry the bearer; both resolve to the same AuthContext once, cached on
   the socket — no per-frame database work. Origin checking ships in the same change
   (mandatory once cookies exist; already overdue for the token-less loopback case).
8. **Ownership before login.** Accounts are meaningless while everyone shares one
   resource pool, so ownership lands first (phases below): captures gain an owner
   column, gateway sessions bind to their owner (attach checks it), and voices gain an
   internal-id / display-name split.

## What AI-native means here

Four concrete, testable properties — not a framework:

1. **An agent is not an account type.** An agent is a caller holding one of a user's
   API keys. Ownership, quota, and audit land on that userId; a key may carry a label
   for per-agent revocation, and that is the entire "agent identity model". No agent
   registry, no agent OAuth.
2. **One door.** The machine surface *is* the existing OpenAI-compatible `/v1`
   contract plus the realtime WebSocket — no separate "agent API". Cookie and API key
   resolve to the same AuthContext; every code path past the gateway is identical, and
   a human and their agents see the same voice bank and the same library.
3. **CLI and automation take a pasted key.** `vox --server https://voxstudio.cc` with
   `VOX_API_KEY` (env or config). No device-authorization flow in v1: copying a key
   from the settings page is sufficient developer experience, and that judgment is what
   deletes an entire OAuth flow from the first version. Local CLI commands remain
   in-process and credential-free.
4. **Parity on day one.** The API key works the day the login form works. Machine
   access is an acceptance criterion of v1, not a fast-follow.

## The AI-native access surface

Shaped by a study of AI HOT's agent onboarding page (see References), which pairs one
human-readable entry point with machine-readable contracts and an install-once Skill.
What transfers is the shape, not the policy:

- Hosted v1 serves three discovery artifacts: **`/agent`** — a single onboarding page
  (how to get a key, where the contracts live, client etiquette) — plus **`/llms.txt`**
  and **`/openapi.json`** describing the `/v1` contract the gateway already speaks.
  Alongside them, a **thin Skill** that teaches only discovery and the invocation
  contract — obtain a key, call `/v1`, handle 401/429 — and carries no business logic;
  the API stays the single source of behavior.
  **Delivered 2026-07-26.** All three are unauthenticated (an agent must be able to learn
  how to get a credential before it has one), read-only (`405` on anything else), and
  **hosted-only**: on a self-hosted deployment those paths remain the app shell, because a
  studio with no accounts mints no keys and its behavior must not change. The documents are
  built per request from the live configuration — the library's routes appear in the
  OpenAPI paths only when the library is on, the demo-mode refusal is stated only when
  demo mode is set, and the server URL is the deployment's public origin: the configured
  one when `VOX_AUTH_BASE_URL` is set, otherwise the origin the request actually arrived
  on (a tunnel's forwarded host and scheme), falling back to the bind address only when
  nothing was forwarded. Publishing that bind address unconditionally used to leak the
  internal port and hand agents instructions they could not follow. Setting the variable
  is still required for anything tunnelled — the authentication library's own origin
  check keys on it, and the gateway now says so at startup when it is missing. `/agent` and
  `/llms.txt` are markdown served as `text/plain; charset=utf-8`: inline in every browser,
  no markup for an agent to strip. The OpenAPI document describes exactly the implemented
  paths and deliberately omits two things — the realtime WebSocket (not an OpenAPI shape)
  and `/v1/auth/*` (the authentication library's own browser surface, not a contract this
  project stabilizes). The Skill lives at `skills/vox-api/`; a test holds it to the same
  headers and error codes the gateway emits, and to carrying no install or run steps.
- The doors do not change: humans keep the Better Auth cookie session; agents, CLI,
  and automation enter with an API key belonging to the same userId, at web parity on
  launch day (decision 6). The discovery artifacts only make that door findable.
- **AI HOT's anonymous read-only access does not transfer.** Its API serves cheap,
  read-only content; voxstudio's calls are GPU-expensive, include writes (voice
  registration, library mutations), and touch voice data under per-user ownership.
  Every machine call here is authenticated, quota-bound, and isolated to its owner —
  the anonymous tier is zero.
- What does transfer from its client contract: polling floors and honoring
  `Retry-After` on 429 — stated as etiquette in `/agent` and the Skill, enforced by
  the per-user quota (phase 4).
- Unchanged non-goals: device authorization / remote `vox login` (revisit when a
  remote interactive CLI is a real product entrance), agent-specific identities, agent
  auth frameworks, RBAC, scopes. These artifacts add no milestone — they slot into the
  existing phases below.

## Data model and boundaries

Three stores, each with one owner, no new frameworks:

```text
auth.db      Owned entirely by Better Auth (user / session / account /
             verification / apikey). Schema and migrations via its CLI;
             product code reads nothing but userId.

library.db   Existing captures table gains owner_user_id TEXT NOT NULL;
             every /v1/library route (list / read / patch / delete / promote)
             filters by it. Prerequisite: replace the ad-hoc PRAGMA migration
             with a minimal schema-version marker before adding the column.

voices       No new database. The gateway facade maps identity deterministically:
             engine-side id = u<short-user-id>.<user-chosen-name> (still within
             the engines' [A-Za-z0-9._-]{1,64} contract); listings filter by
             prefix and strip it, so the display name is the user's own.
             The mapping also ends silent same-name overwrites: prefixes are
             per-user namespaces.
```

Boundary rules, restated as invariants:

- `better-auth` appears in exactly one directory; `packages/*` and `platforms/*` stay
  auth-free; the AuthContext type does not enter `packages/contracts`.
- Engines keep zero auth and zero user concepts; cookies and API keys terminate at the
  gateway; the engine credential is injected at the facade and only there.
- Gateway sessions record their owner; `session.attach` verifies it — reconnect grace
  survives, cross-user session takeover does not.
- A self-hosted binary with no auth config behaves exactly as today, verified by the
  existing gate tests running unchanged.

## Non-goals (v1)

- Organizations, teams, or any multi-principal ownership — the owner is one userId
  column, and that is the whole extension point.
- RBAC, roles, generic scopes, or a permission framework.
- Device authorization / `vox login`.
- An auth-mode enum, or hosted deployments that also accept the shared token.
- OIDC, SSO, or social login (future plugins, per the superseded stance above).
- Agent-specific identity types, agent registries, per-agent quota models.
- Remote/HTTP MCP (local stdio MCP unchanged; when remote MCP arrives the API key is
  already the credential, so nothing is rebuilt).
- Anonymous trial accounts — decide after observing real signup friction.
- Cloudflare Access on the public entrance (optional for private self-hosts only).
- Any database beyond SQLite; any rate-limiting framework — the existing demo
  guardrails plus simple per-user counters suffice.

## Delivery phases

Phases 1–2 introduce no dependency and are correct independently of Better Auth;
phase 3 is the only dependency-bearing step and is confined to one directory.

1. **AuthContext refactor (zero-dep).** `authorized(): boolean` becomes
   `resolveAuthContext(request): AuthContext | null`; the context lands on the socket
   state and every `/v1` handler. Same change set: Origin verification on upgrade,
   constant-time token comparison, and unifying the two divergent token-parsing entry
   points (`main.ts` reads `VOX_GATEWAY_TOKEN`, `studio.ts` currently does not).
   Gate: the existing self-hosted admission tests pass unmodified.
2. **Ownership (zero-dep).** Library owner column plus filtering on every route; voice
   prefix mapping in the facade; session-owner binding with attach verification.
   Gate: two simulated userIds cannot see each other's captures or voices; a
   single-owner self-hosted deployment notices nothing.
3. **Better Auth mount.** `src/auth/` with `auth.db`; email + password + verification;
   api-key plugin; upgrade-time cookie/bearer resolution; web login page, 401 handling,
   and settings-page key management. The discovery surface ships here, next to key
   management: `/agent`, `/llms.txt`, `/openapi.json`, and the thin Skill — an agent's
   onboarding path (read `/agent`, obtain a key, call `/v1`) is part of the
   machine-parity gate. Gates: signup → login → conversation → generate →
   library passes the existing suites; the same user's API key hitting
   `/v1/audio/speech` produces fingerprint-identical artifacts to the web path (the
   machine-parity gate); a binary without auth config demonstrably never loads
   better-auth.

   **Delivered in two tracks.** *Gateway* (2026-07-26): accounts mount, both machine
   headers, mutual exclusion with the shared token and with the resolver seam, hosted
   origin strictness, and shutdown ordering. *Web* (same day): `/healthz` reports
   `auth: "self" | "accounts"` so the shell knows its door without a credential; under
   accounts an unauthenticated visitor gets a sign-in/sign-up card, an unverified
   account gets a resend banner rather than a wall, any 401 anywhere returns the shell
   to the card, and 设置 grows account and API-key sections. A self-hosted studio reads
   `self` and renders exactly what it did before — the auth routes 404 there, and every
   failure path (unreachable gateway, gateway predating the field) also reads `self`, so
   a login wall can never appear where there is nothing to sign into. What remains for
   launch is listed under phase 4 and in the boundaries above: a real verification
   sender, the production secret, the public origin, and the discovery surface
   (`/agent`, `/llms.txt`, `/openapi.json`, the Skill).
4. **Launch hardening.** Per-user generation quota; `/healthz` stops disclosing session
   counts (or moves behind auth); the ops half (tunnel and edge configuration) stays in
   the internal repo per this repo's public-boundary rules.

   **Quota delivered 2026-07-26.** `--quota N` / `VOX_GATEWAY_QUOTA` with
   `--quota-window SECONDS` (default 3600) bounds each **account** to N chargeable
   operations per window, counted per `AuthContext.userId` — so a human and every agent
   holding their keys share one allowance, and minting another key buys nothing. A fixed
   window anchored at the account's first charge; a refusal is not a charge, so being
   over quota never pushes the reset away. State is one in-memory counter per account,
   swept when its window passes: no storage, no buckets, no billing, no per-route policy
   (the non-goals above). It is therefore **process-local** — it resets on restart and
   does not span replicas, which is the thing to revisit before this runs behind more
   than one gateway.

   **Charged** (each one unit): `POST /v1/audio/speech`,
   `/v1/audio/transcriptions`, `/v1/chat/completions`, `/v1/voices`,
   `/v1/design-profiles`, `/v1/library/{id}/promote`, starting a realtime conversation
   (`session.start`), **each turn within a conversation**, and registering a voice
   through the spoken Studio tool (it reaches the same engine as `POST /v1/voices`).
   **Free**: every GET, correcting or deleting a capture, deleting a voice, `/healthz`,
   `/v1/auth/*`, and the discovery surface.

   A conversation is metered **per turn, never per audio frame** — per-frame accounting
   would mis-price a conversation and put work on the audio path. The turn is charged
   when the user's utterance is finalized, before the reply's model work begins; a
   revision of the same turn (a barge-in) is not charged twice. When the allowance runs
   out mid-conversation the session emits a notice and ends, so the turn already in
   flight may finish: **a conversation overshoots by at most one turn**. Charging only at
   `session.start` was the original design and it was wrong — one charge bought unbounded
   engine work (adversarial review 2026-07-26).

   **A refusal the gateway makes itself costs nothing.** A charge is taken before the
   work, then given back when the gateway refuses the request on its own (a malformed
   body, an unusable voice name, demo mode, a disabled or closing library, a capture that
   is not the caller's) or could not reach the engine at all (`engine_unreachable`). An
   error the *engine* returned is work that happened and stays charged.

   A refusal is one shape everywhere: HTTP 429 with `Retry-After` and `x-request-id`
   headers, and a body of `{"error":{"message","code":"quota_exceeded","requestId",
   "retryAfterSeconds"}}` — the same envelope as every other error here, plus the wait
   and an id to quote. On the realtime socket the refusal is a `command.rejected` with
   reason `quota_exceeded`, the mechanism session capacity already used, carrying the
   same `retryAfterSeconds` and `requestId` (additive protocol fields) so a socket client
   gets the same guidance a REST client does. The OpenAI-Realtime dialect reports it in
   its own vocabulary — an `error` event with `code: "quota_exceeded"` and
   `retry_after_seconds` — rather than flattening it into `session_capacity`: a full
   gateway and a spent allowance are different answers, and only one is worth waiting out.

   **Every API error uses that envelope.** `{"error":{"message","code"}}` is what `/agent`
   and the Skill tell agents to branch on, so the gateway's own refusals — 401, 403, 404,
   405, 426 — are JSON too, not bare strings (they were, until the adversarial review).
   The app shell is unaffected: it is a page, not an API.

   **Brute-force protection is stated, not inherited.** Better Auth enables its limiter
   only when `NODE_ENV=production`, which left the one unauthenticated write surface —
   sign-up and sign-in — unprotected everywhere else. The accounts module now configures
   it explicitly and unconditionally: 60 requests/minute across `/v1/auth/*`, 5/minute on
   `/sign-in/email`, and 5/hour each on `/sign-up/email`, `/send-verification-email`, and
   `/forget-password`. A deployment may relax these deliberately (a test suite must), and
   an override restates the per-route rules rather than silently leaving them strict.
   **Buckets key on the client address**, so a tunnel that does not forward the real
   client IP puts every visitor in one bucket — an ops requirement, listed below.

   Accounts-only and off by default: `--quota` without `--accounts` is refused at
   startup (a self-hosted studio would only be metering its own operator), a typo fails
   closed, and an existing deployment gains no limit by upgrading. `/agent`, `/llms.txt`,
   and `/openapi.json` state the deployment's **real** numbers when a quota is set and
   say plainly that there is none when it is not — the contract and the enforcement are
   generated from the same configuration, so they cannot drift.

## References

- [web-studio.md](./web-studio.md) — the hosted surface, single-binary serving, and the
  original "one owner, Access at the door" v1 stance this document succeeds.
- [public-demo.md](./public-demo.md) — the layered access model for *private* demos;
  its guardrails (session caps, demo read-only mode, retention opt-in) remain orthogonal
  to authentication and unchanged.
- [product-runtime.md](./product-runtime.md) — dependency rules that keep shared
  packages platform- and auth-free.
- [competitive-voice-agents.md](./competitive-voice-agents.md) — the superseded
  OIDC-first identity note, retained for the enterprise-SSO future.
- [AI HOT agent onboarding](https://aihot.virxact.com/agent) and its
  [public access terms](https://aihot.virxact.com/terms) — inspiration for the
  discovery-surface shape (one onboarding page + `llms.txt` + OpenAPI + a thin Skill).
  An inspiration source only, not a normative dependency — and its anonymous
  read-only access policy is explicitly not adopted here.
