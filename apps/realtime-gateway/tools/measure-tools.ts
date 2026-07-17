#!/usr/bin/env bun
/**
 * The tool gate (docs/tool-loop.md §2, phases §1): the 2026-07-18 spike promoted to a
 * repeatable measurement against the live conversation LLM. Thresholds are hard:
 * every explicit command must call its tool with usable arguments, plain chat must
 * never trigger one, and the model must never invent a tool or emit broken JSON.
 *
 *   bun run measure:tools [--config CONFIG]
 */
import { LlmClient } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { ChatMessage, ChatToolCall } from "@voxstudio/contracts";
import { toolPromptRules } from "@voxstudio/conversation";
import { loadConfig } from "@voxstudio/platform-bun";

const TOOLS = [
  { type: "function" as const, function: { name: "set_voice", description: "切换当前对话使用的 TTS 音色",
    parameters: { type: "object", properties: { voice: { type: "string", description: "音色 ID，如 zliu、zf_001、af_maple" } }, required: ["voice"] } } },
  { type: "function" as const, function: { name: "set_speed", description: "调整语音回复的语速倍率",
    parameters: { type: "object", properties: { rate: { type: "number", description: "语速倍率，0.5 到 2.0，1.0 为正常" } }, required: ["rate"] } } },
  { type: "function" as const, function: { name: "get_engine_status", description: "查询各语音引擎（ASR/LLM/TTS）的健康状态",
    parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "end_call", description: "结束本次语音对话",
    parameters: { type: "object", properties: {} } } },
];
const KNOWN = new Set(TOOLS.map(tool => tool.function.name));

type Expect =
  | { kind: "call"; name: string; args?: Record<string, unknown>; rateBelowOne?: boolean }
  | { kind: "no_call" }
  | { kind: "clarify_or_call" }
  | { kind: "no_invented_tool" };

const CASES: { utterance: string; expect: Expect }[] = [
  { utterance: "把声音换成 zliu", expect: { kind: "call", name: "set_voice", args: { voice: "zliu" } } },
  { utterance: "换个女声，用 zf_001 吧", expect: { kind: "call", name: "set_voice", args: { voice: "zf_001" } } },
  { utterance: "语速调到 1.5 倍", expect: { kind: "call", name: "set_speed", args: { rate: 1.5 } } },
  { utterance: "说慢一点", expect: { kind: "call", name: "set_speed", rateBelowOne: true } },
  { utterance: "帮我看看引擎状态正常吗", expect: { kind: "call", name: "get_engine_status" } },
  { utterance: "好了先这样，挂了吧", expect: { kind: "call", name: "end_call" } },
  { utterance: "不聊了，再见", expect: { kind: "call", name: "end_call" } },
  { utterance: "今天天气怎么样？", expect: { kind: "no_call" } },
  { utterance: "给我讲个笑话", expect: { kind: "no_call" } },
  { utterance: "你觉得 opus 和 pcm 编码有什么区别？", expect: { kind: "no_call" } },
  { utterance: "你的声音真好听", expect: { kind: "no_call" } },
  { utterance: "什么是语音活动检测？", expect: { kind: "no_call" } },
  { utterance: "换一个声音", expect: { kind: "clarify_or_call" } },
  { utterance: "太快了", expect: { kind: "call", name: "set_speed", rateBelowOne: true } },
  { utterance: "用英文的声音读", expect: { kind: "clarify_or_call" } },
  { utterance: "先暂停一下", expect: { kind: "no_invented_tool" } },
];

async function main(): Promise<number> {
  const explicitIndex = process.argv.indexOf("--config");
  const config = explicitIndex >= 0
    ? await loadConfig({ explicit: process.argv[explicitIndex + 1] as string })
    : await loadConfig();
  const llm = new LlmClient(engine(config, "llm"));

  let shouldCall = 0, shouldCallTotal = 0;
  let falseTriggers = 0, noCallTotal = 0;
  let edgeOk = 0, edgeTotal = 0;
  let badJson = 0, invented = 0;
  const failures: string[] = [];

  for (const { utterance, expect } of CASES) {
    const messages: ChatMessage[] = [
      { role: "system", content: `你是一个语音对话助手，用户通过说话与你交流。${toolPromptRules}` },
      { role: "user", content: utterance },
    ];
    const calls: ChatToolCall[] = [];
    let text = "";
    for await (const item of llm.chatToolStream(messages, TOOLS, 200, 0)) {
      if (item.type === "text") text += item.text;
      else calls.push(...item.calls);
    }
    const parsed = calls.map(call => {
      let args: Record<string, unknown> | undefined;
      try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; }
      catch { badJson += 1; }
      if (!KNOWN.has(call.function.name)) invented += 1;
      return { name: call.function.name, args };
    });

    let ok = false;
    if (expect.kind === "call") {
      shouldCallTotal += 1;
      ok = parsed.some(call => call.name === expect.name
        && (expect.args === undefined || Bun.deepEquals(call.args, expect.args))
        && (!expect.rateBelowOne || (typeof call.args?.rate === "number" && call.args.rate < 1)));
      shouldCall += ok ? 1 : 0;
    } else if (expect.kind === "no_call") {
      noCallTotal += 1;
      ok = parsed.length === 0;
      falseTriggers += ok ? 0 : 1;
    } else {
      edgeTotal += 1;
      ok = expect.kind === "no_invented_tool"
        ? parsed.every(call => KNOWN.has(call.name))
        : (parsed.length === 0 && text.length > 0) || parsed.every(call => KNOWN.has(call.name) && call.args !== undefined);
      edgeOk += ok ? 1 : 0;
    }
    const summary = parsed.length > 0 ? JSON.stringify(parsed) : text.slice(0, 40);
    console.error(`${ok ? "✓" : "✗"} ${utterance} -> ${summary}`);
    if (!ok) failures.push(utterance);
  }

  console.error(`\nexplicit ${shouldCall}/${shouldCallTotal}  false-triggers ${falseTriggers}/${noCallTotal}  edge ${edgeOk}/${edgeTotal}  bad-json ${badJson}  invented ${invented}`);
  const pass = shouldCall === shouldCallTotal && falseTriggers === 0 && badJson === 0 && invented === 0 && edgeOk === edgeTotal;
  console.error(pass ? "TOOL GATE: PASS" : `TOOL GATE: FAIL (${failures.join("; ")})`);
  return pass ? 0 : 1;
}

process.exitCode = await main();
