import { describe, expect, test } from "bun:test";
import { AgentRegistry } from "@voxstudio/agents";
import { parseConfig } from "@voxstudio/config";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GatewayServer, GatewayServerOptions } from "@voxstudio/realtime-gateway";
import type { CliIo } from "../io";
import { runStudio } from "./studio";

const config = parseConfig({
  engines: {
    asr: { base_url: "http://asr.test" },
    llm: { base_url: "http://llm.test" },
    tts: { base_url: "http://tts.test" },
  },
});

function collectingIo(): CliIo & { outs: string[]; errs: string[] } {
  const outs: string[] = [];
  const errs: string[] = [];
  return { outs, errs, out: line => outs.push(line), err: line => errs.push(line) };
}

function fakeGateway(): GatewayServer {
  return { url: "http://127.0.0.1:9999/", port: 9999, sessionCount: () => 0, stop: async () => {} };
}

describe("vox studio", () => {
  test("starts the gateway with the embedded assets and prints the URL", async () => {
    const io = collectingIo();
    let seen: GatewayServerOptions | undefined;
    const code = await runStudio(
      ["--host", "0.0.0.0", "--port", "9999", "--token", "sesame", "--library", "/tmp/vox-library"],
      config,
      io,
      options => {
        seen = options;
        return fakeGateway();
      },
      false,
    );
    expect(code).toBe(0);
    expect(seen?.hostname).toBe("0.0.0.0");
    expect(seen?.port).toBe(9999);
    expect(seen?.token).toBe("sesame");
    // The retention opt-in reaches the gateway; the gateway itself creates the store.
    expect(seen?.libraryDir).toBe("/tmp/vox-library");
    // The manifest object is handed to the gateway verbatim (empty stub in tests).
    expect(seen?.staticAssets).toBeDefined();
    expect(io.outs.join("\n")).toContain("http://127.0.0.1:9999/");
    expect(io.outs.join("\n")).toContain("#token=<VOX_GATEWAY_TOKEN>");
  });

  test("VOX_GATEWAY_TOKEN reaches the gateway when --token is absent; the flag wins", async () => {
    const io = collectingIo();
    const before = process.env.VOX_GATEWAY_TOKEN;
    process.env.VOX_GATEWAY_TOKEN = "env-secret";
    try {
      let seen: GatewayServerOptions | undefined;
      const capture = (options: GatewayServerOptions): GatewayServer => {
        seen = options;
        return fakeGateway();
      };
      expect(await runStudio([], config, io, capture, false)).toBe(0);
      expect(seen?.token).toBe("env-secret");
      expect(await runStudio(["--token", "flag-secret"], config, io, capture, false)).toBe(0);
      expect(seen?.token).toBe("flag-secret");
    } finally {
      if (before === undefined) delete process.env.VOX_GATEWAY_TOKEN;
      else process.env.VOX_GATEWAY_TOKEN = before;
    }
  });

  test("LiveKit bootstrap credentials are environment-only, complete, bounded, and passed without logging secrets", async () => {
    const names = [
      "VOX_LIVEKIT_URL",
      "VOX_LIVEKIT_API_KEY",
      "VOX_LIVEKIT_API_SECRET",
      "VOX_LIVEKIT_TOKEN_TTL_SECONDS",
    ] as const;
    const before = Object.fromEntries(names.map(name => [name, process.env[name]]));
    const clear = () => { for (const name of names) delete process.env[name]; };
    const io = collectingIo();
    try {
      clear();
      let seen: GatewayServerOptions | undefined;
      const capture = (options: GatewayServerOptions): GatewayServer => { seen = options; return fakeGateway(); };
      expect(await runStudio([], config, io, capture, false)).toBe(0);
      expect(seen?.livekit).toBeUndefined();

      process.env.VOX_LIVEKIT_URL = "wss://media.voxstudio.example";
      await expect(runStudio([], config, io, capture, false)).rejects.toThrow("must be set together");
      process.env.VOX_LIVEKIT_API_KEY = "livekit-key";
      process.env.VOX_LIVEKIT_API_SECRET = "livekit-secret-that-must-not-be-logged";
      process.env.VOX_LIVEKIT_TOKEN_TTL_SECONDS = "420";
      expect(await runStudio([], config, io, capture, false)).toBe(0);
      expect(seen?.livekit).toEqual({
        serverUrl: "wss://media.voxstudio.example",
        apiKey: "livekit-key",
        apiSecret: "livekit-secret-that-must-not-be-logged",
        tokenTtlSeconds: 420,
      });
      expect(seen?.livekitAdapter).toBeDefined();
      expect(`${io.outs.join("\n")}\n${io.errs.join("\n")}`).not.toContain("livekit-secret-that-must-not-be-logged");

      process.env.VOX_LIVEKIT_TOKEN_TTL_SECONDS = "601";
      await expect(runStudio([], config, io, capture, false)).rejects.toThrow("between 30 and 600");
    } finally {
      for (const name of names) {
        const value = before[name];
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  test("refuses a shared token that OpenAI realtime clients cannot carry", async () => {
    const io = collectingIo();
    await expect(runStudio(["--token", "base64/secret="], config, io, () => fakeGateway(), false))
      .rejects.toThrow("WebSocket protocol-token");
  });

  test("--accounts fails closed without a real secret, and refuses to share the door with --token", async () => {
    const io = collectingIo();
    const before = process.env.VOX_AUTH_SECRET;
    delete process.env.VOX_AUTH_SECRET;
    try {
      await expect(runStudio(["--accounts", "/tmp/vox-auth"], config, io, () => fakeGateway(), false))
        .rejects.toThrow("VOX_AUTH_SECRET");
      process.env.VOX_AUTH_SECRET = "an-adequately-long-test-secret-0123456789";
      await expect(runStudio(["--accounts", "/tmp/vox-auth", "--token", "sesame"], config, io, () => fakeGateway(), false))
        .rejects.toThrow("mutually exclusive");
      let seen: GatewayServerOptions | undefined;
      expect(await runStudio(["--accounts", "/tmp/vox-auth"], config, io, options => { seen = options; return fakeGateway(); }, false)).toBe(0);
      expect(seen?.accounts?.dir).toBe("/tmp/vox-auth");
      expect(seen?.accounts?.secret?.length).toBeGreaterThanOrEqual(32);
    } finally {
      if (before === undefined) delete process.env.VOX_AUTH_SECRET;
      else process.env.VOX_AUTH_SECRET = before;
    }
  });

  test("--quota needs accounts, fails closed on a typo, and defaults its window", async () => {
    const io = collectingIo();
    const beforeSecret = process.env.VOX_AUTH_SECRET;
    const beforeQuota = process.env.VOX_GATEWAY_QUOTA;
    delete process.env.VOX_GATEWAY_QUOTA;
    try {
      // A quota with no accounts would meter the only person there is.
      await expect(runStudio(["--quota", "100"], config, io, () => fakeGateway(), false))
        .rejects.toThrow("requires --accounts");
      // A typo must not silently run unmetered.
      await expect(runStudio(["--quota", "lots"], config, io, () => fakeGateway(), false))
        .rejects.toThrow("positive integer");
      await expect(runStudio(["--quota", "10", "--quota-window", "-5"], config, io, () => fakeGateway(), false))
        .rejects.toThrow("positive");
      process.env.VOX_GATEWAY_QUOTA = "not-a-number";
      await expect(runStudio([], config, io, () => fakeGateway(), false))
        .rejects.toThrow("VOX_GATEWAY_QUOTA");
      delete process.env.VOX_GATEWAY_QUOTA;

      process.env.VOX_AUTH_SECRET = "an-adequately-long-test-secret-0123456789";
      let seen: GatewayServerOptions | undefined;
      const capture = (options: GatewayServerOptions): GatewayServer => { seen = options; return fakeGateway(); };
      expect(await runStudio(["--accounts", "/tmp/vox-auth", "--quota", "500"], config, io, capture, false)).toBe(0);
      // One hour unless told otherwise — stated in the help, not a hidden constant.
      expect(seen?.quota).toEqual({ operations: 500, windowSeconds: 3_600 });
      expect(await runStudio(["--accounts", "/tmp/vox-auth", "--quota", "5", "--quota-window", "60"], config, io, capture, false)).toBe(0);
      expect(seen?.quota).toEqual({ operations: 5, windowSeconds: 60 });

      // Absent by default: an existing deployment gains no limit by upgrading.
      expect(await runStudio(["--accounts", "/tmp/vox-auth"], config, io, capture, false)).toBe(0);
      expect(seen?.quota).toBeUndefined();
    } finally {
      if (beforeSecret === undefined) delete process.env.VOX_AUTH_SECRET;
      else process.env.VOX_AUTH_SECRET = beforeSecret;
      if (beforeQuota === undefined) delete process.env.VOX_GATEWAY_QUOTA;
      else process.env.VOX_GATEWAY_QUOTA = beforeQuota;
    }
  });

  test("rejects a malformed port and unknown options", async () => {
    const io = collectingIo();
    await expect(runStudio(["--port", "not-a-port"], config, io, () => fakeGateway(), false))
      .rejects.toThrow("--port");
    await expect(runStudio(["--serve"], config, io, () => fakeGateway(), false))
      .rejects.toThrow("unknown option");
  });

  test("the retention quota reaches the gateway parsed; typos and a quota without a library fail closed", async () => {
    const io = collectingIo();
    let seen: GatewayServerOptions | undefined;
    const code = await runStudio(
      ["--library", "/tmp/vox-library", "--library-max-bytes", "512M"],
      config,
      io,
      options => {
        seen = options;
        return fakeGateway();
      },
      false,
    );
    expect(code).toBe(0);
    expect(seen?.libraryMaxBytes).toBe(512 * 1024 * 1024);

    await expect(runStudio(["--library", "/tmp/x", "--library-max-bytes", "lots"], config, io, () => fakeGateway(), false))
      .rejects.toThrow("positive byte size");
    await expect(runStudio(["--library-max-bytes", "512M"], config, io, () => fakeGateway(), false))
      .rejects.toThrow("requires --library");
  });

  test("conversation trace retention is an explicit, independently bounded opt-in", async () => {
    const io = collectingIo();
    let seen: GatewayServerOptions | undefined;
    expect(await runStudio([
      "--traces", "/tmp/vox-traces",
      "--trace-content",
      "--trace-retention-days", "14",
      "--trace-max-conversations", "500",
    ], config, io, options => { seen = options; return fakeGateway(); }, false)).toBe(0);
    expect(seen).toMatchObject({
      traceDir: "/tmp/vox-traces",
      traceContent: true,
      traceRetentionDays: 14,
      traceMaxConversations: 500,
    });
    await expect(runStudio(["--trace-content"], config, io, () => fakeGateway(), false))
      .rejects.toThrow("require --traces");
    await expect(runStudio(["--traces", "/tmp/vox-traces", "--trace-retention-days", "0"], config, io, () => fakeGateway(), false))
      .rejects.toThrow("positive integer");
  });

  test("--demo-agent resolves and pins the current immutable published version", async () => {
    const root = await mkdtemp(join(tmpdir(), "vox-studio-demo-agent-"));
    try {
      const registry = new AgentRegistry(root);
      const created = await registry.create("owner", { id: "demo", name: "Demo", spec: { instructions: "Published" } });
      await registry.publish("owner", "demo", created.revision);
      let seen: GatewayServerOptions | undefined;
      expect(await runStudio(
        ["--agents", root, "--demo", "--demo-agent", "demo"],
        config,
        collectingIo(),
        options => { seen = options; return fakeGateway(); },
        false,
      )).toBe(0);
      expect(seen?.demoMode).toBe(true);
      expect(seen?.demoAgent).toEqual({ id: "demo", version: 1 });

      await expect(runStudio(["--agents", root, "--demo-agent", "demo"], config, collectingIo(), () => fakeGateway(), false))
        .rejects.toThrow("requires --demo");
      const before = process.env.VOX_AUTH_SECRET;
      process.env.VOX_AUTH_SECRET = "an-adequately-long-test-secret-0123456789";
      try {
        await expect(runStudio([
          "--agents", root, "--demo", "--demo-agent", "demo", "--accounts", join(root, "accounts"),
        ], config, collectingIo(), () => fakeGateway(), false)).rejects.toThrow("cannot be combined with --accounts");
      } finally {
        if (before === undefined) delete process.env.VOX_AUTH_SECRET;
        else process.env.VOX_AUTH_SECRET = before;
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
