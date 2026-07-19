import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerConfig } from "@voxstudio/contracts";
import type { ConversationTool, ToolEffect } from "@voxstudio/conversation";

/**
 * The MCP → conversation-tool bridge (docs/mcp-tools.md): servers from config become
 * ConversationTools the loop can offer the model. Effects come from annotations —
 * `readOnlyHint` executes immediately, everything else is `external` and rides the
 * spoken confirmation flow — unless the operator marked the server `trust: true`.
 */

export interface McpToolSource {
  /** Fresh tool objects per call; handlers close over the shared clients. */
  tools(): ConversationTool[];
  close(): Promise<void>;
}

export interface ConnectOptions {
  /** Operational logging (connections, skips, failures). No tool arguments or results. */
  log?: (line: string) => void;
  /** Per-call ceiling before an MCP server's silence becomes a structured tool error. */
  callTimeoutMs?: number;
  /**
   * Ceiling on connect + tool listing per server (default 5s). A hung server is skipped
   * like a dead one — surfaces await this connection before their first conversation, so
   * unbounded here means a session that never starts.
   */
  connectTimeoutMs?: number;
  /** Names already taken by built-in session tools; colliding MCP tools get the server prefix. */
  reservedNames?: readonly string[];
  /** Test seam: transports by server name, instead of spawning/dialing real ones. */
  transportFor?: (server: McpServerConfig) => Transport | undefined;
}

interface BridgedTool {
  tool: ConversationTool;
  serverName: string;
}

const defaultCallTimeoutMs = 15_000;

function transportFrom(server: McpServerConfig): Transport {
  if (server.command !== undefined) {
    return new StdioClientTransport({
      command: server.command,
      args: server.args ?? [],
      // A minimal environment plus the declared extras: the child gets what the config
      // says it needs, not the surface's whole environment.
      env: { ...(process.env.PATH === undefined ? {} : { PATH: process.env.PATH }), ...server.env },
      stderr: "ignore",
    });
  }
  const token = server.tokenEnv === undefined ? undefined : process.env[server.tokenEnv];
  // The SDK types sessionId as non-optional-yet-undefined; safe under our stricter flags.
  return new StreamableHTTPClientTransport(new URL(server.url as string), {
    ...(token === undefined ? {} : {
      requestInit: { headers: { authorization: `Bearer ${token}` } },
    }),
  }) as unknown as Transport;
}

/** Result content → the loop's tool-result convention: structured wins, text parses, isError refuses. */
function mapResult(result: {
  content?: { type: string; text?: string }[];
  structuredContent?: unknown;
  isError?: boolean;
}): unknown {
  const text = (result.content ?? [])
    .filter(part => part.type === "text" && typeof part.text === "string")
    .map(part => part.text as string)
    .join("\n");
  if (result.isError) return { error: text || "the MCP tool reported an error" };
  if (result.structuredContent !== undefined) return result.structuredContent;
  if (!text) return { ok: true };
  try {
    return JSON.parse(text);
  } catch {
    return { output: text };
  }
}

/**
 * Connect the configured servers and bridge their tools. A server that fails to
 * connect or list is logged and skipped — a dead memo server must not cost the
 * conversation. Call `close()` at surface shutdown.
 */
export async function connectMcpServers(
  servers: McpServerConfig[],
  options: ConnectOptions = {},
): Promise<McpToolSource> {
  const log = options.log ?? (() => {});
  const clients: { name: string; client: Client }[] = [];
  const bridged: BridgedTool[] = [];
  const taken = new Set<string>(options.reservedNames ?? []);

  for (const server of servers) {
    let client: Client | undefined;
    try {
      client = new Client({ name: "voxstudio", version: "1.0.0" });
      const transport = options.transportFor?.(server) ?? transportFrom(server);
      const connected = client;
      const connecting = client.connect(transport).then(() => connected.listTools());
      const timeoutMs = options.connectTimeoutMs ?? 5_000;
      const listing = await Promise.race([
        connecting,
        new Promise<never>((_, reject) => {
          setTimeout(() => { reject(new Error(`did not answer within ${timeoutMs}ms`)); }, timeoutMs);
        }),
      ]);
      // A late arrival after the timeout lost the race: the rejection above already
      // skipped the server, and this handler just keeps the loss from being unhandled.
      connecting.catch(() => {});
      clients.push({ name: server.name, client });
      for (const entry of listing.tools) {
        // Raw names are what authors tuned their descriptions for; a collision with a
        // built-in or an earlier server gets the deterministic server prefix.
        const name = taken.has(entry.name) ? `${server.name}_${entry.name}` : entry.name;
        taken.add(name);
        const effect: ToolEffect = server.trust === true
          ? "session"
          : entry.annotations?.readOnlyHint === true ? "read" : "external";
        bridged.push({
          serverName: server.name,
          tool: {
            name,
            description: entry.description ?? entry.title ?? name,
            parameters: (entry.inputSchema as Record<string, unknown> | undefined) ?? { type: "object", properties: {} },
            effect,
            handler: async (args, signal) => {
              try {
                const result = await connected.callTool(
                  { name: entry.name, arguments: args },
                  undefined,
                  { signal, timeout: options.callTimeoutMs ?? defaultCallTimeoutMs },
                );
                return mapResult(result as Parameters<typeof mapResult>[0]);
              } catch (error) {
                return { error: error instanceof Error ? error.message : String(error) };
              }
            },
          },
        });
      }
      log(`mcp: ${server.name} connected, ${listing.tools.length} tools`);
    } catch (error) {
      log(`mcp: ${server.name} unavailable, skipped: ${error instanceof Error ? error.message : String(error)}`);
      void client?.close().catch(() => {});
    }
  }

  return {
    tools: () => bridged.map(entry => entry.tool),
    close: async () => {
      await Promise.allSettled(clients.map(entry => entry.client.close()));
    },
  };
}
