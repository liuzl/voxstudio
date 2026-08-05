import { describe, expect, test } from "bun:test";
import {
  agentBehaviorChanged,
  agentDeploymentSnippets,
  agentDemoPinState,
  agentExportYaml,
  agentPreviewOptions,
  agentRecordFromDraft,
  displayTime,
  draftFrom,
  listFromText,
  previewStatusLabel,
  pronunciationsFromText,
  specFrom,
  validateAgentDraftShape,
  validateAgentDraftDependencies,
  voiceFromOption,
  voiceOptionValue,
} from "./AgentsPanel";

describe("Agent Builder voice selection", () => {
  test("round-trips the engine together with a duplicate-capable voice id", () => {
    const selected = voiceOptionValue({ id: "default", engine: "voxcpm" });
    expect(selected).not.toBe(voiceOptionValue({ id: "default", engine: "openai" }));
    expect(voiceFromOption(selected)).toEqual({ voice: "default", ttsEngine: "voxcpm" });
  });

  test("clears both fields when no TTS route is pinned", () => {
    expect(voiceFromOption("")).toEqual({ voice: "", ttsEngine: "" });
  });

  test("keeps an independently pinned TTS route when the voice returns to automatic", () => {
    expect(voiceFromOption("", "kokoro")).toEqual({ voice: "", ttsEngine: "kokoro" });
  });
});

describe("Agent list timestamps", () => {
  test("follow the selected UI locale instead of the browser default", () => {
    const timestamp = "2026-08-02T01:05:00.000Z";
    expect(displayTime(timestamp, "en")).not.toContain("月");
    expect(displayTime(timestamp, "zh")).toContain("月");
  });
});

describe("Agent deployment snippets", () => {
  test("binds every supported client example to the published Agent id and public origin", () => {
    const snippets = agentDeploymentSnippets("support.zh", "https://voice.example/");
    expect(snippets.cli).toContain("gateway host");
    expect(snippets.cli).toContain("vox listen --agent support.zh");
    expect(snippets.native).toContain('new WebSocket("wss://voice.example/v1/realtime")');
    expect(snippets.native).toContain('agent: "support.zh"');
    expect(snippets.openai).toContain('baseURL: "https://voice.example/v1"');
    expect(snippets.openai).toContain('url.searchParams.set("agent", "support.zh")');
    expect(snippets.python).toContain("wss://voice.example/v1/realtime?model=voxstudio-realtime&agent=support.zh");

    const protectedSnippets = agentDeploymentSnippets("support.zh", "https://voice.example", { tokenRequired: true });
    expect(protectedSnippets.native).toContain('url.searchParams.set("token", "YOUR_GATEWAY_TOKEN")');
    expect(protectedSnippets.openai).toContain('process.env.VOX_API_KEY ?? "YOUR_API_KEY"');
    const accountSnippets = agentDeploymentSnippets("support.zh", "https://voice.example", { accountMode: true });
    expect(accountSnippets.cli).toBeNull();
    expect(accountSnippets.native).toContain('import WebSocket from "ws"');
    expect(accountSnippets.native).toContain('Authorization: `Bearer ${process.env.VOX_API_KEY ?? "YOUR_API_KEY"}`');
    expect(accountSnippets.openai).toContain('process.env.VOX_API_KEY ?? "YOUR_API_KEY"');
  });

  test("distinguishes demo mode without an Agent pin from demo mode being off", () => {
    expect(agentDemoPinState(undefined, "support", 1)).toBe("loading");
    expect(agentDemoPinState({ auth: "self", demo: false, tokenRequired: false, livekit: false }, "support", 1)).toBe("off");
    expect(agentDemoPinState({ auth: "self", demo: true, tokenRequired: false, livekit: false }, "support", 1)).toBe("unpinned");
    expect(agentDemoPinState({
      auth: "self", demo: true, tokenRequired: false, livekit: false, demoAgent: { id: "support", version: 1 },
    }, "support", 1)).toBe("current");
  });
});

describe("Agent preview connection status", () => {
  test("connection loss takes precedence over a stale session state", () => {
    expect(previewStatusLabel("reconnecting", "speaking")).toBe("重连中");
    expect(previewStatusLabel("connecting", "listening")).toBe("连接中");
  });

  test("uses the live session state only after the socket is connected", () => {
    expect(previewStatusLabel("connected", "speaking")).toBe("回答中");
    expect(previewStatusLabel("connected", "listening")).toBe("聆听中");
  });

  test("pins either the draft revision or an exact immutable version", () => {
    const record = {
      id: "support",
      name: "Support",
      spec: {},
      revision: 7,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    };
    expect(agentPreviewOptions(record, { type: "draft" })).toEqual({
      agent: "support",
      agentSource: "draft",
      agentRevision: 7,
    });
    expect(agentPreviewOptions(record, { type: "published", version: 3 })).toEqual({
      agent: "support",
      agentSource: "published",
      agentVersion: 3,
    });
  });
});

describe("Agent Builder advanced configuration", () => {
  const record = {
    id: "support",
    name: "Support",
    spec: {},
    revision: 1,
    createdAt: "2026-08-02T00:00:00.000Z",
    updatedAt: "2026-08-02T00:00:00.000Z",
  };

  test("parses pronunciation and keyterm editors deterministically", () => {
    expect(pronunciationsFromText("VoxStudio = 沃克斯\nAgent＝智能体")).toEqual({
      pronunciations: { VoxStudio: "沃克斯", Agent: "智能体" },
    });
    expect(listFromText("VoxStudio\nAgent\nVoxStudio\n")).toEqual(["VoxStudio", "Agent"]);
  });

  test("rejects malformed pronunciation rows instead of silently dropping them", () => {
    const draft = { ...draftFrom(record), pronunciationsText: "missing separator" };
    expect(validateAgentDraftShape(draft)).toContainEqual({
      key: "发音词典第 {line} 行应使用“词语 = 读音”格式",
      params: { line: 1 },
    });
  });

  test("serializes engine, MCP, speech, and turn controls into AgentSpec", () => {
    const draft = {
      ...draftFrom(record),
      asrEngine: "sensevoice",
      llmEngine: "gemma",
      ttsEngine: "kokoro",
      mcpServers: ["memo"],
      pronunciationsText: "VoxStudio = 沃克斯",
      keytermsText: "VoxStudio\nAgent Builder",
      turnTaking: "speculative" as const,
      vad: "silero" as const,
      reopenMs: "180",
      silenceMs: "420",
      minSpeechMs: "96",
      threshold: "0.01",
    };
    expect(specFrom(draft, {})).toMatchObject({
      asrEngine: "sensevoice",
      llmEngine: "gemma",
      ttsEngine: "kokoro",
      mcpServers: ["memo"],
      pronunciations: { VoxStudio: "沃克斯" },
      keyterms: ["VoxStudio", "Agent Builder"],
      turnTaking: "speculative",
      vad: "silero",
      reopenMs: 180,
      silenceMs: 420,
      minSpeechMs: 96,
      threshold: 0.01,
    });
  });

  test("does not treat metadata-only edits as behavior drift", () => {
    const current = { ...draftFrom(record), name: "Renamed", description: "New description" };
    expect(agentBehaviorChanged(current, record.spec)).toBe(false);
    expect(agentBehaviorChanged({ ...current, instructions: "Changed behavior" }, record.spec)).toBe(true);
  });

  test("materializes unsaved editor values without changing the persisted record", () => {
    const draft = {
      ...draftFrom(record),
      name: "  Renamed support  ",
      description: "  Current unsaved description  ",
      instructions: "Current unsaved behavior",
    };
    const snapshot = agentRecordFromDraft(record, draft);
    expect(snapshot).toMatchObject({
      name: "Renamed support",
      description: "Current unsaved description",
      revision: 1,
      spec: { instructions: "Current unsaved behavior" },
    });
    expect(record).toEqual({
      id: "support",
      name: "Support",
      spec: {},
      revision: 1,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:00:00.000Z",
    });
  });

  test("validates the effective default routes and the voice on the effective TTS engine", () => {
    const draft = { ...draftFrom(record), voice: "calm" };
    const engines = [
      { name: "sensevoice", kind: "asr", model: "sv", capabilities: [], roles: ["asr"], healthy: true, runtime: null },
      { name: "gemma", kind: "llm", model: "gemma", capabilities: [], roles: ["llm"], healthy: false, runtime: null },
      { name: "kokoro", kind: "tts", model: "kokoro", capabilities: [], roles: ["tts"], healthy: true, runtime: null },
      { name: "voxcpm", kind: "tts", model: "voxcpm", capabilities: [], roles: [], healthy: true, runtime: null },
    ];
    expect(validateAgentDraftDependencies(
      draft,
      engines,
      [{ id: "calm", engine: "voxcpm" }],
      [],
      true,
      true,
    )).toEqual([
      { key: "{kind} 引擎“{name}”当前离线", params: { kind: "LLM", name: "gemma" } },
      { key: "音色“{voice}”在所选引擎中不可用", params: { voice: "calm" } },
    ]);
  });

  test("exports a complete portable YAML draft without losing Unicode or nested specs", () => {
    const source = {
      ...record,
      name: "客服：主助手",
      description: "Handles \"priority\" cases",
      published: {
        version: 2,
        hash: "a".repeat(64),
        publishedAt: "2026-08-02T01:00:00.000Z",
      },
      spec: {
        instructions: "先确认问题，再回答。",
        pronunciations: { VoxStudio: "沃克斯", "A:B": "诶比" },
        keyterms: ["VoxStudio", "Agent Builder"],
        studioTools: true,
      },
    };
    const exported = agentExportYaml(source);
    expect(exported.startsWith("# VoxStudio Agent draft\n")).toBe(true);
    const parsed = Bun.YAML.parse(exported) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      id: "support",
      name: "客服：主助手",
      description: "Handles \"priority\" cases",
      spec: {
        pronunciations: { VoxStudio: "沃克斯", "A:B": "诶比" },
        keyterms: ["VoxStudio", "Agent Builder"],
        studioTools: true,
      },
    });
    expect(parsed.published).toBeUndefined();
    expect(source.published.version).toBe(2);
  });
});
