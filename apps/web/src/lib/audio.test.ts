import { describe, expect, test } from "bun:test";
import { microphoneConstraints, playbackWorkletSource, PlaybackTimeline, visibleAudioInputDevices } from "./audio";
import { microphoneDevicesNeedPermission } from "./use-microphone";

describe("PlaybackTimeline", () => {
  test("schedules gaplessly and reports the audible remainder", () => {
    const timeline = new PlaybackTimeline(0.05);
    const first = timeline.schedule(1, 0);
    expect(first).toBeCloseTo(0.05);
    const second = timeline.schedule(0.5, 0.2);
    // The second chunk starts where the first ends, not at now+lead.
    expect(second).toBeCloseTo(1.05);
    expect(timeline.remainingSec(0.2)).toBeCloseTo(1.35);
    expect(timeline.remainingSec(2)).toBeCloseTo(0);
  });

  test("an underrun re-buffers once instead of resuming into micro-gaps", () => {
    const timeline = new PlaybackTimeline(0.05, 0.35);
    timeline.schedule(0.1, 0); // plays 0.05..0.15
    // The queue drained at 0.15; the next piece arrives late, at t=5.
    const late = timeline.schedule(0.1, 5);
    expect(late).toBeCloseTo(5.35); // one pause worth of cushion, not now+lead
    // The burst behind it packs contiguously into the cushion.
    const packed = timeline.schedule(0.1, 5.01);
    expect(packed).toBeCloseTo(5.45);
  });

  test("reset clears the playhead after an interruption", () => {
    const timeline = new PlaybackTimeline(0.05);
    timeline.schedule(10, 0);
    timeline.reset();
    expect(timeline.remainingSec(0)).toBe(0);
    expect(timeline.schedule(1, 0)).toBeCloseTo(0.05);
  });

  test("a normally completed rendition does not turn inter-turn silence into an underrun", () => {
    const timeline = new PlaybackTimeline(0.05, 0.35);
    timeline.schedule(0.1, 0);
    timeline.completeRendition();

    const next = timeline.scheduleWithMetrics(0.1, 5);
    expect(next.startAtSec).toBeCloseTo(5.05);
    expect(next.underrunSec).toBe(0);
  });
});

describe("microphoneConstraints", () => {
  test("requests mono conversation processing without pinning a stale device", () => {
    expect(microphoneConstraints()).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    });
    expect(microphoneConstraints()).not.toHaveProperty("deviceId");
    expect(microphoneConstraints(true, "airpods-device")).toMatchObject({
      deviceId: { exact: "airpods-device" },
    });
  });

  test("reference recording can disable browser speech processing", () => {
    expect(microphoneConstraints(false)).toEqual({
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 1,
    });
  });
});

describe("microphone device permission presentation", () => {
  test("preserves withheld labels instead of inventing selectable microphone names", () => {
    const devices = visibleAudioInputDevices([
      { kind: "audioinput", deviceId: "", label: "" },
      { kind: "audioinput", deviceId: "default", label: "Default" },
      { kind: "audioinput", deviceId: "private-id", label: "" },
      { kind: "videoinput", deviceId: "camera", label: "Camera" },
    ]);

    expect(devices).toEqual([{ id: "private-id", label: "" }]);
    expect(microphoneDevicesNeedPermission(devices)).toBe(true);
    expect(microphoneDevicesNeedPermission([{ id: "private-id", label: "Studio Mic" }])).toBe(false);
  });
});

describe("continuous playback worklet", () => {
  test("buffers before starting, renders one continuous queue, and drains only after end", () => {
    const scope = globalThis as unknown as Record<string, unknown>;
    const previous = new Map<string, unknown>();
    const names = ["AudioWorkletProcessor", "registerProcessor", "sampleRate", "currentTime", "currentFrame"];
    for (const name of names) previous.set(name, scope[name]);
    const messages: Record<string, unknown>[] = [];
    let Processor: (new () => {
      port: { onmessage?: (event: { data: unknown }) => void };
      process(inputs: unknown[], outputs: Float32Array[][]): boolean;
    }) | undefined;
    class FakeAudioWorkletProcessor {
      readonly port = {
        onmessage: undefined as ((event: { data: unknown }) => void) | undefined,
        postMessage: (message: Record<string, unknown>) => messages.push(message),
      };
    }
    scope.AudioWorkletProcessor = FakeAudioWorkletProcessor;
    scope.registerProcessor = (_name: string, candidate: typeof Processor) => { Processor = candidate; };
    scope.sampleRate = 48_000;
    scope.currentTime = 0;
    scope.currentFrame = 0;
    try {
      Function(playbackWorkletSource)();
      expect(Processor).toBeDefined();
      const processor = new (Processor as NonNullable<typeof Processor>)();
      const send = (data: unknown) => processor.port.onmessage?.({ data });
      send({ type: "start" });
      for (let index = 0; index < 7; index += 1) {
        send({ type: "enqueue", samples: new Float32Array(960).fill(0.25), frameId: index });
      }
      const beforeTarget = new Float32Array(128);
      processor.process([], [[beforeTarget]]);
      expect(beforeTarget.every(sample => sample === 0)).toBe(true);

      send({ type: "enqueue", samples: new Float32Array(960).fill(0.25), frameId: 7 });
      const started = new Float32Array(128);
      processor.process([], [[started]]);
      expect(started.every(sample => sample === 0.25)).toBe(true);
      expect(messages.some(message => message.type === "render" && message.frameId === 0)).toBe(true);
      expect(messages.some(message => message.type === "drained")).toBe(false);

      send({ type: "end" });
      for (let frame = 128; frame < 8 * 960 + 256; frame += 128) {
        scope.currentFrame = frame;
        scope.currentTime = frame / 48_000;
        processor.process([], [[new Float32Array(128)]]);
      }
      expect(messages.filter(message => message.type === "drained")).toHaveLength(1);
    } finally {
      for (const name of names) {
        const value = previous.get(name);
        if (value === undefined) delete scope[name];
        else scope[name] = value;
      }
    }
  });
});
