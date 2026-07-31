import { afterEach, describe, expect, test } from "bun:test";
import { transcribe } from "./api";

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
