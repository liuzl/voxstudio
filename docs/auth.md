# Authentication and identity

Status: living. Accepted 2026-07-26; last revised 2026-08-01.

## Scope

How voxstudio has accounts: identity for the hosted product at **voxstudio.cc** — a
public, self-serve entrance, not an owner-only console — and the guarantee that the
self-hosted product keeps its zero-auth, optional-token shape untouched.

This document describes the system as it is and why it is shaped that way. Enumerated
contracts (which routes exist, which are charged, what a deployment's limits are) are
generated from the gateway's own route catalog and served at `/agent`, `/llms.txt`, and
`/openapi.json`; copying them here would create the second copy that drift feeds on.
Dated history is at the end.

Supersedes one earlier stance: [competitive-voice-agents.md](./competitive-voice-agents.md)
sketched an OIDC-first identity abstraction (Keycloak / Authentik / Cloudflare Access).
That remains right for *enterprise SSO later*, but it is the wrong first move for a public
entrance: Access-style gating is an allow-list door, it produces no product-owned user
record, and ownership built against its JWT claims would be rebuilt the day real accounts
arrive. The hosted product owns its identity; OIDC/SSO demotes to a future plugin.

## Current state

Everything described under "How it works" is implemented and tested except the
passages explicitly marked as the proposed Agent registry integration. What remains
before voxstudio.cc can open is mostly configuration — with two exceptions, marked,
that are unbuilt work rather than a value someone has to supply:

| Blocking launch | What it needs |
|---|---|
| One social provider **or** a verification-email sender | The hosted door needs a verified identity. A social provider supplies one and closes password recovery with it; a sender keeps the password door but needs the reset callback too. See [The human door](#the-human-door). |
| `VOX_AUTH_SECRET` (≥32 chars) | Comes from the deployment. A short or missing secret refuses to boot. |
| `VOX_AUTH_BASE_URL` | The public origin. Better Auth's own origin check keys on it, and the discovery documents publish it; missing, the gateway warns at startup. |
| Quota numbers | No production default exists. Pick them from measured GPU throughput. |
| **Operator capability (unbuilt)** | No way to ban an abusive account through the product. Implementation plus tests, not configuration. Required before signups open, and sequenced after the tunnel — see [Operator capability](#operator-capability). |
| **Password recovery (unbuilt)** | Only if the password door opens. `/forget-password` is rate-limited but has no reset-email callback, so a user who forgets their password has no way back. A social-only launch does not need it: no password, nothing to recover. |

## How it works

### Two product shapes, not an auth-mode framework

Self-hosted (`vox studio`, localhost) behaves exactly as it did before accounts existed:
no auth by default, `VOX_GATEWAY_TOKEN` optional, loopback bind. Hosted is account-based.
One startup branch decides which — there is no `none|token|accounts|hybrid` enum, and a
hosted deployment does **not** also accept the shared token. Both entrypoints refuse the
combination at startup, because two doors into one deployment is a configuration mistake
rather than a feature.

### Identity: one seam, two fields

A credential becomes an `AuthContext` — `{ userId, via }` — in exactly one place. Nothing
downstream ever sees a cookie, a key, or a token. This is why hosted accounts were a
change to one file rather than to the whole gateway, and it is the invariant to protect
first.

Resolution runs once per HTTP request and once per WebSocket upgrade, cached on the
connection: a socket does no per-frame credential work.

### The human door

Cookie session, via Better Auth mounted at `/v1/auth`. Two possible doors, and the
deployment decides which are open:

**Email and password** — implemented. Verification is required whenever a sender is
configured; without one it is off, which is why a public launch cannot rely on this door
alone. Verification is not ceremony: signup grants synthesis on a GPU, so a verified
identity is the minimum abuse floor.

**A social provider** — the intended launch door, not yet configured. The reason is not
signup friction, which would be a weak argument for a developer tool. It is that a
provider's address arrives already verified, which is exactly what the verification
requirement stands in for, and that an account with no password needs no recovery flow.
Two unbuilt gaps close as configuration rather than code. It also raises the cost of mass
signup from "invent an email string" to "hold a real account", which is the only real
answer to signup flooding — a deployment-wide ceiling bounds it, nothing more.

**Open one door, not two, at launch.** An abuse floor is only as high as the lowest door:
running social alongside an unverified password door would leave the password door as the
way in, and adding the provider would buy nothing. Social-only also removes the entire
password attack surface — no credential stuffing, no reset flow, no verification mail, and
the account-keyed sign-in limiter has nothing left to defend. The password path stays
implemented and dormant; opening it later is configuration plus a sender.

GitHub is the better first provider for this audience — the users are developers and agent
authors — and its OAuth app setup avoids Google's consent-screen review. Two things to
confirm before relying on this, neither verified yet: whether Better Auth marks
`emailVerified` from the provider's claim (if not, social users would trip the
verification requirement), and that the callback URL follows `VOX_AUTH_BASE_URL`, which is
already a required setting and whose misconfiguration shows up as "login bounces back and
fails".

### The machine door

API keys from the same Better Auth instance, minted by a signed-in human on the settings
page and shown exactly once. Two accepted headers, one meaning:

```text
Authorization: Bearer <key>   # preferred — what OpenAI-compatible clients,
                              # agent frameworks, and CLIs already send
x-api-key: <key>              # also accepted (the plugin's native header)
```

**A presented key decides the request.** A bad key is 401 even when a valid browser cookie
is also present, so an agent's broken credential can never silently borrow a signed-in
browser's identity. Cookies belong to browsers; no machine client is issued one.

After creation a key is only ever shown by name and visible prefix — the full value
exists outside the database exactly once. Revocation takes effect on the next request:
every presented key is verified rather than cached.

Machine parity was a v1 acceptance gate, not a fast-follow: the key works the day the
login form works, against the same `/v1` contract and the same realtime socket, seeing the
same voices and library as its owner.

### What AI-native means here

Four properties, each testable:

1. **An agent is not an account type.** A machine caller is software holding one
   of a user's keys. A saved Voice Agent introduced by the Agent Builder is a
   product resource owned by that same user. Neither receives a Better Auth user,
   OAuth flow, independent quota, or ambient browser authority. Ownership and
   quota land on the resolved userId.
2. **One door.** The machine surface *is* the existing OpenAI-compatible `/v1` contract
   plus the realtime WebSocket — no separate "agent API".
3. **A pasted key is enough.** `vox --server …` with `VOX_API_KEY`. Judging that copying
   a key is sufficient developer experience is what deleted an entire OAuth device flow
   from v1.
4. **Discovery is part of the product.** `/agent`, `/llms.txt`, and `/openapi.json` are
   served unauthenticated — an agent must be able to learn how to get a credential before
   it has one — read-only, and hosted-only. A self-hosted studio answers them with a
   structured 404 rather than its app shell, so a machine can tell "not here" from "here
   is a web page".

The shape was borrowed from AI HOT's onboarding page (see References); its **anonymous
read-only tier was not**. Its API serves cheap content; ours is GPU-expensive, writes, and
touches voice data under per-user ownership. Every machine call here is authenticated,
quota-bound, and isolated to its owner.

The OpenAPI document is generated from the router's own catalog
(`apps/realtime-gateway/src/routes.ts`) — the same list that dispatches methods and that
the quota consults. A route cannot gain a method, a parameter, or a charge without the
document following, because there is one list rather than a copy. The copy is how four
drifts accumulated unnoticed.

### Authorization: what the request path decides

There *is* a permission model; it is small. An earlier draft claimed the request path
carried none, which described the absence of a roles table rather than the absence of
authorization — and made every later decision look like an exception. In full:

1. **Ownership.** A capture that is not the caller's reads as absent; a session refuses a
   cross-owner reattach; a voice name resolves inside the caller's namespace and a raw
   engine id is refused.
2. **Deployment capability.** Demo mode refuses registry writes — not ownership, but
   "this caller may not perform this action".
3. **Usage.** The quota answers "not now" to an account that has spent its allowance.

The invariant worth holding is about shape, not existence: **authorization stays inline
and enumerable** — no ACL tables, no policy engine, no role hierarchy. New checks may join
that list. The alarm is not a new check but a list long enough to need an abstraction:
when authorization stops being enumerable it has become a subsystem, and that is the
moment to design one deliberately rather than accrete it.

### Ownership

Ownership landed *before* login, because accounts are meaningless while everyone shares one
resource pool. The delivered resources use three mechanisms, and the proposed Agent
registry adds a fourth behind the same identity seam:

```text
captures     owner_user_id column; every /v1/library route filters by it.
voices       No new store. The gateway maps a display name to an engine-side id,
             u<short-user-id>.<name>, inside the engines' [A-Za-z0-9._-]{1,64}
             contract. Listings filter by prefix and strip it. The prefix also
             ends silent same-name overwrites: it is a per-user namespace.
             The configured tts_defaults.voice stays a bare, deployment-owned voice;
             it is shared configuration, not a user voice to prefix. A truly omitted
             voice retains the engine's voice-less semantics (VoxCPM design mode).
sessions     Each records its owner; attach verifies it, so reconnect grace
             survives and cross-owner takeover does not.
agents       Registry key is (userId, agentId). Self-hosted `owner` keeps readable
             flat YAML; hosted owner directories use the full hexadecimal SHA-256
             digest of userId.
             Draft and immutable published snapshots stay outside auth.db.
```

Internal engine ids are not part of the public contract. A name shaped like one is refused
for every caller, the self-hosted owner included, so nobody reaches another bank by naming
it.

Agent CRUD, publish, audit, version reads, and realtime resolution receive only
`AuthContext.userId`; Better Auth types do not cross the gateway seam. The same
owner reached by a browser cookie or one of that user's API keys sees the same
Agent ids. Another owner's id reads as absent. A saved Voice Agent is not a
credential or principal, and organizations/shared ownership remain a later
widening. See [agent-builder-ui.md](./agent-builder-ui.md).

That key/session parity is intentional: an API key has the owner's current full
authority, so an explicit request for the owner's Agent draft is not a separate
browser privilege. Ordinary session start still defaults to an immutable
published version. Agent writes authenticated by a browser session require the
same exact hosted Origin check as the realtime upgrade; Better Auth's CSRF
handling protects `/v1/auth/*`, not new product routes. API-key calls remain
header-authenticated machine requests and do not require a browser Origin.

### Quota

Per-account, fixed window, one in-memory counter per account. Not a rate-limiting
framework: no buckets, no storage, no billing, no per-route policy.

What costs is **engine time**: synthesis, transcription, chat, voice and profile creation,
promotion, starting a realtime conversation, each turn within one, and registering a voice
through the spoken Studio tool. Reads, corrections, deletions, health, and the discovery
surface are free.

The published list is derived from the same catalog the quota consults, plus a declared
list of the charges that are not HTTP routes (the realtime turn and the spoken tool). It
was hand-written once and immediately drifted — `/agent` under-reported two charges the
gateway had started collecting — which is the argument for deriving it rather than a
stylistic preference.

Three semantics are worth stating because each replaced a wrong answer:

- **Per turn, never per audio frame.** Per-frame accounting would mis-price a conversation
  and put work on the audio path. The turn is charged when the user's utterance is
  finalized, before the reply's model work; a barge-in revision is not charged twice. When
  the allowance runs out mid-conversation the session says so and ends, so the turn in
  flight may finish — **a conversation overshoots by at most one turn**.
- **A refusal the gateway makes itself costs nothing.** The charge is taken before the
  work and given back when the gateway refuses on its own (malformed body, unusable voice
  name, demo mode, disabled library, someone else's capture) or could not reach the engine.
  An error the *engine* returned is work that happened and stays charged.
- **The allowance belongs to the account.** A human and every agent holding their keys
  share one; minting another key buys nothing.

**A charge is a request, not an amount of work.** Measured on a live engine: one unit
bought 29 seconds of audio and 10 seconds of GPU, where a short sentence costs about one
second. `--max-synthesis-seconds N` bounds a single `/v1/audio/speech` by estimated speech
duration — the same script-aware estimate the Studio shows before generating — and refuses
past it with `input_too_long` before touching an engine, so the refusal costs neither GPU
nor quota. Without it no quota number predicts load, and the gateway says so at startup
when a quota is configured alone. Off by default, like every other guardrail here.

**Concurrency is gated separately, and sized from measurement.** Against the live engine,
throughput was flat past two requests in flight (0.71→0.72 req/s) while latency grew
linearly (1.6s → 2.6s → 4.1s → 7.4s at one, two, four, eight): the GPU serializes, so
admitting more finishes nothing sooner and makes everyone wait. `--max-concurrent-synthesis
N` admits N, queues `--max-queued-synthesis` more, and refuses beyond that with 429 and a
`Retry-After` drawn from how long recent syntheses actually took — a caller can act on that,
where a socket held in a deep queue past its own timeout helps nobody. Together with
`--max-sessions` (realtime conversations) it covers both ways to load the TTS engine.

One gap stays open and is stated rather than implied: **transcription input is unbounded**
— an uploaded file's length has no ceiling, the same hole on the ASR side, and its right
limit needs measuring rather than guessing.

State is process-local: it resets on restart and does not span replicas. That is honest for
one gateway and wrong for two — see triggers.

### Refusals

Every API error is `{"error":{"message","code"}}` — the shape `/agent` and the Skill tell
agents to branch on, so the gateway's own refusals (401, 403, 404, 405, 426) are JSON too,
not bare strings. The app shell is unaffected: it is a page, not an API.

A quota refusal reaches a client in four shapes, each carrying a code and a delay:

- **REST** — HTTP 429, `Retry-After` and `x-request-id` headers, `retryAfterSeconds` and
  `requestId` in the body.
- **Native socket, refused at `session.start`** — a `command.rejected` with the same two
  fields.
- **Native socket, exhausted mid-conversation** — a `session.notice` with
  `code: "quota_exceeded"` and `retryAfterSeconds`, then the session ends. It is a notice
  rather than a rejection because no command was refused: the allowance ran out between
  turns.
- **OpenAI-Realtime dialect** — an `error` event with `code: "quota_exceeded"` and
  `retry_after_seconds`, not the `session_capacity` a full gateway returns. A full
  gateway and a spent allowance are different answers, and only one is worth waiting out.

### Brute-force protection

The pre-authentication surface is limited by **the account being attacked**, not by the
caller's address.

Address keying looked obvious and was wrong twice over. Better Auth's own limiter is
enabled only under `NODE_ENV=production`, so it protected nothing in any other
environment; and its bucket key comes from `x-forwarded-for`, a header the caller writes.
Rotating it defeated the protection entirely — measured: twelve wrong passwords, zero
refusals. Trusting that header would have required a trusted-proxy configuration and would
still have been the wrong key.

There is no authenticated user at sign-in, but there is a claimed one: the email in the
body. Keying on it targets the actual attack, cannot be spoofed — an attacker must name
the account being attacked — and does not punish everyone behind one NAT. Only *failed*
attempts count: the charge is taken up front and returned when the attempt succeeds, so
signing in correctly is never rationed, and the lockout an attacker can inflict on someone
else lasts one window and never longer.

Signup is a different problem and gets an honest answer rather than a key that does not
work. Varying the email *is* the attack, so no per-caller key helps; it draws on a coarse
deployment-wide ceiling. What actually blunts signup flooding is email verification — an
unverified account cannot sign in, so a flood produces rows and outbound mail rather than
GPU time — and, if it becomes real, a challenge at the edge. That is a trigger, not a
plan.

Better Auth's limiter stays enabled as a blunt ceiling over auth routes the gateway does
not front, where something coarse beats nothing.

## Boundaries

- `better-auth` is imported in exactly one directory and loaded dynamically: a self-hosted
  binary without auth configured never touches it. `packages/*` and `platforms/*` stay
  auth-free; `AuthContext` does not enter `packages/contracts`.
- Engines have no auth and no user concept. Cookies and API keys terminate at the gateway;
  the engine credential is injected at the facade and only there, and the caller's own
  authorization never reaches an engine.
- `auth.db` is owned entirely by Better Auth — user, session, account, verification, and
  apikey tables, with schema and migrations delegated to it. Product code reads a userId
  out of it and nothing else, and never writes it. Agent records and published
  snapshots therefore live in the product registry, never in Better Auth tables.
- A self-hosted binary with no auth config behaves exactly as it did before accounts
  existed — verified by the pre-existing admission tests running unmodified.

## Operator capability

There is no administrator. Every account is equal and sees only its own resources —
including the person running the deployment, whose privileged access today is the host
itself: `auth.db`, `library.db`, and the audio on disk.

That is a real gap for a public entrance, and the missing capability is narrow: stop an
abusive account, cut its sessions and keys, see who exists. It is not a role hierarchy and
should not become one — an operator is the party holding the machine, not a kind of user.

**A ban only means something if the auth path enforces it.** Flipping a column from a
script leaves existing sessions and API keys working, which is a wish rather than a ban.
That is the whole argument for Better Auth's admin plugin (already shipped inside
`better-auth`, so no new dependency) over a hand-written CLI: its `banned` check runs where
sessions are validated.

### Admin identity comes from the deployment, not the database

The plugin adds `role`, `banned`, `banReason`, and `banExpires` to the user table, but it
also accepts **`adminUserIds`** — a fixed list of user ids from configuration. Use that.
Administrator then means "named in this deployment's environment", which is what an
operator actually is, and the `role` column stays inert. An earlier revision of this
document claimed the plugin necessarily puts a role in the request path; that was wrong.

### Expose four verbs, not fifteen

Every exposed endpoint is a capability to defend, audit, and explain. The needed action is
one — stop this account — plus what it takes to see and enforce it.

| Expose | Why |
|---|---|
| `ban-user`, `unban-user` | The capability itself, reversible. |
| `list-users`, `get-user` | You cannot act on abuse you cannot see. |
| `list-user-sessions`, `revoke-user-sessions` | The enforcement half: cut what is already open. |

| Do not expose | Why not |
|---|---|
| `create-user`, `set-user-password` | Both re-open the password door this deployment deliberately closed, server-side and bypassing signup. Setting a password on an account that has none is impersonation without even impersonation's audit trail. |
| `update-user` | Arbitrary writes to a user row, email included. Changing someone's address to your own is account takeover. Unclear blast radius. |
| `remove-user` | Captures are recordings of humans and voices are curated work, both keyed on userId. Deleting the row without deciding their fate orphans or destroys them. **A ban is not a deletion** — that is a data-lifecycle decision, not a moderation one. |
| `set-role` | Roles stay unused (above). An inert-but-writable field is worse than an absent one: harmless today, a privilege path the moment anything starts reading it. |
| `has-permission` | Only meaningful with the role and permission system we are not adopting. Dead surface. |
| `impersonate-user`, `stop-impersonating` | A separate decision, below. |

### Three things to decide, and one to verify first

- **Verify before building: does a ban stop API keys?** The plugin's check lives in session
  validation, while our machine door goes through `verifyApiKey`. If keys survive a ban, a
  banned account's agents keep working and the ban leaks. This is the first thing to test,
  not the last.
- **Impersonation: on or off**, and whether it can be disabled outright — still unverified;
  the plugin exposes `impersonationSessionDuration`, which implies configurability but not
  a switch. The privacy argument against it is weaker than it first appears — an operator
  with the host can already read every capture, so it adds convenience, not reach — but a
  stolen admin credential reaching the app is a different exposure from a compromised host,
  and 2FA on that account belongs in the same decision.
- **Audit from the first day.** Who banned whom, when, and which keys were revoked. There is
  no audit trail today because there are no privileged actions; the day one exists, its
  history cannot be reconstructed afterwards. Where it is written is a public-repo boundary
  question: the events belong with the deployment, not in this repository.

**When.** This is "required before signups open", not "missing now": until voxstudio.cc has
DNS and a tunnel, nobody can reach the deployment to abuse it. It sequences after the
tunnel, before the entrance opens.

## Not built yet, and what would change that

These are not prohibitions. Twice in this document's life a "we do not do X" line turned out
to mean "we have not needed X," and the wording then had to be argued with instead of the
design. Each row records a state and a trigger, so the next decision is a check against a
condition rather than a debate with a slogan.

| Not built | What would justify it |
|---|---|
| Organizations, teams, multi-principal ownership | A customer who needs shared resources. Ownership is one userId column precisely so this stays a widening, not a rewrite. |
| Roles | An organization to attach them to. Not an admin surface: operator identity comes from `adminUserIds` in the deployment's configuration, so administration needs no role at all — see [Operator capability](#operator-capability). A role with nothing to govern is a column that does nothing. |
| Scoped credentials (read-only or synthesis-only keys) | Users handing keys to agents they did not write. Today the key's holder is its author; when that stops being true, "your key carries your owner's full authority" becomes a hazard we invited. Closest of these to justified. |
| Device authorization / remote `vox login` | A remote interactive CLI as a real product entrance. Pasting a key is enough while the developer has a browser open. |
| OIDC / SSO | An enterprise deployment. The plugin exists; the work is integration, not architecture. |
| Social login | **Already justified — see [The human door](#the-human-door).** The recorded trigger used to be "a measured signup drop-off", which was the wrong reason: what makes it worth doing is that it closes the verification and recovery gaps as configuration. It is the intended launch door. |
| Anonymous trial accounts | Evidence that signup friction, not interest, is the drop-off. |
| Agent-specific identities or per-Agent quota | A saved Voice Agent that must be authorized or metered separately from its owner. Today it is an owned resource; machine callers hold an owner's key, and all work is charged to that owner. |
| Remote/HTTP MCP | A caller that cannot spawn the local stdio server. The API key is already the credential, so nothing is rebuilt. |
| A rate-limiting framework, or any database beyond SQLite | A second gateway process. Both the quota and the auth limiter are in-memory and per-process — honest for one gateway, wrong for two. |
| Cloudflare Access on the public entrance | Nothing; it is the wrong tool for a self-serve product. It stays available for private self-hosted deployments. |
| An auth-mode enum, or hosted deployments that also accept the shared token | Nothing. Both entrypoints refuse the combination at startup. |

## History

Commit messages carry the detail; this records the sequence and, more usefully, the
reversals — the places where a first answer was wrong in a way worth not repeating.

- **2026-07-26 — design accepted.** A review found the boundary already right (no auth in
  shared packages, one admission choke point, engines blind to identity) and the debt
  entirely in ownership: voices used user-visible names as engine directory names, captures
  recorded a session id nobody filtered on, no owner field existed anywhere, the web client
  had no credential path at all, and the upgrade checked no `Origin`.
- **Phase 1** — `authorized(): boolean` became `resolveAuthContext()`; Origin verification,
  constant-time comparison, and one token-parsing contract across both entrypoints.
- **Phase 2** — ownership: the capture owner column with a real schema-version marker, the
  voice namespace, session-owner binding. Deliberately before any login existed.
- **Phase 3** — Better Auth mounted (gateway, then the Web door the same day), followed by
  the discovery surface and the thin Skill at `skills/vox-api/`.
- **Phase 4** — the per-account quota, which the discovery documents had already promised
  as a 429 before anything enforced it.
- **2026-07-26/27 — adversarial review (codex) and three rounds of fixes.** The reversals
  worth remembering:
  - Charging only at `session.start` was wrong: one charge bought unbounded engine work —
    six turns and eighteen engine calls, measured, while REST callers were refused.
  - Brute-force protection inherited from `NODE_ENV` was no protection: twelve wrong
    passwords, zero refusals, in any non-production environment.
  - The JSON error contract the documents promised was not kept by the gateway's own
    refusals, which were bare strings — so an agent following our instructions to branch on
    `error.code` broke on the most common failure.
  - Publishing the bind address in the discovery documents leaked the internal port and
    handed agents instructions that pointed at nothing.
  - Checking the OpenAPI document against a hand-written path list let four drifts through;
    it is generated from the route catalog now.
- **2026-07-27 — second review round (codex), on the rewritten document.** It found the
  charged list in `/agent` still hand-written and already under-reporting two charges, the
  mid-conversation quota refusal carrying no structured fields, and the spoken Studio tool
  charging without refunding an unreachable engine. Following its note about forwarded-IP
  trust turned up the larger one: the address-keyed brute-force limiter could be defeated
  by rotating `x-forwarded-for`, so the limits were rekeyed onto the claimed account and
  the trusted-proxy requirement disappeared instead of being configured.

## References

- [web-studio.md](./web-studio.md) — the hosted surface and the original "one owner, Access
  at the door" stance this document succeeds.
- [public-demo.md](./public-demo.md) — the layered access model for *private* demos; its
  guardrails remain orthogonal to authentication.
- [product-runtime.md](./product-runtime.md) — the dependency rules that keep shared
  packages platform- and auth-free.
- [competitive-voice-agents.md](./competitive-voice-agents.md) — the superseded OIDC-first
  note, retained for the enterprise-SSO future.
- [AI HOT agent onboarding](https://aihot.virxact.com/agent) and its
  [public access terms](https://aihot.virxact.com/terms) — inspiration for the
  discovery-surface shape, not a normative dependency; its anonymous read-only policy is
  explicitly not adopted.
