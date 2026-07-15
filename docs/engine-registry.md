# Engine registry: multiple engines per kind

Status: Accepted, 2026-07-15. Phase 1 (registry + facade routing) delivered with this
document.

## Problem

The stack fields one engine per kind, selected by hardcoded slot names (`asr`, `llm`,
`tts`, plus the `asr_longform` special case that proved the rule inadequate). Reality
already runs more than one of everything:

- **TTS**: kokoro is the conversation fast lane (fixed bank, RTF ≈ 0.03) while VoxCPM2
  is the quality/clone line (voice registration, design voices, streaming) and
  VoxCPM.cpp is the offline fallback. Registering a voice while conversing requires two
  engines *simultaneously*.
- **ASR**: SenseVoice takes the realtime slot; moss-transcribe owns long-form and
  diarization.
- **LLM**: a local llama-server for latency, remote or hosted models for quality.

## Decisions

1. **Instances and roles are separate namespaces.** `engines:` declares named
   *instances* (any name); a top-level `roles:` map assigns instances to *roles* the
   product asks for (`tts`, `asr`, `llm`, `asr_longform`, …). Existing configs stay
   valid: an instance named exactly like a role is that role's default when `roles:`
   does not say otherwise — today's configs are the degenerate case of the new schema.
2. **Instances carry `kind` and `capabilities`.** `kind` (`tts` | `asr` | `llm`) is
   what the instance is; `capabilities` (free-form tags; well-known: `clone`, `design`,
   `preset`, `fast`, `streaming`, `longform`, `diarize`) is what it can do. Roles route
   *by product function*; capabilities route *by request need*. The UI keeps selecting
   by capability, never by brand (web-studio decision 6).
3. **Selection is explicit-first, capability-second, role-default-last.** A request may
   name an instance (`?engine=` on the facade, `asrEngine`/`llmEngine`/`ttsEngine` in
   `session.start`); otherwise a capability need (voice registration → `clone`) picks
   the first declaring instance; otherwise the role default serves. Named instances are
   validated against the registry and the route's kind — a typo is a 400, not a
   misroute.
4. **The gateway is the only multiplexer.** Engines stay single-purpose OpenAI-compatible
   servers; the browser keeps seeing one facade. Aggregation (the union voice bank) and
   routing live in the gateway, exactly where credentials already do.
5. **Voice ids are qualified by engine at the facade.** `GET /v1/voices` returns the
   union across TTS instances with an `engine` attribution per entry; mutations on a
   specific voice carry `?engine=`. Voice ids remain engine-local — no global rename.
6. **`/v1/engines` exposes the registry, sanitized.** Name, kind, model, capabilities,
   roles served, live health — never a base URL or key. It powers the Settings table
   and pickers; the privacy boundary (duplex doc) is unchanged.

## Configuration

```yaml
engines:
  kokoro:
    kind: tts
    base_url: http://127.0.0.1:18089
    model: kokoro
    capabilities: [preset, fast]
  voxcpm2:
    kind: tts
    base_url: http://gpu-host:8880
    model: voxcpm2
    capabilities: [clone, design, streaming]
  sensevoice:
    kind: asr
    base_url: http://127.0.0.1:18098
    model: sensevoice-small
  moss:
    kind: asr
    base_url: http://127.0.0.1:18087
    model: moss-transcribe-diarize
    capabilities: [longform, diarize]
  gemma:
    kind: llm
    base_url: http://127.0.0.1:18094
    model: gemma4-12b-qat

roles:
  tts: kokoro          # conversation fast lane
  asr: sensevoice
  asr_longform: moss
  llm: gemma
```

`engine(config, role)` resolves `roles[role]` first, then an instance named `role`
(legacy), and errors otherwise. `engineByCapability(config, kind, capability)` prefers
the role default when it qualifies, then declaration order. `kind` is inferred for
legacy role-named instances (`tts`, `asr`, `asr_longform`, `llm`).

## Routing rules (gateway)

| Request | Selection |
|---|---|
| `POST /v1/audio/speech` | `?engine=` (kind-checked) else role `tts` |
| `POST /v1/audio/transcriptions` | `?engine=` else role `asr` |
| `POST /v1/chat/completions` | `?engine=` else role `llm` |
| `GET /v1/voices` | union of every `tts` instance, entries tagged `engine` |
| `POST /v1/voices` | `?engine=` else first `tts` with `clone` |
| `GET/DELETE /v1/voices/{id}` | `?engine=` else first `tts` with `clone` |
| `GET /v1/engines` | registry, sanitized, with live health |
| `session.start` | `asrEngine` / `llmEngine` / `ttsEngine` else roles |

## Non-goals

- No engine auto-discovery and no dynamic registration API: the registry is the config
  file, reviewed like everything else.
- No cross-engine voice id namespace or migration; ids stay engine-local.
- No load balancing or failover between instances (an instance is down → its requests
  fail loudly); resilience policy is a separate decision.
- CLI flag surface (`--engine`) is deferred until a CLI workflow actually needs it —
  `vox health` already probes every declared instance because it iterates the registry.

## Phases

1. **Registry + facade routing** (this delivery): config schema, resolution helpers,
   `/v1/engines`, `?engine=` overrides, union voice bank, clone-routed registration,
   session engine overrides. Gate: existing configs parse unchanged; gateway tests
   cover explicit, capability, and default selection plus kind mismatches.
2. **UI selection**: Settings engine table (health, roles, capabilities), voice bank
   engine badges/filter, generation and conversation pickers carrying the engine
   choice. Gate: registering a voice while kokoro serves the conversation works end to
   end against the live two-TTS stack.
3. **Capability polish**: per-voice capability surfacing (clone voices vs bank
   presets), longform ASR routing in the Library panel, engine hints in `turn.timing`
   telemetry.
