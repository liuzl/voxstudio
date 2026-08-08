import { describe, expect, test } from "bun:test";
import {
  embeddedLiveKitEnabled,
  embeddedLiveKitOptionsFromEnv,
  startEmbeddedLiveKitRuntime,
  type LiveKitSpawn,
} from "./livekit-runtime";

function emptyStream(): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({ start: controller => controller.close() });
}

describe("embedded LiveKit runtime", () => {
  test("uses a fake child to pass generated credentials outside argv and own shutdown", async () => {
    let command: string[] | undefined;
    let childEnv: Record<string, string> | undefined;
    let resolveExit!: (code: number) => void;
    const exited = new Promise<number>(resolve => { resolveExit = resolve; });
    let kills = 0;
    // process.execPath only satisfies executable-path validation. This injected spawn
    // is the entire child process: the test never launches Bun or waits on a real port.
    const spawn: LiveKitSpawn = (seenCommand, options) => {
      command = seenCommand;
      childEnv = options.env;
      return {
        pid: 42,
        exited,
        stdout: emptyStream(),
        stderr: emptyStream(),
        kill: () => {
          kills += 1;
          resolveExit(0);
        },
      };
    };

    const runtime = await startEmbeddedLiveKitRuntime({
      executable: process.execPath,
      signalPort: 17_880,
      rtcUdpPort: 17_882,
      nodeIp: "192.0.2.10",
      publicServerUrl: "wss://rtc.example.test",
      env: { PATH: process.env.PATH, LIVEKIT_KEYS: "must-not-leak", OPENAI_API_KEY: "provider-secret" },
      spawn,
      fetch: async () => new Response("not found", { status: 404 }),
    });

    expect(command).toEqual([process.execPath, "--bind", "127.0.0.1"]);
    expect(command?.join(" ")).not.toContain(runtime.bootstrap.apiSecret);
    expect(childEnv?.LIVEKIT_KEYS).toBeUndefined();
    expect(childEnv?.OPENAI_API_KEY).toBeUndefined();
    const config = JSON.parse(childEnv?.LIVEKIT_CONFIG ?? "null") as {
      port: number;
      log_level: string;
      rtc: { udp_port: number; node_ip: string; use_external_ip: boolean };
      keys: Record<string, string>;
    };
    expect(config.port).toBe(17_880);
    expect(config.log_level).toBe("warn");
    expect(config.rtc).toEqual({ udp_port: 17_882, use_external_ip: false, node_ip: "192.0.2.10" });
    expect(config.keys).toEqual({ [runtime.bootstrap.apiKey]: runtime.bootstrap.apiSecret });
    expect(runtime.bootstrap).toMatchObject({
      serverUrl: "ws://127.0.0.1:17880",
      publicServerUrl: "wss://rtc.example.test",
    });
    expect(new TextEncoder().encode(runtime.bootstrap.apiSecret).byteLength).toBeGreaterThanOrEqual(32);

    await runtime.stop();
    await runtime.stop();
    expect(kills).toBe(1);
  });

  test("fails closed on malformed enable and port environment values", () => {
    expect(embeddedLiveKitEnabled({})).toBe(false);
    expect(embeddedLiveKitEnabled({ VOX_LIVEKIT_EMBEDDED: "0" })).toBe(false);
    expect(embeddedLiveKitEnabled({ VOX_LIVEKIT_EMBEDDED: "1" })).toBe(true);
    expect(() => embeddedLiveKitEnabled({ VOX_LIVEKIT_EMBEDDED: "yes" })).toThrow("must be 0 or 1");
    expect(() => embeddedLiveKitOptionsFromEnv({ VOX_LIVEKIT_EMBEDDED_PORT: "many" })).toThrow("must be an integer");
  });

  test("validates browser URL and token TTL before spawning the helper", async () => {
    let spawns = 0;
    const spawn: LiveKitSpawn = () => {
      spawns += 1;
      throw new Error("must not spawn");
    };
    await expect(startEmbeddedLiveKitRuntime({
      executable: process.execPath,
      publicServerUrl: "ws://public.example.test",
      spawn,
    })).rejects.toThrow("must use wss://");
    await expect(startEmbeddedLiveKitRuntime({
      executable: process.execPath,
      tokenTtlSeconds: 601,
      spawn,
    })).rejects.toThrow("between 30 and 600");
    expect(spawns).toBe(0);
  });

  test("reports a child that exits before its signal endpoint becomes ready", async () => {
    const spawn: LiveKitSpawn = () => ({
      pid: 7,
      exited: Promise.resolve(23),
      stdout: emptyStream(),
      stderr: emptyStream(),
      kill: () => {},
    });
    await expect(startEmbeddedLiveKitRuntime({
      executable: process.execPath,
      spawn,
      fetch: async () => { throw new TypeError("not ready"); },
    })).rejects.toThrow("status 23");
  });
});
