#!/usr/bin/env bun
/**
 * The MCP tools gate (docs/mcp-tools.md §Phases): the live conversation LLM against a
 * real stdio MCP server (packages/mcp/tools/memo-server.ts), through exactly the
 * prompts and structured results the conversation loop sends — the constants are
 * imported, not copied, so the measurement cannot drift from the product.
 *
 * Measured, all thresholds hard:
 *   - explicit commands call the right MCP tool with usable arguments;
 *   - an external call is answered with a spoken confirmation question, "确认" lands
 *     confirm_action, "算了" lands cancel_action, an unrelated utterance calls neither;
 *   - read-only queries execute without ceremony and the spoken answer carries the data;
 *   - built-in session tools keep working beside MCP tools;
 *   - zero false triggers on chat, zero invented tools, zero malformed JSON.
 *
 *   bun run measure:mcp [--config CONFIG]
 */
import { LlmClient } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { ChatMessage, ChatToolCall, ChatToolDeclaration } from "@voxstudio/contracts";
import {
  cancelToolName,
  confirmToolName,
  externalPendingResult,
  pendingSystemLine,
  toolPromptRules,
  type ConversationTool,
} from "@voxstudio/conversation";
import { connectMcpServers } from "@voxstudio/mcp";
import { loadConfig } from "@voxstudio/platform-bun";

/** The built-in session tools, declaration-only (results are canned): coexistence is what's measured. */
const BUILTIN_DECLARATIONS: ChatToolDeclaration[] = [
  { type: "function", function: { name: "set_voice", description: "切换当前对话使用的 TTS 音色",
    parameters: { type: "object", properties: { voice: { type: "string", description: "音色 ID，如 zliu、zf_001" } }, required: ["voice"] } } },
  { type: "function", function: { name: "set_speed", description: "调整语音回复的语速倍率",
    parameters: { type: "object", properties: { rate: { type: "number", description: "语速倍率，0.5 到 2.0" } }, required: ["rate"] } } },
  { type: "function", function: { name: "get_engine_status", description: "查询各语音引擎（ASR/LLM/TTS）的健康状态",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: "end_call", description: "结束本次语音对话",
    parameters: { type: "object", properties: {} } } },
];

const CONFIRMATION_DECLARATIONS: ChatToolDeclaration[] = [
  { type: "function", function: { name: confirmToolName, description: "执行当前等待用户确认的操作",
    parameters: { type: "object", properties: {} } } },
  { type: "function", function: { name: cancelToolName, description: "取消当前等待用户确认的操作",
    parameters: { type: "object", properties: {} } } },
];

async function main(): Promise<number> {
  const explicitIndex = process.argv.indexOf("--config");
  const config = explicitIndex >= 0
    ? await loadConfig({ explicit: process.argv[explicitIndex + 1] as string })
    : await loadConfig();
  const llm = new LlmClient(engine(config, "llm"));

  const source = await connectMcpServers([
    { name: "memo", command: "bun", args: ["packages/mcp/tools/memo-server.ts"] },
  ], {
    log: line => console.error(`  (${line})`),
    reservedNames: BUILTIN_DECLARATIONS.map(declaration => declaration.function.name),
  });
  const mcpTools = source.tools();
  const mcpByName = new Map<string, ConversationTool>(mcpTools.map(tool => [tool.name, tool]));
  const known = new Set([
    ...BUILTIN_DECLARATIONS.map(declaration => declaration.function.name),
    ...mcpTools.map(tool => tool.name),
    confirmToolName,
    cancelToolName,
  ]);
  const baseDeclarations: ChatToolDeclaration[] = [
    ...BUILTIN_DECLARATIONS,
    ...mcpTools.map(tool => ({
      type: "function" as const,
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    })),
  ];
  const baseSystem = `你是一个语音对话助手，用户通过说话与你交流。${toolPromptRules}`;

  const failures: string[] = [];
  let badJson = 0;
  let invented = 0;
  const check = (ok: boolean, what: string, detail: string): void => {
    console.error(`${ok ? "✓" : "✗"} ${what} -> ${detail}`);
    if (!ok) failures.push(what);
  };

  const collect = async (
    messages: ChatMessage[],
    declarations: ChatToolDeclaration[],
  ): Promise<{ calls: { name: string; args: Record<string, unknown> | undefined; raw: ChatToolCall }[]; text: string }> => {
    const raw: ChatToolCall[] = [];
    let text = "";
    for await (const item of llm.chatToolStream(messages, declarations, 300, 0)) {
      if (item.type === "text") text += item.text;
      else raw.push(...item.calls);
    }
    const calls = raw.map(call => {
      let args: Record<string, unknown> | undefined;
      try {
        args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>;
      } catch {
        badJson += 1;
      }
      if (!known.has(call.function.name)) invented += 1;
      return { name: call.function.name, args, raw: call };
    });
    return { calls, text };
  };

  /**
   * Turn 1 of the confirmation flow, exactly as the loop plays it: the model calls the
   * external tool, receives the pending result, and speaks the question. Returns the
   * history a follow-up turn sees and the pending action, or undefined on failure.
   */
  const parkExternal = async (utterance: string): Promise<
    { history: ChatMessage[]; pending: { name: string; args: Record<string, unknown> } } | undefined
  > => {
    const messages: ChatMessage[] = [
      { role: "system", content: baseSystem },
      { role: "user", content: utterance },
    ];
    const round1 = await collect(messages, baseDeclarations);
    const call = round1.calls.find(entry => entry.name === "add_memo");
    if (!call || call.args === undefined) return undefined;
    const pending = { name: call.name, args: call.args };
    const round2 = await collect([
      ...messages,
      { role: "assistant", content: round1.text, tool_calls: [call.raw] },
      { role: "tool", tool_call_id: call.raw.id, content: JSON.stringify(externalPendingResult(call.name, call.args)) },
    ], baseDeclarations);
    if (round2.calls.length > 0 || round2.text.trim() === "") return undefined;
    const question = `${round1.text}${round2.text}`;
    return { history: [{ role: "user", content: utterance }, { role: "assistant", content: question }], pending };
  };

  /** A turn asked while an action is pending: the loop's system line and confirm tools ride along. */
  const pendingTurn = async (
    parked: { history: ChatMessage[]; pending: { name: string; args: Record<string, unknown> } },
    utterance: string,
  ) => collect([
    { role: "system", content: `${baseSystem}\n${pendingSystemLine(parked.pending.name, parked.pending.args)}` },
    ...parked.history,
    { role: "user", content: utterance },
  ], [...baseDeclarations, ...CONFIRMATION_DECLARATIONS]);

  try {
    // ---- external: park, then confirm ------------------------------------------
    const confirmThread = await parkExternal("帮我记一条备忘，内容是买牛奶");
    check(confirmThread !== undefined, "external call parked and asked about",
      confirmThread ? `"${confirmThread.history[1]?.content?.slice(0, 40) ?? ""}…"` : "no add_memo call or no spoken question");
    if (confirmThread) {
      check(String(confirmThread.pending.args.content ?? "").includes("牛奶"),
        "external arguments usable", JSON.stringify(confirmThread.pending.args));
      const confirmed = await pendingTurn(confirmThread, "确认");
      const confirmCall = confirmed.calls.find(entry => entry.name === confirmToolName);
      check(confirmCall !== undefined && !confirmed.calls.some(entry => entry.name === cancelToolName),
        "\"确认\" lands confirm_action", JSON.stringify(confirmed.calls.map(entry => entry.name)));
      if (confirmCall) {
        // The confirmed action executes against the REAL server; its effect is read back below.
        const tool = mcpByName.get(confirmThread.pending.name);
        const result = await tool?.handler(confirmThread.pending.args, new AbortController().signal);
        check(typeof result === "object" && result !== null && !("error" in (result as Record<string, unknown>)),
          "confirmed action executes on the live MCP server", JSON.stringify(result));
      }
    }

    // ---- external: park, then cancel -------------------------------------------
    const cancelThread = await parkExternal("再记一条备忘，内容是倒垃圾");
    check(cancelThread !== undefined, "second external call parked", cancelThread ? "ok" : "failed");
    if (cancelThread) {
      const cancelled = await pendingTurn(cancelThread, "算了，不用记了");
      check(cancelled.calls.some(entry => entry.name === cancelToolName)
        && !cancelled.calls.some(entry => entry.name === confirmToolName),
        "\"算了\" lands cancel_action", JSON.stringify(cancelled.calls.map(entry => entry.name)));

      // ---- external: park, then talk about something else ----------------------
      const ignored = await pendingTurn(cancelThread, "今天天气怎么样？");
      check(!ignored.calls.some(entry => entry.name === confirmToolName || entry.name === cancelToolName),
        "an unrelated utterance calls neither confirm nor cancel", JSON.stringify(ignored.calls.map(entry => entry.name)));
    }

    // ---- read-only: no ceremony, real data spoken back --------------------------
    {
      const messages: ChatMessage[] = [
        { role: "system", content: baseSystem },
        { role: "user", content: "我记过哪些备忘？" },
      ];
      const round1 = await collect(messages, baseDeclarations);
      const call = round1.calls.find(entry => entry.name === "list_memos");
      check(call !== undefined, "read-only query calls list_memos", JSON.stringify(round1.calls.map(entry => entry.name)));
      if (call) {
        const result = await mcpByName.get("list_memos")?.handler({}, new AbortController().signal);
        const round2 = await collect([
          ...messages,
          { role: "assistant", content: round1.text, tool_calls: [call.raw] },
          { role: "tool", tool_call_id: call.raw.id, content: JSON.stringify(result) },
        ], baseDeclarations);
        check(round2.text.includes("牛奶") && !round2.text.includes("垃圾"),
          "spoken answer carries the confirmed memo and not the cancelled one", `"${round2.text.slice(0, 50)}…"`);
      }
    }

    // ---- built-ins keep working beside MCP tools --------------------------------
    {
      const { calls } = await collect([
        { role: "system", content: baseSystem },
        { role: "user", content: "把声音换成 zliu" },
      ], baseDeclarations);
      check(calls.some(entry => entry.name === "set_voice" && entry.args?.voice === "zliu"),
        "built-in set_voice still routes correctly", JSON.stringify(calls));
    }

    // ---- decoys: chat must not trigger MCP tools --------------------------------
    for (const utterance of ["备忘录功能是怎么实现的？", "你的声音真好听", "给我讲个笑话"]) {
      const { calls } = await collect([
        { role: "system", content: baseSystem },
        { role: "user", content: utterance },
      ], baseDeclarations);
      check(calls.length === 0, `no false trigger: ${utterance}`, calls.length === 0 ? "no calls" : JSON.stringify(calls));
    }
  } finally {
    await source.close();
  }

  console.error(`bad-json ${badJson}  invented ${invented}`);
  const pass = failures.length === 0 && badJson === 0 && invented === 0;
  console.error(pass ? "MCP GATE: PASS" : `MCP GATE: FAIL (${failures.join("; ")})`);
  return pass ? 0 : 1;
}

process.exitCode = await main();
