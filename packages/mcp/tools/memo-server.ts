#!/usr/bin/env bun
/**
 * A real stdio MCP server for the MCP gate (bun run measure:mcp) and local demos: one
 * external-effect tool (add_memo, no readOnlyHint -> spoken confirmation) and one
 * read-effect tool (list_memos). State lives for the process, which is the point — the
 * gate confirms an action in one exchange and reads its effect back in another.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const memos: string[] = [];
const server = new McpServer({ name: "memo", version: "1.0.0" });

server.registerTool("add_memo", {
  description: "记一条备忘录",
  inputSchema: { content: z.string().describe("备忘内容") },
}, async ({ content }) => {
  memos.push(content);
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, count: memos.length }) }] };
});

server.registerTool("list_memos", {
  description: "列出已有的所有备忘录",
  annotations: { readOnlyHint: true },
}, async () => ({ content: [{ type: "text", text: JSON.stringify({ memos }) }] }));

await server.connect(new StdioServerTransport());
