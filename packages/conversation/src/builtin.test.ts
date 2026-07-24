import { describe, expect, test } from "bun:test";
import { EnergyVadSegmenter, SileroVadSegmenter, type SpeechProbabilityModel } from "@voxstudio/duplex-session";
import { createBuiltinTools, createKeytermProvider, createSessionVad, type BuiltinToolDeps } from "./builtin";

function deps(overrides: Partial<BuiltinToolDeps> = {}): BuiltinToolDeps & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { setVoice: [], setSpeed: [], endCall: [], onVoiceAccepted: [] };
  return {
    listVoices: async () => [],
    setVoice: voice => { calls.setVoice?.push(voice); },
    setSpeed: rate => { calls.setSpeed?.push(rate); },
    engineStatus: async () => undefined,
    endCall: () => { calls.endCall?.push(true); },
    onVoiceAccepted: entry => { calls.onVoiceAccepted?.push(entry); },
    ...overrides,
    calls,
  };
}

function tool(dependencies: BuiltinToolDeps, name: string) {
  const found = createBuiltinTools(dependencies).find(candidate => candidate.name === name);
  if (!found) throw new Error(`missing builtin tool ${name}`);
  return found;
}

const signal = new AbortController().signal;

describe("createBuiltinTools", () => {
  test("set_voice accepts any id against an empty bank (engines without a list route)", async () => {
    const dependencies = deps();
    const result = await tool(dependencies, "set_voice").handler({ voice: "ghost" }, signal) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(result.voice).toBe("ghost");
    expect(dependencies.calls.setVoice).toEqual(["ghost"]);
    expect(dependencies.calls.onVoiceAccepted).toEqual([]);
  });

  test("set_voice rejects an unknown id against a non-empty bank, with examples", async () => {
    const dependencies = deps({ listVoices: async () => [{ id: "alice" }, { id: "bob" }] });
    const result = await tool(dependencies, "set_voice").handler({ voice: "ghost" }, signal) as Record<string, unknown>;
    expect(result.error).toContain("ghost");
    expect(result.examples).toEqual(["alice", "bob"]);
    expect(dependencies.calls.setVoice).toEqual([]);
  });

  test("set_voice hands the matched entry to onVoiceAccepted and reports its engine", async () => {
    const dependencies = deps({ listVoices: async () => [{ id: "alice", engine: "kokoro" }] });
    const result = await tool(dependencies, "set_voice").handler({ voice: "alice" }, signal) as Record<string, unknown>;
    expect(result).toMatchObject({ ok: true, voice: "alice", engine: "kokoro" });
    expect(dependencies.calls.onVoiceAccepted).toEqual([{ id: "alice", engine: "kokoro" }]);
    expect(dependencies.calls.setVoice).toEqual(["alice"]);
  });

  test("set_voice refuses a blank id", async () => {
    const dependencies = deps();
    const result = await tool(dependencies, "set_voice").handler({ voice: "  " }, signal) as Record<string, unknown>;
    expect(result.error).toBeDefined();
    expect(dependencies.calls.setVoice).toEqual([]);
  });

  test("set_speed clamps into [0.5, 2] and rejects non-numbers", async () => {
    const dependencies = deps();
    const speed = tool(dependencies, "set_speed");
    expect(await speed.handler({ rate: 9 }, signal)).toMatchObject({ ok: true, rate: 2 });
    expect(await speed.handler({ rate: 0.1 }, signal)).toMatchObject({ ok: true, rate: 0.5 });
    expect(dependencies.calls.setSpeed).toEqual([2, 0.5]);
    const rejected = await speed.handler({ rate: "fast" }, signal) as Record<string, unknown>;
    expect(rejected.error).toBeDefined();
    expect(dependencies.calls.setSpeed).toEqual([2, 0.5]);
  });

  test("get_engine_status reports unavailability, and omits a missing kind", async () => {
    const unavailable = await tool(deps(), "get_engine_status").handler({}, signal) as Record<string, unknown>;
    expect(unavailable.error).toBeDefined();

    const dependencies = deps({
      engineStatus: async () => [
        { name: "tts", kind: "tts", healthy: true },
        { name: "asr", healthy: false },
      ],
    });
    const result = await tool(dependencies, "get_engine_status").handler({}, signal) as Record<string, unknown>;
    expect(result.engines).toEqual([
      { name: "tts", kind: "tts", healthy: true },
      { name: "asr", healthy: false },
    ]);
  });

  test("end_call raises the hang-up flag", async () => {
    const dependencies = deps();
    const result = await tool(dependencies, "end_call").handler({}, signal) as Record<string, unknown>;
    expect(result.ok).toBe(true);
    expect(dependencies.calls.endCall).toEqual([true]);
  });
});

describe("createSessionVad", () => {
  const model: SpeechProbabilityModel = { windowSamples: 512, process: () => 0, reset: () => {} };

  test("an explicit energy choice skips silero entirely", async () => {
    const vad = await createSessionVad({
      choice: "energy",
      loadSileroVad: () => Promise.reject(new Error("must not be called")),
      onFallback: () => { throw new Error("must not fall back"); },
    });
    expect(vad).toBeInstanceOf(EnergyVadSegmenter);
  });

  test("silero is the default when a loader is available", async () => {
    const vad = await createSessionVad({
      loadSileroVad: async () => model,
      onFallback: () => { throw new Error("must not fall back"); },
    });
    expect(vad).toBeInstanceOf(SileroVadSegmenter);
  });

  test("an explicit silero choice fails loudly when the loader fails", async () => {
    await expect(createSessionVad({
      choice: "silero",
      explicit: true,
      loadSileroVad: () => Promise.reject(new Error("no runtime")),
      onFallback: () => { throw new Error("must not fall back"); },
    })).rejects.toThrow("no runtime");
  });

  test("the default degrades loudly to the energy detector when silero fails", async () => {
    const messages: string[] = [];
    const vad = await createSessionVad({
      loadSileroVad: () => Promise.reject(new Error("no runtime")),
      onFallback: message => messages.push(message),
    });
    expect(vad).toBeInstanceOf(EnergyVadSegmenter);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("no runtime");
    expect(messages[0]).toContain("using the energy detector");
  });

  test("a missing loader degrades the default the same way", async () => {
    const messages: string[] = [];
    const vad = await createSessionVad({ onFallback: message => messages.push(message) });
    expect(vad).toBeInstanceOf(EnergyVadSegmenter);
    expect(messages).toHaveLength(1);
  });
});

describe("createKeytermProvider", () => {
  test("merges config terms with voice ids and caches the bank fetch", async () => {
    let fetches = 0;
    const provider = createKeytermProvider({
      configTerms: ["voxstudio"],
      listVoices: async () => { fetches += 1; return [{ id: "alice" }]; },
    });
    expect(await provider()).toEqual(["voxstudio", "alice"]);
    expect(await provider()).toEqual(["voxstudio", "alice"]);
    expect(fetches).toBe(1);
  });

  test("a failed bank fetch degrades to the config terms, not a failed turn", async () => {
    const provider = createKeytermProvider({
      configTerms: ["voxstudio"],
      listVoices: () => Promise.reject(new Error("engine down")),
    });
    expect(await provider()).toEqual(["voxstudio"]);
  });

  test("the cache expires after cacheMs", async () => {
    let fetches = 0;
    const provider = createKeytermProvider({
      configTerms: [],
      listVoices: async () => { fetches += 1; return [{ id: `v${fetches}` }]; },
      cacheMs: 0,
    });
    expect(await provider()).toEqual(["v1"]);
    expect(await provider()).toEqual(["v2"]);
  });
});
