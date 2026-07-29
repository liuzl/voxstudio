# Agent execution sandbox and tool broker

Status: Accepted security baseline, 2026-07-29. This document is a prerequisite
for enabling filesystem, process, arbitrary-network, or third-party agent
tools.

## Boundary

Spoken confirmation answers “did the user authorize this action?” A sandbox
answers “what can this action affect if the model, tool, or dependency is
wrong?” Neither substitutes for the other.

pi plans and emits structured calls. It receives no direct filesystem, shell,
spawn, network, environment, or credential authority:

```text
pi → Vox tool broker → effect/confirmation/idempotency policy
                     → ToolRunner
                       ├─ trusted in-process structured tool
                       └─ isolated worker/container/VM
```

The gateway owns tool registration and the allowlist. Installing pi does not
install or expose pi’s general tool ecosystem.

## Tool classes

| Capability | Initial runner | Requirements |
|---|---|---|
| pure structured read | in-process | owner checks, timeout, bounded result |
| Vox session mutation | in-process | `session` effect, no host authority |
| fixed external API | brokered or sandbox | structured broker request or sandbox destination allowlist; scoped credential |
| workspace read/write | sandbox | per-run root, no traversal or symlink escape |
| process or code execution | sandbox | resource limits, process-group cleanup |
| arbitrary network/browser | disabled | later threat model and identity isolation |
| third-party/plugin tool | sandbox by default | explicit operator allowlist |

Hosted deployments always enforce sandboxing. A self-hosted deployment may
offer an explicitly dangerous `trusted-host` mode, but it is never the default
and is surfaced as a deployment warning, not a conversational choice.

## Policy

Each registered tool has immutable operator policy:

- effect: `read`, `session`, or `external`;
- execution mode: `in_process`, `brokered`, or `sandbox`;
- declared capabilities: structured, filesystem, process, network;
- timeout and output limits;
- filesystem access, if any;
- network destinations, if any;
- names of scoped secrets, never their values;
- whether cancellation is supported and where its commit point lies.

The model cannot widen this policy through arguments.

`in_process` is valid only for structured tools without filesystem, process, or
arbitrary-network capability, external effects, or scoped secrets. `brokered`
accepts only structured requests; the broker owns any network access and scoped
credential. Policy validation fails closed at registration.

## Isolation baseline

### Filesystem

- one ephemeral workspace per owner/run;
- no host home, repository, SSH material, runtime sockets, or other users’
  workspaces;
- no path traversal or symlink escape;
- read-only runtime files mounted only when declared;
- persistent output requires explicit artifact promotion;
- cleanup is bounded and observable.

### Network

- default deny;
- exact scheme/host/port allowlist per tool;
- reject loopback, private/link-local ranges, Unix sockets, and cloud metadata
  unless explicitly declared for a trusted built-in;
- validate the resolved address at connection time to resist DNS rebinding;
- no inherited proxy variables.

### Credentials

- do not inherit the gateway environment;
- inject only declared, short-lived credentials;
- redact secrets from logs, events, errors, artifacts, and narration;
- never expose secret values to the LLM;
- do not mount SSH agents, Docker sockets, keychains, or cloud credential
  directories.

### Resources and processes

- wall-clock, CPU, memory, process-count, output-byte, file-count, and workspace
  limits;
- run unprivileged with no device access;
- place children in one killable process group or isolation unit;
- cancellation terminates descendants, not only the immediate child;
- no daemon survival after a terminal invocation;
- stdout/stderr are bounded and treated as untrusted data.

The concrete backend may use an OS worker, container, or VM. The gateway
depends only on `ToolRunner`.

## Effects, commit, and outcome

An invocation progresses through:

```text
prepared → waiting_confirmation → running → committed
                                      ├────→ cancelled
committed → completed | failed | outcome_unknown
```

- confirmation is recorded against the stable invocation ID;
- ledger identity is scoped by authenticated owner, session, and run; reusing
  an identity with different arguments or policy is rejected;
- retries reuse that ID;
- `outcome_unknown` is required when transport failure prevents determining
  whether a non-idempotent effect committed;
- `outcome_unknown` is never automatically retried;
- the broker keeps a bounded result ledger for reconnect/idempotency.
- runner shutdown aborts active work and returns at a configured drain
  deadline; it never waits forever for a tool that ignores cancellation.

## Rollout

1. Phase B ships the contracts, policy validator, fake runner, and race tests.
2. Phase C pi uses only allowlisted structured read/session tools plus one test
   external effect; no shell or arbitrary filesystem/network access.
3. Phase D implements a real sandbox, workspace ownership, artifacts, quotas,
   and adversarial security tests.
4. Only after Phase D may general filesystem or process tools be enabled.

## Security gates

- an in-process policy requesting host authority, external effects, or scoped
  secrets is rejected;
- a brokered policy requesting direct filesystem/process/network authority is
  rejected;
- undeclared environment variables never reach a tool;
- traversal and symlink-escape fixtures cannot leave the workspace;
- network fixtures cannot reach loopback, private ranges, or metadata;
- timeout and cancel leave no descendant process;
- a confirmed invocation executes at most once across reconnect/retry;
- `outcome_unknown` is surfaced without retry;
- cross-user workspace and artifact access are denied;
- raw tool output cannot enter progress narration without sanitization.
