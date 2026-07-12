import { describe, expect, test } from "bun:test";
import {
  captureCommand,
  decodePcm16le,
  hasAudibleAudio,
  parseAvfoundationAudioDevices,
  recordCommand,
  splitCommand,
} from "./voice-tools";

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

  test("builds continuous mono PCM capture commands", () => {
    expect(captureCommand(undefined, 16_000, "Darwin")).toEqual([
      "ffmpeg", "-hide_banner", "-loglevel", "error", "-f", "avfoundation", "-i", ":default",
      "-ac", "1", "-ar", "16000", "-f", "s16le", "pipe:1",
    ]);
    expect(captureCommand("Mic", 8_000, "Linux")).toContain("Mic");
    expect(() => captureCommand(undefined, 0, "Darwin")).toThrow("sampleRate");
  });

  test("decodes signed little-endian PCM without alignment assumptions", () => {
    const samples = decodePcm16le(new Uint8Array([0, 128, 0, 0, 255, 127]));
    expect([...samples]).toEqual([-1, 0, 32_767 / 32_768]);
    expect(() => decodePcm16le(new Uint8Array([0]))).toThrow("even byte");
  });

  test("parses only AVFoundation audio device entries", () => {
    expect(parseAvfoundationAudioDevices(`
[AVFoundation indev] AVFoundation video devices:
[AVFoundation indev] [0] FaceTime HD Camera
[AVFoundation indev] AVFoundation audio devices:
[AVFoundation indev] [0] Teams Audio
[AVFoundation indev] [1] MacBook Pro Microphone
`)).toEqual([
      { id: "0", name: "Teams Audio" },
      { id: "1", name: "MacBook Pro Microphone" },
    ]);
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
