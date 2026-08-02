import { describe, expect, test } from "bun:test";
import { displayTime, previewStatusLabel, voiceFromOption, voiceOptionValue } from "./AgentsPanel";

describe("Agent Builder voice selection", () => {
  test("round-trips the engine together with a duplicate-capable voice id", () => {
    const selected = voiceOptionValue({ id: "default", engine: "voxcpm" });
    expect(selected).not.toBe(voiceOptionValue({ id: "default", engine: "openai" }));
    expect(voiceFromOption(selected)).toEqual({ voice: "default", ttsEngine: "voxcpm" });
  });

  test("clears both fields when automatic voice selection is chosen", () => {
    expect(voiceFromOption("")).toEqual({ voice: "", ttsEngine: "" });
  });
});

describe("Agent list timestamps", () => {
  test("follow the selected UI locale instead of the browser default", () => {
    const timestamp = "2026-08-02T01:05:00.000Z";
    expect(displayTime(timestamp, "en")).not.toContain("月");
    expect(displayTime(timestamp, "zh")).toContain("月");
  });
});

describe("Agent preview connection status", () => {
  test("connection loss takes precedence over a stale session state", () => {
    expect(previewStatusLabel("reconnecting", "speaking")).toBe("重连中");
    expect(previewStatusLabel("connecting", "listening")).toBe("连接中");
  });

  test("uses the live session state only after the socket is connected", () => {
    expect(previewStatusLabel("connected", "speaking")).toBe("回答中");
    expect(previewStatusLabel("connected", "listening")).toBe("聆听中");
  });
});
