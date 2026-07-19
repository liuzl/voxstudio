# Agent voice: the MCP server surface

Status: Accepted, 2026-07-19. Phase 1 delivered the same day — the gate passed with
the official SDK client against live engines (see Phases). The `apps/mcp` surface the
README's architecture diagram
and [product-runtime.md](./product-runtime.md) planned: voxstudio's voice I/O
exposed **to** agents over MCP — the mirror of [mcp-tools.md](./mcp-tools.md),
which brought agents' tools **into** the voice conversation.

## Scope

A thin MCP server over the existing engine contract: any MCP client — Claude Code
with one config line, or anything speaking the official SDK — gains a voice on the
machine this server runs on. The first use is the self-hosted notification path:
a long task finishes, a gate passes, a confirmation is needed, and the agent says
so through the local speakers instead of hoping a terminal is watched.

Out of scope for phase 1: a live duplex conversation over MCP (turn-taking does
not map onto request/response tools), the HTTP transport (`--port`, phase 2), and
exposing voice cloning/design (registry writes stay on the gateway's REST facade).

## Decisions

1. **Three tools, engine-contract deep and no deeper.**
   - `speak(text, voice?)` — sanitize, chunk, and synthesize through the
     configured TTS role and play on the host speakers via the certified ffplay
     sink — the same `streamLong` path `vox say --play` runs. Returns
     `{ ok, voice, duration_s, first_audio_ms }` after the audio finished.
   - `transcribe(path, language?)` — a local audio file through the configured
     ASR role. A path, not base64: the callers are local agents that have files.
   - `list_voices()` (`readOnlyHint`) — the configured TTS engine's registry, so
     an agent can pick a voice it heard about.
2. **Speech is serialized, never overlapped.** Concurrent `speak` calls queue:
   one utterance owns the speakers at a time, in arrival order. An agent firing
   two notifications gets them one after another, not on top of each other.
3. **The server is a factory, the binary is wiring.** `createAgentVoiceServer`
   builds the `McpServer` from a `VoxConfig` plus injectable fetch and sink
   seams; `vox-mcp` (main.ts) wires `loadConfig`, the real ffplay sink, and the
   stdio transport. Unit tests drive the factory over `InMemoryTransport` with
   fake engines and a capturing sink — the real protocol, no process, no audio.
4. **Errors are structured tool results, not protocol faults.** A missing file,
   an unreachable engine, an unknown voice: `isError` with a plain sentence the
   calling model can relay. The server stays up; a dead TTS engine costs the
   call, not the session.
5. **Honest annotations.** `speak` is not read-only — it makes sound. If
   voxstudio's own conversation loop connects to this server one day, `speak`
   would correctly land as an `external` effect and ride the spoken confirmation
   flow; a `trust: true` config line is the operator's way around it.

## Phases and gates

1. **The factory, the three tools, the stdio binary.** Unit tests: tools listed
   with honest annotations and schemas; `speak` synthesizes through a fake engine
   into a capturing sink and reports duration; two concurrent `speak`s serialize;
   `transcribe` round-trips a wav path and passes the language hint;
   engine/file failures come back `isError` with the server still answering.
   **Gate** (`bun run measure:agent-voice`, live engines): the official SDK
   client spawns the real binary over stdio with zero server-side accommodations;
   `list_voices` returns a non-empty bank; `speak` audibly plays a short
   notification through the local speakers and reports a plausible duration;
   a TTS-synthesized wav fed to `transcribe` comes back with the key phrase
   intact — the round trip crosses both live engines.
   **Delivered 2026-07-19.** `bun run measure:agent-voice` PASS: the SDK client
   spawned the real binary, listed the three tools, saw an 11-voice bank, played a
   3.6s notification audibly (first audio 1.7s), and the synthesized "今天的天气
   很不错。" came back from `transcribe` verbatim.
2. **HTTP transport** (`--port`, token-gated like the gateway) for remote agents;
   `save_speech(text, path)` if agents turn out to want files; Claude Code
   dogfood config documented once real use settles the tool shapes.
