# MCP tools in the conversation loop

Status: Accepted, 2026-07-19. Phase 1 delivered the same day — the gate passed
against the live conversation LLM and a real stdio server (see Phases). The second
consumer of the tool loop
([tool-loop.md](./tool-loop.md) phase 3): external MCP tools presented through the
same registration the built-in session tools use — and with them, the first
`effect: "external"` tools, which force the spoken confirmation flow the tool-loop
design deferred "until an external tool exists to need it."

## Scope

Voxstudio acts as an **MCP client**: servers declared in config are connected by the
surface (the CLI and the realtime gateway), their tools are bridged into
`ConversationTool`s, and voice drives them through the existing loop — discovery,
schemas, and invocation all via the official `@modelcontextprotocol/sdk`
(spike-verified under Bun on 2026-07-19: `listTools` returns JSON Schema usable
verbatim as tool parameters, plus the `readOnlyHint` annotation the effect mapping
needs; `InMemoryTransport` gives unit tests the real protocol without a process).

Out of scope: the MCP *server* surface (`apps/mcp`, giving other agents our voice
I/O — a different roadmap item), sampling/prompts/resources (tools only), and the
SSE legacy transport.

## Decisions

1. **Config declares servers; surfaces connect once per process.**
   ```yaml
   mcp_servers:
     memo:
       command: bun               # stdio: command + args + env
       args: [tools/memo-server.ts]
     weather:
       url: https://example.com/mcp   # streamable HTTP
       token_env: WEATHER_TOKEN       # Authorization: Bearer from the environment
       trust: true                    # optional: skip confirmation for this server
   ```
   Secrets never enter the yaml — `token_env` names an environment variable. A
   server that fails to connect is logged and skipped, and one that hangs is
   skipped at a 5s ceiling (adversarial review, 2026-07-19: surfaces await this
   connection before their first conversation, so unbounded meant a session that
   never starts): a dead memo server must not cost the conversation.
2. **Annotations choose the effect; the effect chooses the ceremony.**
   `readOnlyHint: true` → `effect: "read"` (executes immediately, like
   `get_engine_status`). Everything else → the new `effect: "external"` — the
   loop does not execute it without spoken confirmation. A server marked
   `trust: true` downgrades its tools to `"session"` (immediate, reversible-by-
   assumption); that is the operator's explicit signature, not a default.
3. **The confirmation flow is model-mediated, one pending at a time, one turn wide.**
   No keyword matching — the same principle that let "换一个声音" become a
   clarifying question:
   - An `external` call is **not executed**. The loop stores it as the pending
     action and feeds the model a structured
     `{ pending_confirmation, action, arguments }` result whose note instructs it
     to restate the action aloud and ask; surfaces see a new `onToolPending`
     callback (the gateway emits a backwards-compatible `tool.pending` v1 event).
   - On the **next completed turn only**, the declarations gain two loop-owned
     synthetic tools — `confirm_action` and `cancel_action` — and the system
     prompt gains one line naming the pending action. "确认/执行吧" becomes
     `confirm_action` (the loop runs the real handler now, under the current
     turn's AbortSignal, and refeeds the real result); "算了" becomes
     `cancel_action`; an unrelated utterance consumes the window — the pending
     action is dropped, and a later "确认" confirms nothing.
   - The heard-only rule applies: the window is consumed when a turn completes
     audibly, so an aborted or reopened dispatch leaves the pending action
     intact. A second `external` call while one is pending returns a structured
     `{ error }` the model relays — one question in the air at a time.
   - The prompt strings (`externalPendingResult`, the pending system line) are
     exported constants: the gate measures the model against exactly what the
     loop sends, and changing them means re-running `measure:mcp`.
4. **Names stay raw; collisions are resolved deterministically.** MCP tool names
   are what their authors tuned the model-facing descriptions for. A name that
   collides with a built-in session tool or an earlier server's tool is prefixed
   `<server>_`; config map order makes this deterministic. The gateway composes
   per-session tools as built-ins → surface extras (OpenAI-adapter client
   tools) → MCP tools, deduplicating by name, first wins: a connected client
   owns the function names it declared, so an ambient MCP tool must never
   absorb its calls (found by adversarial review, 2026-07-19).
5. **The bridge is a small package, not loop code.** `@voxstudio/mcp` exposes
   `connectMcpServers(configs) → { tools(), close() }`; tool results map text
   content through as-is (parsed as JSON when possible), `structuredContent`
   wins when present, and `isError` becomes the loop's `{ error }` convention —
   the model reads a structured refusal either way. Handlers pass the turn's
   AbortSignal to `callTool`; a barge-in cancels an in-flight MCP call like
   everything else.

## Phases and gates

1. **`external` effect + confirmation flow in the loop; the bridge; both surfaces
   wired.** Unit tests drive the confirm / cancel / ignore-drops / replace-refused
   paths with a scripted LLM, and the bridge against a real in-memory MCP server
   (annotations→effect, error mapping, collision prefixing). **Gate**
   (`bun run measure:mcp`, live gemma + a real stdio memo server): explicit
   commands call the right MCP tool with exact arguments; the external call is
   answered with a spoken confirmation question, "确认" lands `confirm_action`,
   "算了" lands `cancel_action`, an unrelated utterance calls neither; read-only
   queries execute without ceremony and the spoken answer carries the data;
   built-in tools keep working beside MCP tools; zero false triggers on chat,
   zero invented tools, zero malformed JSON.
   **Delivered 2026-07-19.** `bun run measure:mcp` PASS on live gemma with the real
   memo server over stdio: park → ask → "确认" → executed on the server
   (`{ok, count:1}`) → read back later by voice; "算了" → `cancel_action`; the
   unrelated utterance called neither; decoys 0/3; `set_voice` still routes; zero
   malformed/invented across the suite. One finding folded back into the design:
   the bare pending line let the model cancel in words without calling
   `cancel_action` — the same claiming-without-calling failure the original tool
   spike measured, fixed the same way with a hard sentence in `pendingSystemLine`
   (re-measured: cancel lands, the unrelated case still calls nothing). Safety
   never depended on it — nothing executes without `confirm_action` — but the
   deterministic acknowledgement does.
2. **Later**: Web caption chips for `tool.pending`; multi-pending batches if real
   usage demands them; the MCP server surface (`apps/mcp`) as its own design.
