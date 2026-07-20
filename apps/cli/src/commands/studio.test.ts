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
