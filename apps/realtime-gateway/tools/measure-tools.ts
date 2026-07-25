#!/usr/bin/env bun
/**
 * The tool gate (docs/tool-loop.md §2, phases §1–2): the 2026-07-18 spike promoted to a
 * repeatable measurement against the live conversation LLM. Three phases, all hard:
 *
 *   1. single-turn — the original 16 cases;
 *   2. multi-turn  — the same 16 cases asked at turn 9 of a realistic 8-exchange
 *      history that deliberately includes an earlier voice-switch conversation (the
 *      adversarial part: later praise/chat must still not re-trigger tools);
 *   3. multi-action — compound commands needing two tools, driven through the same
 *      bounded execute-and-refeed rounds the conversation loop runs.
 *
 * Thresholds: every explicit command calls its tool with usable arguments, plain chat
 * never triggers one, and the model never invents a tool or emits broken JSON.
 *
 *   bun run measure:tools [--config CONFIG]
 *
 * `--studio` is the voice-studio-control phase-1 capacity experiment
 * (docs/voice-studio-control.md): the six Studio tool *descriptions* join the
 * surface (no handlers exist yet) and the same three phases run over the
 * enlarged tool list — the original cases must not degrade, and the new
 * intents must route with usable arguments. This flag decides whether that
 * design proceeds or falls back to a two-stage router.
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
/** The phase-1 candidates from docs/voice-studio-control.md §Tool inventory — descriptions
 * only. If accepted, these strings become gate constants exactly like the four above. */
const STUDIO_TOOLS = [
  { type: "function" as const, function: { name: "save_last_utterance_as_voice", description: "把用户刚才说的那句话注册为一个新的克隆音色样本",
    parameters: { type: "object", properties: { voice: { type: "string", description: "新音色的 ID" } }, required: ["voice"] } } },
  { type: "function" as const, function: { name: "redo_last_reply", description: "把上一条回复重新念一遍，可以换音色或语速",
    parameters: { type: "object", properties: { voice: { type: "string", description: "改用的音色 ID，可选" }, rate: { type: "number", description: "语速倍率 0.5-2.0，可选" } } } } },
  { type: "function" as const, function: { name: "remember_pronunciation", description: "记住一个词的正确读法，之后的回复按这个发音读",
    parameters: { type: "object", properties: { term: { type: "string", description: "要纠正的词" }, reading: { type: "string", description: "正确读法" } }, required: ["term", "reading"] } } },
  { type: "function" as const, function: { name: "persist_pronunciations", description: "把本次对话记住的发音永久保存到配置文件",
    parameters: { type: "object", properties: {} } } },
  { type: "function" as const, function: { name: "generate_take", description: "用指定音色合成一段语音，保存到生成面板",
    parameters: { type: "object", properties: { text: { type: "string", description: "要合成的文本" }, voice: { type: "string", description: "音色 ID，可选" } }, required: ["text"] } } },
  { type: "function" as const, function: { name: "audit_profile", description: "检查一个设计音色与当前引擎运行时是否一致（有没有漂移）",
    parameters: { type: "object", properties: { profile: { type: "string", description: "设计音色的 ID" } }, required: ["profile"] } } },
];

type Expect =
  | { kind: "call"; name: string; args?: Record<string, unknown>; rateBelowOne?: boolean; hasArgs?: string[] }
  | { kind: "no_call" }
  | { kind: "clarify_or_call" }
  | { kind: "no_invented_tool" };

const CASES: { utterance: string; expect: Expect; pre?: ChatMessage[] }[] = [
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

/** The studio intents, and decoys aimed at the enlarged surface's new confusion edges.
 * `pre` is per-case context: persist only makes sense after a remember — asked cold, the
 * model correctly refuses to save an empty set (measured 2026-07-25), so the case carries
 * the exchange production would have. */
const STUDIO_CASES: { utterance: string; expect: Expect; pre?: ChatMessage[] }[] = [
  { utterance: "把我刚才那句话存成音色样本，就叫 myvoice", expect: { kind: "call", name: "save_last_utterance_as_voice", args: { voice: "myvoice" } } },
  { utterance: "用 zf_001 的声音把刚才那句再念一遍", expect: { kind: "call", name: "redo_last_reply", args: { voice: "zf_001" } } },
  { utterance: "记住：VoxCPM 要读作 vox-c-p-m", expect: { kind: "call", name: "remember_pronunciation", hasArgs: ["term", "reading"] } },
  { utterance: "把这些发音保存下来，以后都这么读",
    pre: [
      { role: "user", content: "记住：VoxCPM 要读作 vox-c-p-m" },
      { role: "assistant", content: "好的，我记住了：VoxCPM 读作 vox-c-p-m，之后都按这个读。" },
    ],
    expect: { kind: "call", name: "persist_pronunciations" } },
  { utterance: "用 calm 的声音生成一句「欢迎光临」", expect: { kind: "call", name: "generate_take", hasArgs: ["text"] } },
  { utterance: "检查一下 design-calm-clear 这个音色有没有漂移", expect: { kind: "call", name: "audit_profile", args: { profile: "design-calm-clear" } } },
  // Decoys on the new tools' semantic edges: mention of pronunciation, repetition,
  // voices, and generation that a chat reply serves and a tool call would break.
  { utterance: "这个词你发音真标准", expect: { kind: "no_call" } },
  { utterance: "你觉得哪个音色最好听？", expect: { kind: "no_call" } },
  { utterance: "我刚才说到哪儿了？", expect: { kind: "no_call" } },
  { utterance: "帮我把这句话翻译成英文", expect: { kind: "no_invented_tool" } },
  // Underspecified save: required id missing — a clarifying question or a call with
  // usable arguments both count, silence does not.
  { utterance: "把刚才那句存下来", expect: { kind: "clarify_or_call" } },
];

/** Turn 1–8: everyday chatter shaped exactly like the loop's history (text pairs only). */
const HISTORY: ChatMessage[] = [
  { role: "user", content: "今天天气怎么样？" },
  { role: "assistant", content: "抱歉，我拿不到实时天气，你可以看看手机上的天气应用。" },
  { role: "user", content: "给我讲个宇航员的笑话" },
  { role: "assistant", content: "宇航员为什么不用社交软件？因为他们已经在太空里了。" },
  { role: "user", content: "把声音换成 zf_001" },
  { role: "assistant", content: "好的，已经切换到 zf_001。" },
  { role: "user", content: "什么是采样率？" },
  { role: "assistant", content: "采样率是每秒对声音信号取样的次数，比如 48kHz 就是每秒四万八千次。" },
  { role: "user", content: "谢谢，这个声音不错" },
  { role: "assistant", content: "谢谢夸奖！我会继续保持。" },
  { role: "user", content: "opus 和 pcm 有什么区别？" },
  { role: "assistant", content: "PCM 是未压缩的原始采样，Opus 是高效的有损压缩编码，带宽差三十倍以上。" },
  { role: "user", content: "再讲一个笑话吧" },
  { role: "assistant", content: "程序员最讨厌的两件事：写注释，和别人不写注释。" },
  { role: "user", content: "哈哈，还行" },
  { role: "assistant", content: "能逗你笑就好。" },
];

/** Compound commands: both tools must land, within the loop's round bound. */
const MULTI_ACTION: { utterance: string; expects: { name: string; args?: Record<string, unknown> }[] }[] = [
  { utterance: "换成 zf_001，顺便把语速调到 1.2 倍",
    expects: [{ name: "set_voice", args: { voice: "zf_001" } }, { name: "set_speed", args: { rate: 1.2 } }] },
  { utterance: "帮我看下引擎状态，然后把语速恢复正常",
    expects: [{ name: "get_engine_status" }, { name: "set_speed", args: { rate: 1 } }] },
  { utterance: "先换回 zliu，然后咱们就挂了吧",
    expects: [{ name: "set_voice", args: { voice: "zliu" } }, { name: "end_call" }] },
];
const MAX_ROUNDS = 3;

async function main(): Promise<number> {
  const explicitIndex = process.argv.indexOf("--config");
  const config = explicitIndex >= 0
    ? await loadConfig({ explicit: process.argv[explicitIndex + 1] as string })
    : await loadConfig();
  const studio = process.argv.includes("--studio");
  const activeTools = studio ? [...TOOLS, ...STUDIO_TOOLS] : TOOLS;
  const activeCases = studio ? [...CASES, ...STUDIO_CASES] : CASES;
  const known = new Set(activeTools.map(tool => tool.function.name));
  if (studio) console.error(`studio capacity experiment: ${activeTools.length} tools, ${activeCases.length} cases per suite\n`);
  const llm = new LlmClient(engine(config, "llm"));
  const system: ChatMessage = {
    role: "system",
    content: `你是一个语音对话助手，用户通过说话与你交流。${toolPromptRules}`,
  };
  const failures: string[] = [];
  let badJson = 0;
  let invented = 0;

  const collect = async (messages: ChatMessage[]): Promise<{ parsed: { name: string; args: Record<string, unknown> | undefined }[]; text: string; raw: ChatToolCall[] }> => {
    const raw: ChatToolCall[] = [];
    let text = "";
    for await (const item of llm.chatToolStream(messages, activeTools, 200, 0)) {
      if (item.type === "text") text += item.text;
      else raw.push(...item.calls);
    }
    const parsed = raw.map(call => {
      let args: Record<string, unknown> | undefined;
      try { args = JSON.parse(call.function.arguments || "{}") as Record<string, unknown>; }
      catch { badJson += 1; }
      if (!known.has(call.function.name)) invented += 1;
      return { name: call.function.name, args };
    });
    return { parsed, text, raw };
  };

  const runSuite = async (label: string, history: ChatMessage[]): Promise<boolean> => {
    let shouldCall = 0, shouldCallTotal = 0;
    let falseTriggers = 0, noCallTotal = 0;
    let edgeOk = 0, edgeTotal = 0;
    for (const { utterance, expect, pre } of activeCases) {
      const { parsed, text } = await collect([system, ...history, ...(pre ?? []), { role: "user", content: utterance }]);
      let ok = false;
      if (expect.kind === "call") {
        shouldCallTotal += 1;
        ok = parsed.some(call => call.name === expect.name
          && (expect.args === undefined || Bun.deepEquals(call.args, expect.args))
          && (!expect.rateBelowOne || (typeof call.args?.rate === "number" && call.args.rate < 1))
          && (expect.hasArgs === undefined || expect.hasArgs.every(key =>
            typeof call.args?.[key] === "string" ? (call.args[key] as string).length > 0 : call.args?.[key] !== undefined)));
        shouldCall += ok ? 1 : 0;
      } else if (expect.kind === "no_call") {
        noCallTotal += 1;
        ok = parsed.length === 0;
        falseTriggers += ok ? 0 : 1;
      } else {
        edgeTotal += 1;
        ok = expect.kind === "no_invented_tool"
          ? parsed.every(call => known.has(call.name))
          : (parsed.length === 0 && text.length > 0) || (parsed.length > 0 && parsed.every(call => known.has(call.name) && call.args !== undefined));
        edgeOk += ok ? 1 : 0;
      }
      const summary = parsed.length > 0 ? JSON.stringify(parsed) : text.slice(0, 40);
      console.error(`${ok ? "✓" : "✗"} [${label}] ${utterance} -> ${summary}`);
      if (!ok) failures.push(`${label}: ${utterance}`);
    }
    console.error(`[${label}] explicit ${shouldCall}/${shouldCallTotal}  false-triggers ${falseTriggers}/${noCallTotal}  edge ${edgeOk}/${edgeTotal}\n`);
    return shouldCall === shouldCallTotal && falseTriggers === 0 && edgeOk === edgeTotal;
  };

  /** The loop's execute-and-refeed rounds with canned successes, so compound commands
   * can finish the way they do in production. */
  const runMultiAction = async (): Promise<boolean> => {
    let allOk = true;
    for (const { utterance, expects } of MULTI_ACTION) {
      const messages: ChatMessage[] = [system, ...HISTORY, { role: "user", content: utterance }];
      const seen: { name: string; args: Record<string, unknown> | undefined }[] = [];
      for (let round = 0; round < MAX_ROUNDS; round += 1) {
        const { parsed, raw } = await collect(messages);
        if (parsed.length === 0) break;
        seen.push(...parsed);
        messages.push({ role: "assistant", content: "", tool_calls: raw });
        for (const call of raw) {
          messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ ok: true }) });
        }
      }
      const ok = expects.every(expected => seen.some(call => call.name === expected.name
        && (expected.args === undefined || Bun.deepEquals(call.args, expected.args))));
      console.error(`${ok ? "✓" : "✗"} [multi-action] ${utterance} -> ${JSON.stringify(seen)}`);
      if (!ok) { failures.push(`multi-action: ${utterance}`); allOk = false; }
    }
    console.error("");
    return allOk;
  };

  const single = await runSuite("single-turn", []);
  const multi = await runSuite("turn-9", HISTORY);
  const compound = await runMultiAction();

  console.error(`bad-json ${badJson}  invented ${invented}`);
  const pass = single && multi && compound && badJson === 0 && invented === 0;
  const label = studio ? "TOOL GATE (studio capacity)" : "TOOL GATE";
  console.error(pass ? `${label}: PASS` : `${label}: FAIL (${failures.join("; ")})`);
  return pass ? 0 : 1;
}

process.exitCode = await main();
