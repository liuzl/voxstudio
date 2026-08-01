import { describe, expect, test } from "bun:test";
import { voiceFromOption, voiceOptionValue } from "./AgentsPanel";

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
