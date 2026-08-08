import { afterEach, describe, expect, test } from "bun:test";
import { createAgent, deleteAgent, deleteAgentConversation, getAgentConversation, getDeploymentInfo, issueLiveKitBootstrap, listAgentConversations, listAgents, publishAgent, registerVoice, transcribe, updateAgent } from "./api";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

function stubFetch(handler: (input: unknown, init?: RequestInit) => Response | Promise<Response>): void {
  globalThis.fetch = handler as typeof fetch;
}

describe("api transcribe", () => {
  test("sends the draft request without a revise field", async () => {
    let form: FormData | undefined;
    stubFetch((input, init) => {
      expect(String(input)).toBe("/v1/audio/transcriptions");
      form = init?.body as FormData;
      return Response.json({ text: " 你好 " });
    });
    await expect(transcribe(new File(["wav"], "a.wav"))).resolves.toBe("你好");
    expect(form?.get("language")).toBe("auto");
    expect(form?.get("revise")).toBeNull();
  });

  test("revise=true forwards the accuracy-tier field", async () => {
    let form: FormData | undefined;
    stubFetch((_input, init) => {
      form = init?.body as FormData;
      return Response.json({ text: "机器学习中的过拟合", engine: "revise" });
    });
    await expect(transcribe(new File(["wav"], "a.wav"), "zh", true))
      .resolves.toBe("机器学习中的过拟合");
    expect(form?.get("language")).toBe("zh");
    expect(form?.get("revise")).toBe("true");
  });
});

describe("voice registration API", () => {
  test("uploads one reference with repeated explicit engine targets and keeps partial results", async () => {
    let form: FormData | undefined;
    stubFetch((_input, init) => {
      form = init?.body as FormData;
      return Response.json({
        id: "shuber",
        registered: ["tts"],
        failed: ["sz_ws_tts"],
        results: [
          { engine: "tts", ok: true, status: 201 },
          { engine: "sz_ws_tts", ok: false, status: 503, error: { code: "registry_busy", message: "try again" } },
        ],
      }, { status: 207 });
    });

    const result = await registerVoice(
      "shuber",
      "今天天气不太好，又下雨了。",
      new File(["wav"], "reference.wav", { type: "audio/wav" }),
      ["tts", "sz_ws_tts"],
    );
    expect(form?.getAll("engine")).toEqual(["tts", "sz_ws_tts"]);
    expect((form?.get("audio") as File).name).toBe("reference.wav");
    expect(result.registered).toEqual(["tts"]);
    expect(result.failed).toEqual(["sz_ws_tts"]);
  });

  test("returns structured all-failed results even when the HTTP response is not ok", async () => {
    stubFetch(() => Response.json({
      id: "shuber",
      registered: [],
      failed: ["tts"],
      results: [{ engine: "tts", ok: false, status: 502, error: { code: "engine_unreachable", message: "offline" } }],
    }, { status: 502 }));

    await expect(registerVoice("shuber", "text", new File(["wav"], "reference.wav"), ["tts"]))
      .resolves.toMatchObject({ registered: [], failed: ["tts"] });
  });
});

describe("Agent API", () => {
  test("reads the public deployment mode and immutable demo pin", async () => {
    stubFetch(input => {
      expect(String(input)).toBe("/healthz");
      return Response.json({
        auth: "self",
        deployment: { demo: true, tokenRequired: true, livekit: true, demoAgent: { id: "support", version: 3 }, maxSessions: 4, maxSessionSeconds: 600 },
      });
    });
    await expect(getDeploymentInfo()).resolves.toEqual({
      auth: "self",
      demo: true,
      tokenRequired: true,
      livekit: true,
      demoAgent: { id: "support", version: 3 },
      maxSessions: 4,
      maxSessionSeconds: 600,
    });
  });

  test("requests a room-scoped LiveKit grant with only the Agent selection", async () => {
    let request: { path: string; method: string; body: unknown } | undefined;
    stubFetch((input, init) => {
      request = {
        path: String(input),
        method: init?.method ?? "GET",
        body: JSON.parse(String(init?.body)),
      };
      return Response.json({
        server_url: "wss://media.example",
        participant_token: "jwt",
        room_name: "vox-room",
        participant_identity: "web-user",
        expires_at: "2026-08-05T00:05:00.000Z",
        agent: { agentId: "support", source: "draft", revision: 7 },
      });
    });
    await expect(issueLiveKitBootstrap({
      agent: "support",
      agentSource: "draft",
      agentRevision: 7,
      agentMode: true,
    })).resolves.toMatchObject({ room_name: "vox-room" });
    expect(request).toEqual({
      path: "/v1/realtime/livekit/token",
      method: "POST",
      body: { agent: "support", agentSource: "draft", agentRevision: 7, agentMode: true },
    });
  });

  test("requests a room-scoped LiveKit grant for an ordinary Studio conversation", async () => {
    let body: unknown;
    stubFetch((_input, init) => {
      body = JSON.parse(String(init?.body));
      return Response.json({
        server_url: "wss://media.example",
        participant_token: "jwt",
        room_name: "vox-room",
        participant_identity: "web-user",
        expires_at: "2026-08-05T00:05:00.000Z",
      });
    });
    const result = await issueLiveKitBootstrap({
      language: "auto",
      voice: "shuber",
      ttsEngine: "tts",
      turnTaking: "speculative",
    });
    expect(result.agent).toBeUndefined();
    expect(body).toEqual({ language: "auto", voice: "shuber", ttsEngine: "tts", turnTaking: "speculative" });
  });

  test("carries revisions through create, update, publish, and delete", async () => {
    const calls: Array<{ path: string; method: string; body?: unknown }> = [];
    stubFetch((input, init) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;
      calls.push({ path, method, ...(body === undefined ? {} : { body }) });
      if (method === "POST" && path.endsWith("/publish")) {
        return Response.json({
          record: { id: "support", name: "Support", revision: 3, createdAt: "now", updatedAt: "now", spec: {}, published: { version: 1, hash: "a".repeat(64), publishedAt: "now" } },
          version: { id: "support", version: 1, hash: "a".repeat(64), publishedAt: "now", spec: {} },
        });
      }
      if (method === "DELETE") return Response.json({ deleted: true });
      return Response.json({ id: "support", name: "Support", revision: method === "PATCH" ? 2 : 1, createdAt: "now", updatedAt: "now", spec: {} });
    });

    const created = await createAgent({ id: "support", name: "Support" });
    const updated = await updateAgent("support", created.revision, { name: "Support v2", spec: { voice: "calm" } });
    const published = await publishAgent("support", updated.revision);
    await deleteAgent("support", published.record.revision);

    expect(calls).toEqual([
      { path: "/v1/agents", method: "POST", body: { id: "support", name: "Support" } },
      { path: "/v1/agents/support", method: "PATCH", body: { revision: 1, name: "Support v2", spec: { voice: "calm" } } },
      { path: "/v1/agents/support/publish", method: "POST", body: { revision: 2 } },
      { path: "/v1/agents/support", method: "DELETE", body: { revision: 3 } },
    ]);
  });

  test("lists the owner-visible records", async () => {
    stubFetch(() => Response.json({ agents: [{ id: "a", name: "A", revision: 1, createdAt: "now", updatedAt: "now", spec: {} }] }));
    await expect(listAgents()).resolves.toMatchObject([{ id: "a", name: "A", revision: 1 }]);
  });

  test("exposes trace-disabled as an explicit retention policy and encodes conversation ids", async () => {
    const calls: Array<{ path: string; method: string }> = [];
    stubFetch((input, init) => {
      const path = String(input);
      calls.push({ path, method: init?.method ?? "GET" });
      if (path.includes("/conversations?")) {
        return Response.json({ error: { code: "traces_disabled", message: "off" } }, { status: 404 });
      }
      if ((init?.method ?? "GET") === "DELETE") return Response.json({ deleted: true });
      return Response.json({ conversation: { id: "session/1", events: [] }, policy: { enabled: true, content: false, audio: false } });
    });

    await expect(listAgentConversations("support", { outcome: "error", query: "session/1", limit: 25 })).resolves.toEqual({
      conversations: [], total: 0, policy: {
        enabled: false, content: false, audio: false,
        inputAudio: false, outputAudio: false, maxBytes: null,
      },
    });
    await getAgentConversation("support", "session/1");
    await deleteAgentConversation("support", "session/1");
    expect(calls).toEqual([
      { path: "/v1/agents/support/conversations?outcome=error&id=session%2F1&limit=25", method: "GET" },
      { path: "/v1/agents/support/conversations/session%2F1", method: "GET" },
      { path: "/v1/agents/support/conversations/session%2F1", method: "DELETE" },
    ]);
  });
});
