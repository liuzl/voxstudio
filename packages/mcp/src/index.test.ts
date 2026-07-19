import { describe, expect, test } from "bun:test";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { McpServerConfig } from "@voxstudio/contracts";
import { z } from "zod";
import { connectMcpServers } from "./index";

/** A real MCP memo server over the real protocol, no process: the SDK's linked pair. */
function memoServer(): { transport: InMemoryTransport; memos: string[] } {
  const memos: string[] = [];
  const server = new McpServer({ name: "memo", version: "0.0.1" });
  server.registerTool("add_memo", {
    description: "记一条备忘",
    inputSchema: { content: z.string() },
  }, async ({ content }) => {
    memos.push(content);
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, count: memos.length }) }] };
  });
  server.registerTool("list_memos", {
    description: "列出所有备忘",
    annotations: { readOnlyHint: true },
  }, async () => ({ content: [{ type: "text", text: JSON.stringify({ memos }) }] }));
  server.registerTool("set_voice", {
    description: "一个撞了内建名字的工具",
    annotations: { readOnlyHint: true },
  }, async () => ({ content: [{ type: "text", text: "plain words, not JSON" }] }));
  server.registerTool("explode", {
    description: "总是失败",
  }, async () => ({ isError: true, content: [{ type: "text", text: "boom" }] }));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  void server.connect(serverTransport);
  return { transport: clientTransport, memos };
}

const memoConfig: McpServerConfig = { name: "memo", command: "unused" };

describe("mcp bridge", () => {
  test("bridges tools with annotation-derived effects and reserved-name prefixing", async () => {
    const { transport } = memoServer();
    const source = await connectMcpServers([memoConfig], {
      reservedNames: ["set_voice"],
      transportFor: () => transport,
    });
    const byName = new Map(source.tools().map(tool => [tool.name, tool]));
    expect([...byName.keys()].sort()).toEqual(["add_memo", "explode", "list_memos", "memo_set_voice"]);
    expect(byName.get("add_memo")?.effect).toBe("external");
    expect(byName.get("explode")?.effect).toBe("external");
    expect(byName.get("list_memos")?.effect).toBe("read");
    expect(byName.get("add_memo")?.parameters).toMatchObject({
      type: "object",
      properties: { content: { type: "string" } },
      required: ["content"],
    });
    await source.close();
  });

  test("calls round-trip: JSON text parses, plain text wraps, isError refuses", async () => {
    const { transport, memos } = memoServer();
    const source = await connectMcpServers([memoConfig], { transportFor: () => transport });
    const byName = new Map(source.tools().map(tool => [tool.name, tool]));
    const signal = new AbortController().signal;

    const added = await byName.get("add_memo")?.handler({ content: "买牛奶" }, signal);
    expect(added).toEqual({ ok: true, count: 1 });
    expect(memos).toEqual(["买牛奶"]);

    const listed = await byName.get("list_memos")?.handler({}, signal);
    expect(listed).toEqual({ memos: ["买牛奶"] });

    // Plain-text output wraps rather than failing JSON parsing.
    expect(await byName.get("set_voice")?.handler({}, signal)).toEqual({ output: "plain words, not JSON" });

    // isError maps to the loop's { error } convention: the model reads a structured refusal.
    expect(await byName.get("explode")?.handler({}, signal)).toEqual({ error: "boom" });
    await source.close();
  });

  test("trust: true downgrades a server's tools to immediate session effects", async () => {
    const { transport } = memoServer();
    const source = await connectMcpServers([{ ...memoConfig, trust: true }], { transportFor: () => transport });
    for (const tool of source.tools()) expect(tool.effect).toBe("session");
    await source.close();
  });

  test("a server that fails to connect is skipped without costing the rest", async () => {
    const { transport } = memoServer();
    const lines: string[] = [];
    const source = await connectMcpServers(
      [{ name: "dead", command: "unused" }, memoConfig],
      {
        log: line => lines.push(line),
        transportFor: server => {
          if (server.name === "dead") throw new Error("no such server");
          return transport;
        },
      },
    );
    expect(source.tools().length).toBe(4);
    expect(lines.some(line => line.includes("dead unavailable"))).toBe(true);
    await source.close();
  });
});
