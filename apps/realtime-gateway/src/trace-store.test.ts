import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { writeWav } from "@voxstudio/audio";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayEvent } from "./protocol";
import { ConversationTraceStore, traceEventForRetention } from "./trace-store";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "vox-traces-"));
  roots.push(dir);
  return dir;
}

function event(sessionId: string, sequence: number, payload: Record<string, unknown>): GatewayEvent {
  return {
    v: 1,
    sessionId,
    sequence,
    timestampMs: 1_000 + sequence,
    ...payload,
  } as GatewayEvent;
}

describe("ConversationTraceStore", () => {
  test("migrates a pre-deletion-marker trace database in place", async () => {
    const dir = await root();
    const legacy = new Database(join(dir, "traces.db"), { create: true });
    legacy.run(`CREATE TABLE conversations (
      id TEXT PRIMARY KEY, owner_user_id TEXT NOT NULL, agent_id TEXT NOT NULL,
      agent_source TEXT NOT NULL, agent_revision INTEGER, agent_version INTEGER,
      agent_hash TEXT, started_at INTEGER NOT NULL, ended_at INTEGER, outcome TEXT NOT NULL,
      error_code TEXT, turn_count INTEGER NOT NULL DEFAULT 0,
      content_retained INTEGER NOT NULL DEFAULT 0
    )`);
    legacy.run("PRAGMA user_version = 1");
    legacy.close();

    const store = new ConversationTraceStore(dir);
    store.begin("owner", "session", { agentId: "support", source: "draft", revision: 1 }, 0);
    store.finish("owner", "session", 1);
    expect(await store.remove("owner", "support", "session")).toBe("deleted");
    await store.close();

    const migrated = new Database(join(dir, "traces.db"));
    expect(migrated.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version).toBe(2);
    expect(migrated.query<{ name: string }, []>("PRAGMA table_info(conversations)").all().map(row => row.name)).toContain("deleting");
    migrated.close();
  });

  test("commits a burst of observer writes as one batch", async () => {
    const store = new ConversationTraceStore(await root());
    store.batch(() => {
      store.begin("owner", "batched", { agentId: "support", source: "draft", revision: 1 }, 10);
      for (let sequence = 1; sequence <= 20; sequence += 1) {
        store.append("owner", event("batched", sequence, {
          type: "media.socket",
          frameId: sequence,
          submittedAtMs: sequence,
          highWaterBytes: 0,
          queuedBytes: 0,
          queuedAudioMs: 0,
          backpressured: false,
          dropped: false,
        }));
      }
      store.finish("owner", "batched", 20);
    });

    expect(store.get("owner", "support", "batched")?.events).toHaveLength(20);
    store.close();
  });

  test("keeps metadata by default while removing conversational content", async () => {
    const store = new ConversationTraceStore(await root(), { now: () => 2_000 });
    store.begin("alice", "session-1", {
      agentId: "support",
      source: "published",
      version: 3,
      hash: "a".repeat(64),
    }, 1_000);
    store.append("alice", event("session-1", 1, {
      type: "transcript.final", turnId: "turn-1", revision: 0, text: "private question",
    }));
    store.append("alice", event("session-1", 2, {
      type: "tool.call", turnId: "turn-1", name: "lookup", arguments: { secret: "value" },
    }));
    store.append("alice", event("session-1", 3, { type: "turn.completed", turnId: "turn-1", revision: 0 }));
    store.finish("alice", "session-1", 2_000);

    expect(store.list("alice", "support").conversations).toEqual([
      expect.objectContaining({
        id: "session-1",
        agentVersion: 3,
        outcome: "completed",
        durationMs: 1_000,
        turnCount: 1,
        contentRetained: false,
      }),
    ]);
    expect(store.list("bob", "support").conversations).toHaveLength(0);
    const detail = store.get("alice", "support", "session-1");
    expect(detail?.events).toHaveLength(3);
    expect(detail?.events[0]).not.toHaveProperty("text");
    expect(detail?.events[1]).toMatchObject({ type: "tool.call", name: "lookup" });
    expect(detail?.events[1]).not.toHaveProperty("arguments");
    expect(store.get("bob", "support", "session-1")).toBeUndefined();
    expect(await store.remove("bob", "support", "session-1")).toBe("not_found");
    expect(await store.remove("alice", "support", "session-1")).toBe("deleted");
    await store.close();
  });

  test("retains content only under the independent content policy", async () => {
    const dir = await root();
    const store = new ConversationTraceStore(dir, { retainContent: true });
    try {
      store.begin("owner", "session-2", { agentId: "draft", source: "draft", revision: 7 }, 10);
      store.append("owner", event("session-2", 1, {
        type: "response.text.final", turnId: "turn-1", revision: 0, text: "retained reply",
      }));
      store.finish("owner", "session-2", 20);
      expect(store.get("owner", "draft", "session-2")?.events[0]).toMatchObject({ text: "retained reply" });
      expect(store.policy).toMatchObject({ enabled: true, content: true, audio: false });
      if (process.platform !== "win32") {
        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        expect((await stat(join(dir, "traces.db"))).mode & 0o777).toBe(0o600);
      }
    } finally {
      store.close();
    }
  });

  test("attaches typed audio to a turn and cascades bytes on conversation deletion", async () => {
    const store = new ConversationTraceStore(await root(), {
      retainInputAudio: true,
      retainOutputAudio: true,
      maxBytes: 1_000_000,
    });
    store.begin("owner", "media-session", { agentId: "support", source: "draft", revision: 1 }, 10);
    store.retainInput("owner", {
      sessionId: "media-session", turnId: "turn-1", revision: 0,
      wav: writeWav(new Float32Array(1_600).fill(0.1), 16_000),
      sampleRate: 16_000, channels: 1,
    });
    const output = store.createOutputRecorder("owner", "media-session", "turn-1", 0)!;
    output.write(new Float32Array(800).fill(0.2), 16_000);
    output.finalize("interrupted");
    await store.flushMedia();

    expect(store.policy).toMatchObject({
      audio: true, inputAudio: true, outputAudio: true, maxBytes: 1_000_000,
    });
    const detail = store.get("owner", "support", "media-session")!;
    expect(detail.media).toHaveLength(2);
    expect(detail.media).toEqual(expect.arrayContaining([
      expect.objectContaining({ direction: "input", turnId: "turn-1", revision: 0, state: "ready" }),
      expect.objectContaining({ direction: "output", delivery: "interrupted", state: "ready" }),
    ]));
    const retained = store.mediaFile("owner", "support", "media-session", detail.media[0]!.id);
    expect(retained).toBeDefined();
    expect(store.mediaFile("another-owner", "support", "media-session", detail.media[0]!.id)).toBeUndefined();

    expect(await store.remove("owner", "support", "media-session")).toBe("active");
    store.finish("owner", "media-session", 20);
    expect(await store.remove("owner", "support", "media-session")).toBe("deleted");
    await expect(stat(retained!.path)).rejects.toThrow();
    await store.close();
  });

  test("enforces age retention before a stale record can be read", async () => {
    let now = 0;
    const store = new ConversationTraceStore(await root(), { retentionDays: 1, now: () => now });
    store.begin("owner", "expired", { agentId: "support", source: "draft", revision: 1 }, 0);
    store.finish("owner", "expired", 1);
    now = 2 * 86_400_000;
    expect(store.list("owner", "support").conversations).toHaveLength(0);
    expect(store.get("owner", "support", "expired")).toBeUndefined();
    store.close();
  });

  test("enforces a lowered media byte ceiling on startup by pruning completed conversations", async () => {
    const dir = await root();
    let store = new ConversationTraceStore(dir, { retainInputAudio: true });
    store.begin("owner", "large", { agentId: "support", source: "draft", revision: 1 }, 0);
    store.retainInput("owner", {
      sessionId: "large", turnId: "turn", revision: 0,
      wav: writeWav(new Float32Array(1_600), 16_000), sampleRate: 16_000, channels: 1,
    });
    store.finish("owner", "large", 1);
    await store.close();

    store = new ConversationTraceStore(dir, { retainInputAudio: true, maxBytes: 100 });
    expect(store.list("owner", "support").conversations).toHaveLength(0);
    await store.flushMedia();
    await store.close();
  });

  test("evicts the oldest completed conversation to retain new media at the runtime byte ceiling", async () => {
    const store = new ConversationTraceStore(await root(), { retainInputAudio: true, maxBytes: 300 });
    const wav = writeWav(new Float32Array(100), 16_000);
    store.begin("owner", "old", { agentId: "support", source: "draft", revision: 1 }, 0);
    store.retainInput("owner", {
      sessionId: "old", turnId: "turn-old", revision: 0, wav, sampleRate: 16_000, channels: 1,
    });
    await store.flushMedia();
    store.finish("owner", "old", 1);

    store.begin("owner", "new", { agentId: "support", source: "draft", revision: 2 }, 2);
    store.retainInput("owner", {
      sessionId: "new", turnId: "turn-new", revision: 0, wav, sampleRate: 16_000, channels: 1,
    });
    await store.flushMedia();

    expect(store.get("owner", "support", "old")).toBeUndefined();
    expect(store.get("owner", "support", "new")?.media).toEqual([
      expect.objectContaining({ state: "ready", direction: "input" }),
    ]);
    await store.close();
  });

  test("disabling new audio capture does not hide already-retained conversation media", async () => {
    const dir = await root();
    let store = new ConversationTraceStore(dir, { retainInputAudio: true });
    store.begin("owner", "history", { agentId: "support", source: "draft", revision: 1 }, 0);
    store.retainInput("owner", {
      sessionId: "history", turnId: "turn", revision: 0,
      wav: writeWav(new Float32Array(100), 16_000), sampleRate: 16_000, channels: 1,
    });
    store.finish("owner", "history", 1);
    await store.close();

    store = new ConversationTraceStore(dir);
    expect(store.policy.audio).toBe(false);
    expect(store.get("owner", "support", "history")?.media[0]).toMatchObject({ state: "ready", direction: "input" });
    await store.close();

    store = new ConversationTraceStore(dir, { serveRetainedAudio: false });
    expect(store.get("owner", "support", "history")?.media).toEqual([]);
    await store.close();
  });

  test("records an adapter-level start failure as an error outcome", async () => {
    const store = new ConversationTraceStore(await root());
    store.begin("owner", "failed-start", { agentId: "support", source: "draft", revision: 1 }, 10);
    store.markError("owner", "failed-start", "session_start_failed");
    store.finish("owner", "failed-start", 20);
    expect(store.get("owner", "support", "failed-start")).toMatchObject({
      outcome: "error",
      errorCode: "session_start_failed",
    });
    store.close();
  });

  test("marks interrupted active rows abandoned on restart and prunes to the configured count", async () => {
    const dir = await root();
    let now = 100;
    let store = new ConversationTraceStore(dir, { now: () => now, maxConversations: 1 });
    store.begin("owner", "old-active", { agentId: "support", source: "draft", revision: 1 }, 50);
    store.close();

    now = 200;
    store = new ConversationTraceStore(dir, { now: () => now, maxConversations: 1 });
    expect(store.get("owner", "support", "old-active")).toMatchObject({ outcome: "abandoned", endedAt: 200 });
    store.begin("owner", "new", { agentId: "support", source: "published", version: 1 }, 210);
    store.finish("owner", "new", 220);
    expect(store.list("owner", "support").conversations.map(trace => trace.id)).toEqual(["new"]);
    store.close();
  });

  test("the redactor keeps operational tool outcome while dropping its payload", () => {
    const original = event("session", 1, {
      type: "tool.result", turnId: "turn", name: "lookup", ok: true, result: { customer: "private" },
    });
    expect(traceEventForRetention(original, false)).toMatchObject({ type: "tool.result", name: "lookup", ok: true });
    expect(traceEventForRetention(original, false)).not.toHaveProperty("result");
    expect(traceEventForRetention(original, true)).toBe(original);
  });
});
