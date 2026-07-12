import { describe, expect, test } from "bun:test";
import { hasAudibleAudio, recordCommand, splitCommand } from "./voice-tools";

describe("voice platform tools", () => {
  test.each([
    ["Darwin", undefined, ["-f", "avfoundation", "-i", ":default"]],
    ["Darwin", "2", ["-f", "avfoundation", "-i", ":2"]],
    ["Linux", undefined, ["-f", "pulse", "-i", "default"]],
    ["Windows", "Microphone", ["-f", "dshow", "-i", "audio=Microphone"]],
  ] as const)("builds the %s recording input", (system, device, source) => {
    const command = recordCommand("voice.wav", 12, device, system);
    const start = command.indexOf("-f");
    expect(command.slice(start, start + 4)).toEqual([...source]);
    expect(command.slice(command.indexOf("-t"), command.indexOf("-t") + 2)).toEqual(["-t", "12"]);
    expect(command.slice(-5)).toEqual(["-ac", "1", "-ar", "16000", "voice.wav"]);
  });

  test("manual recording has no duration flag", () => {
    expect(recordCommand("voice.wav", 0, undefined, "Linux")).not.toContain("-t");
  });

  test("detects audible recordings without treating silence as speech", () => {
    expect(hasAudibleAudio(new Float32Array(480))).toBe(false);
    expect(hasAudibleAudio(new Float32Array([0.0009, -0.001]))).toBe(true);
    expect(hasAudibleAudio(new Float32Array([0.01]))).toBe(true);
    expect(hasAudibleAudio(new Float32Array([0.0009]), 0.01)).toBe(false);
  });

  test("splits quoted editor commands without invoking a shell", () => {
    expect(splitCommand("code --wait")).toEqual(["code", "--wait"]);
    expect(splitCommand("'/Applications/My Editor' --flag=\"two words\""))
      .toEqual(["/Applications/My Editor", "--flag=two words"]);
    expect(splitCommand("\"C:\\Program Files\\Editor\\edit.exe\" --wait"))
      .toEqual(["C:\\Program Files\\Editor\\edit.exe", "--wait"]);
    expect(() => splitCommand("editor 'unfinished")).toThrow("unmatched quoting");
  });
});
