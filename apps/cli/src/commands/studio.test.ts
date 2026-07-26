import { describe, expect, test } from "bun:test";
import { parseConfig } from "@voxstudio/config";
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
});
