import { afterEach, describe, expect, test } from "bun:test";
import { createAgent, deleteAgent, deleteAgentConversation, getAgentConversation, getDeploymentInfo, listAgentConversations, listAgents, publishAgent, transcribe, updateAgent } from "./api";

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

describe("Agent API", () => {
  test("reads the public deployment mode and immutable demo pin", async () => {
    stubFetch(input => {
      expect(String(input)).toBe("/healthz");
      return Response.json({
        auth: "self",
        deployment: { demo: true, tokenRequired: true, demoAgent: { id: "support", version: 3 }, maxSessions: 4, maxSessionSeconds: 600 },
      });
    });
    await expect(getDeploymentInfo()).resolves.toEqual({
      auth: "self",
      demo: true,
      tokenRequired: true,
      demoAgent: { id: "support", version: 3 },
      maxSessions: 4,
      maxSessionSeconds: 600,
    });
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
      conversations: [], total: 0, policy: { enabled: false, content: false, audio: false },
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
