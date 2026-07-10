import { describe, expect, test } from "bun:test";
import { probeEngine } from "./health";

describe("engine health", () => {
  test("uses the configured health path", async () => {
    const result = await probeEngine("tts", {
      baseUrl: "https://voice.example///",
      model: "voxcpm2",
      healthPath: "/healthz",
    }, async (input) => {
      expect(String(input)).toBe("https://voice.example/healthz");
      return new Response("ok");
    });
    expect(result).toMatchObject({ name: "tts", ok: true, detail: "ok" });
  });

  test("normalizes HTTP and network failures", async () => {
    const config = { baseUrl: "https://voice.example", model: "gemma" };
    await expect(probeEngine("llm", config, async () => new Response(null, { status: 503 })))
      .resolves.toMatchObject({ ok: false, detail: "HTTP 503" });
    await expect(probeEngine("llm", config, async () => {
      throw new TypeError("offline");
    })).resolves.toMatchObject({ ok: false, detail: "TypeError" });
    await expect(probeEngine("llm", config, async () => {
      throw new Error("fetch failed", { cause: { code: "ECONNREFUSED" } });
    })).resolves.toMatchObject({ ok: false, detail: "ECONNREFUSED" });
  });
});
