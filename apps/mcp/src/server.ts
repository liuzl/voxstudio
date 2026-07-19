import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AsrClient, TtsClient, type Fetch } from "@voxstudio/clients";
import { engine } from "@voxstudio/config";
import type { VoxConfig } from "@voxstudio/contracts";
import { streamLong } from "@voxstudio/orchestration";
import type { PcmSink } from "@voxstudio/platform-bun";
import { sanitizeForTts } from "@voxstudio/text";
import { basename } from "node:path";
import { z } from "zod";

/**
 * Agent voice (docs/agent-voice-mcp.md): voxstudio's voice I/O exposed to MCP clients.
 * Three tools over the engine contract — speak through the host speakers, transcribe a
 * local file, list the voice bank. The factory takes seams (fetch, sink) so unit tests
 * drive the real protocol with fake engines and a capturing sink.
 */

export interface AgentVoiceOptions {
  fetch?: Fetch;
  /** One sink per utterance; defaults to the ffplay sink in main.ts. */
  createSink: () => PcmSink;
  /** Operational logging. Never the spoken text. */
  log?: (line: string) => void;
}

function ok(payload: Record<string, unknown>): { content: { type: "text"; text: string }[] } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }] };
}

function refuse(message: string): { content: { type: "text"; text: string }[]; isError: true } {
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createAgentVoiceServer(config: VoxConfig, options: AgentVoiceOptions): McpServer {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const log = options.log ?? (() => {});
  const server = new McpServer({ name: "voxstudio-agent-voice", version: "1.0.0" });
  // One utterance owns the speakers at a time: concurrent speaks queue in arrival order.
  let speaking: Promise<void> = Promise.resolve();

  server.registerTool("speak", {
    description: "通过本机扬声器朗读一段文字（自托管 TTS）。适合把任务完成、需要确认等通知念出来。",
    inputSchema: {
      text: z.string().describe("要朗读的文字"),
      voice: z.string().optional().describe("音色 ID，缺省用配置默认；可先用 list_voices 查看"),
    },
  }, async ({ text, voice }) => {
    const sanitized = sanitizeForTts(text).text;
    if (!sanitized.trim()) return refuse("没有可朗读的文字");
    const requested = voice ?? config.ttsDefaults.voice;
    const turn = speaking.then(async () => {
      const tts = new TtsClient(engine(config, "tts"), fetchImpl);
      const sink = options.createSink();
      const started = performance.now();
      let firstAudioMs: number | null = null;
      let durationS = 0;
      try {
        for await (const piece of streamLong(tts, sanitized, {
          chunking: config.chunking,
          ttsDefaults: config.ttsDefaults,
          voice: requested,
          ...(requested === "clone" || requested === "design" ? {} : { prosodyPrompt: true }),
          continuationId: crypto.randomUUID(),
        })) {
          firstAudioMs ??= Math.round(performance.now() - started);
          durationS += piece.samples.length / piece.sampleRate;
          await sink.write(piece);
        }
      } finally {
        await sink.close();
      }
      return { firstAudioMs, durationS };
    });
    // The queue survives a failed utterance; the failure belongs to this call alone.
    speaking = turn.then(() => {}, () => {});
    try {
      const { firstAudioMs, durationS } = await turn;
      log(`speak: ${durationS.toFixed(1)}s as ${requested}`);
      return ok({
        ok: true,
        voice: requested,
        duration_s: Number(durationS.toFixed(2)),
        first_audio_ms: firstAudioMs ?? 0,
      });
    } catch (error) {
      return refuse(`朗读失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  server.registerTool("transcribe", {
    description: "把本机的一个音频文件转写成文字（自托管 ASR）。",
    inputSchema: {
      path: z.string().describe("音频文件的本地路径（wav 等）"),
      language: z.string().optional().describe("识别语言提示，如 zh、en；缺省自动"),
    },
    annotations: { readOnlyHint: true },
  }, async ({ path, language }) => {
    const file = Bun.file(path);
    if (!await file.exists()) return refuse(`文件不存在：${path}`);
    try {
      const asr = new AsrClient(engine(config, "asr"), fetchImpl);
      const result = await asr.transcribe(
        new File([await file.arrayBuffer()], basename(path)),
        basename(path),
        language ?? "auto",
      );
      log(`transcribe: ${basename(path)} -> ${result.text.length} chars`);
      return ok({ text: result.text, ...(result.lang === null ? {} : { lang: result.lang }) });
    } catch (error) {
      return refuse(`转写失败：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  server.registerTool("list_voices", {
    description: "列出可用的 TTS 音色。",
    annotations: { readOnlyHint: true },
  }, async () => {
    try {
      const tts = new TtsClient(engine(config, "tts"), fetchImpl);
      const bank = await tts.listVoices();
      return ok({ voices: bank.map(entry => entry.id), default: config.ttsDefaults.voice });
    } catch (error) {
      return refuse(`音色列表不可用：${error instanceof Error ? error.message : String(error)}`);
    }
  });

  return server;
}
