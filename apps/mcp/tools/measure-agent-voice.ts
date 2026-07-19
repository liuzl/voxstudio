#!/usr/bin/env bun
/**
 * The agent-voice gate (docs/agent-voice-mcp.md §Phases): the official MCP SDK client
 * spawns the real vox-mcp binary over stdio with zero server-side accommodations,
 * against live engines. Short and audible by design — the speak case plays a real
 * notification through the local speakers.
 *
 *   bun run measure:agent-voice [--config CONFIG]
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readWav, writeWav } from "@voxstudio/audio";
import { TtsClient } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import { loadConfig } from "@voxstudio/platform-bun";

function payload(result: unknown): Record<string, unknown> {
  const content = (result as { content?: { type: string; text: string }[] }).content ?? [];
  try {
    return JSON.parse(content[0]?.text ?? "{}") as Record<string, unknown>;
  } catch {
    return { raw: content[0]?.text };
  }
}

async function main(): Promise<number> {
  const explicitIndex = process.argv.indexOf("--config");
  const configArgs = explicitIndex >= 0 ? ["--config", process.argv[explicitIndex + 1] as string] : [];
  const config = explicitIndex >= 0
    ? await loadConfig({ explicit: process.argv[explicitIndex + 1] as string })
    : await loadConfig();

  const failures: string[] = [];
  const check = (ok: boolean, what: string, detail: string): void => {
    console.error(`${ok ? "✓" : "✗"} ${what} -> ${detail}`);
    if (!ok) failures.push(what);
  };

  // The concrete client: nothing but the SDK and the command line any MCP host would use.
  const client = new Client({ name: "measure-agent-voice", version: "1.0.0" });
  await client.connect(new StdioClientTransport({
    command: "bun",
    args: ["apps/mcp/src/main.ts", ...configArgs],
    stderr: "inherit",
  }));

  try {
    const { tools } = await client.listTools();
    check(tools.length === 3, "three tools listed", tools.map(tool => tool.name).sort().join(", "));

    const voices = payload(await client.callTool({ name: "list_voices", arguments: {} }));
    const bank = Array.isArray(voices.voices) ? voices.voices as string[] : [];
    check(bank.length > 0, "voice bank non-empty", `${bank.length} voices, default ${String(voices.default)}`);

    const spoken = payload(await client.callTool({
      name: "speak",
      arguments: { text: "voxstudio 语音通知测试：门禁正在运行。" },
    }));
    check(spoken.ok === true && typeof spoken.duration_s === "number" && spoken.duration_s > 0.5,
      "speak plays audibly and reports duration",
      `${String(spoken.duration_s)}s as ${String(spoken.voice)}, first audio ${String(spoken.first_audio_ms)}ms`);

    // The transcribe round trip crosses both live engines: TTS writes the fixture, ASR reads it.
    const tts = new TtsClient(engine(config, "tts"));
    const phraseWav = readWav(await tts.speech({
      input: "今天的天气很不错。",
      voice: config.ttsDefaults.voice,
      response_format: "wav",
      cfg_value: config.ttsDefaults.cfgValue,
      timesteps: config.ttsDefaults.timesteps,
    }));
    const path = `${process.env.TMPDIR ?? "/tmp"}/agent-voice-gate.wav`;
    await Bun.write(path, writeWav(phraseWav.samples, phraseWav.sampleRate));
    const heard = payload(await client.callTool({ name: "transcribe", arguments: { path, language: "zh" } }));
    check(typeof heard.text === "string" && heard.text.includes("天气"),
      "transcribe round-trips a synthesized phrase", `"${String(heard.text)}"`);
  } finally {
    await client.close();
  }

  const pass = failures.length === 0;
  console.error(pass ? "AGENT VOICE GATE: PASS" : `AGENT VOICE GATE: FAIL (${failures.join("; ")})`);
  return pass ? 0 : 1;
}

process.exitCode = await main();
