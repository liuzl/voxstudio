import { describe, expect, test } from "bun:test";
import {
  BoundedAudioQueue,
  DuplexSession,
  type DuplexEvent,
  EnergyVadSegmenter,
  SileroVadSegmenter,
  type OutputAudioFrame,
  type SpeechProbabilityModel,
} from "./index";

function audio(milliseconds: number, sampleRate = 1_000): OutputAudioFrame {
  return { samples: new Float32Array(milliseconds * sampleRate / 1_000), sampleRate, timestampMs: 0 };
}

describe("bounded audio queue", () => {
  test("enforces a duration limit and restores capacity after consumption", () => {
    const queue = new BoundedAudioQueue(100);
    expect(queue.push({ turnId: "turn-1", audio: audio(60) })).toBe(true);
    expect(queue.push({ turnId: "turn-1", audio: audio(50) })).toBe(false);
    expect(queue.queuedDurationMs).toBe(60);
    expect(queue.shift()?.turnId).toBe("turn-1");
    expect(queue.queuedDurationMs).toBe(0);
    expect(queue.push({ turnId: "turn-2", audio: audio(100) })).toBe(true);
  });

  test("rejects invalid queue limits and audio sample rates", () => {
    expect(() => new BoundedAudioQueue(0)).toThrow("maxQueuedAudioMs");
    const queue = new BoundedAudioQueue(100);
    expect(() => queue.push({ turnId: "turn", audio: { ...audio(10), sampleRate: 0 } })).toThrow("sampleRate");
  });
});

describe("energy VAD segmentation", () => {
  test("keeps pre-roll, confirms after enough voiced audio, and ends after silence", () => {
    const vad = new EnergyVadSegmenter({
      sampleRate: 1_000, threshold: 0.1, preRollMs: 20, minSpeechMs: 30, silenceMs: 30, maxSpeechMs: 200,
    });
    expect(vad.push(new Float32Array(20), 0)).toEqual([]);
    const started = vad.push(new Float32Array(20).fill(0.2), 20);
    expect(started).toEqual([{ type: "speech.start", timestampMs: 20, rms: expect.any(Number) }]);
    expect(vad.push(new Float32Array(20).fill(0.2), 40)).toEqual([
      { type: "speech.confirmed", timestampMs: 40, startedAtMs: 20 },
    ]);
    expect(vad.push(new Float32Array(20), 60)).toEqual([]);
    const ended = vad.push(new Float32Array(20), 80);
    expect(ended).toHaveLength(1);
    const event = ended[0];
    expect(event).toMatchObject({ type: "speech.end", reason: "silence", startedAtMs: 20 });
    if (event?.type === "speech.end") expect(event.samples.length).toBe(100);
  });

  test("confirms only once per utterance", () => {
    const vad = new EnergyVadSegmenter({ sampleRate: 1_000, threshold: 0.1, minSpeechMs: 10, silenceMs: 100, preRollMs: 0 });
    expect(vad.push(new Float32Array(20).fill(0.2), 0).map(event => event.type))
      .toEqual(["speech.start", "speech.confirmed"]);
    expect(vad.push(new Float32Array(20).fill(0.2), 20)).toEqual([]);
  });

  test("reports a burst that ends below the minimum voiced duration as dropped, not speech", () => {
    const vad = new EnergyVadSegmenter({
      sampleRate: 1_000, threshold: 0.1, preRollMs: 0, minSpeechMs: 50, silenceMs: 30, maxSpeechMs: 200,
    });
    expect(vad.push(new Float32Array(20).fill(0.2), 0)).toEqual([
      { type: "speech.start", timestampMs: 0, rms: expect.any(Number) },
    ]);
    expect(vad.push(new Float32Array(20), 20)).toEqual([]);
    expect(vad.push(new Float32Array(20), 40)).toEqual([
      { type: "speech.dropped", timestampMs: 40, startedAtMs: 0 },
    ]);
    // The segmenter is reusable after a drop.
    expect(vad.push(new Float32Array(20).fill(0.2), 60).map(event => event.type)).toEqual(["speech.start"]);
  });

  test("ends a continuous utterance at its maximum duration", () => {
    const vad = new EnergyVadSegmenter({
      sampleRate: 1_000, threshold: 0.1, minSpeechMs: 10, silenceMs: 100, maxSpeechMs: 40, preRollMs: 0,
    });
    vad.push(new Float32Array(20).fill(0.2), 0);
    const ended = vad.push(new Float32Array(20).fill(0.2), 20);
    expect(ended).toMatchObject([expect.objectContaining({ type: "speech.end", reason: "max_duration" })]);
  });

  test("validates its configuration", () => {
    expect(() => new EnergyVadSegmenter({ sampleRate: 0 })).toThrow("sampleRate");
    expect(() => new EnergyVadSegmenter({ sampleRate: 1_000, threshold: -1 })).toThrow("threshold");
    expect(() => new EnergyVadSegmenter({ sampleRate: 1_000, maxSpeechMs: 0 })).toThrow("maxSpeechMs");
  });
});

describe("silero VAD segmentation", () => {
  // A scripted model: consumes one probability per window, records window sizes.
  function model(script: number[], windowSamples = 512): SpeechProbabilityModel & { windows: number[]; resets: number } {
    let index = 0;
    const value = {
      windowSamples,
      windows: [] as number[],
      resets: 0,
      process(window: Float32Array): number {
        value.windows.push(window.length);
        return script[Math.min(index++, script.length - 1)] as number;
      },
      reset(): void {
        value.resets += 1;
        index = 0;
      },
    };
    return value;
  }

  const windowMs = 512_000 / 16_000; // 32ms

  function frame(fill = 0): Float32Array {
    return new Float32Array(320).fill(fill); // 20ms capture frames, as the CLI delivers
  }

  test("buffers capture frames into model windows and stamps events from the sample clock", async () => {
    const fake = model([0.9, 0.9, 0.9, 0.1, 0.1, 0.1, 0.1, 0.1]);
    const vad = new SileroVadSegmenter({ model: fake, minSpeechMs: 64, silenceMs: 96 });
    const events = [];
    // 8 windows need 4096 samples = 12.8 frames; feed 13.
    for (let index = 0; index < 13; index += 1) {
      events.push(...await vad.push(frame(index < 5 ? 0.2 : 0), index * 20));
    }
    // Windows 5+ are pure silence: the level gate marks them unvoiced without consulting
    // the model, so only the windows carrying audio produce an inference.
    expect(fake.windows).toEqual([512, 512, 512, 512]);
    expect(events.map(event => event.type)).toEqual(["speech.start", "speech.confirmed", "speech.end"]);
    const [start, confirmed] = events;
    expect(start?.timestampMs).toBe(0);
    if (confirmed?.type === "speech.confirmed") expect(confirmed.timestampMs).toBe(windowMs);
    // Silence (96ms = 3 windows) is reached at window 6, so the utterance is windows 1-6.
    const end = events[2];
    if (end?.type === "speech.end") expect(end.samples.length).toBe(6 * 512);
  });

  test("uses hysteresis: a mid-band probability sustains speech but never starts it", async () => {
    const idle = new SileroVadSegmenter({ model: model([0.4, 0.4, 0.4]), minSpeechMs: 32 });
    expect(await idle.push(new Float32Array(512 * 3).fill(0.2), 0)).toEqual([]);

    const speaking = new SileroVadSegmenter({ model: model([0.9, 0.4, 0.4, 0.1, 0.1, 0.1]), minSpeechMs: 32, silenceMs: 96 });
    const events = await speaking.push(new Float32Array(512 * 6).fill(0.2), 0);
    // 0.4 windows (≥ end 0.35) keep the utterance open; only the 0.1 run ends it.
    expect(events.map(event => event.type)).toEqual(["speech.start", "speech.confirmed", "speech.end"]);
    const end = events[2];
    if (end?.type === "speech.end") expect(end.samples.length).toBe(6 * 512);
  });

  test("drops a single-window burst instead of confirming it", async () => {
    const vad = new SileroVadSegmenter({ model: model([0.9, 0.1, 0.1, 0.1]), minSpeechMs: 64, silenceMs: 96 });
    const events = await vad.push(new Float32Array(512 * 4).fill(0.2), 0);
    expect(events.map(event => event.type)).toEqual(["speech.start", "speech.dropped"]);
  });

  test("gates quiet audio by level before the model sees it", async () => {
    // Residual echo after cancellation is quiet speech — the agent's own leaked voice — and
    // a good speech model scores it as speech. The level gate is what keeps silero from
    // confirming a barge-in on it; rescoring the certified AEC-gate captures showed exactly
    // that failure with the gate disabled.
    const fake = model([0.99, 0.99, 0.99, 0.99]);
    const vad = new SileroVadSegmenter({ model: fake, minSpeechMs: 32, minLevel: 0.01 });
    const quiet = new Float32Array(512 * 4).fill(0.003); // well-formed, but ~-50dBFS
    expect(await vad.push(quiet, 0)).toEqual([]);
    expect(fake.windows).toEqual([]);
    expect(() => new SileroVadSegmenter({ model: fake, minLevel: -1 })).toThrow("minLevel");
  });

  test("reset clears the model state, the buffer, and the sample clock", async () => {
    const fake = model([0.9]);
    const vad = new SileroVadSegmenter({ model: fake, minSpeechMs: 32 });
    await vad.push(new Float32Array(600).fill(0.2), 0); // one window consumed, 88 samples pending
    vad.reset();
    expect(fake.resets).toBe(1);
    // After reset the next push re-anchors: a fresh 512-sample window starts from the new timestamp.
    const events = await vad.push(new Float32Array(512).fill(0.2), 5_000);
    expect(events[0]).toMatchObject({ type: "speech.start", timestampMs: 5_000 });
  });

  test("validates its configuration", () => {
    const fake = model([0.9]);
    expect(() => new SileroVadSegmenter({ model: fake, startProbability: 0 })).toThrow("startProbability");
    expect(() => new SileroVadSegmenter({ model: fake, endProbability: 0.9 })).toThrow("endProbability");
    expect(() => new SileroVadSegmenter({ model: { ...fake, windowSamples: 0 } })).toThrow("windowSamples");
  });
});

describe("duplex session", () => {
  function session() {
    const events: DuplexEvent[] = [];
    let nextTurn = 0;
    const value = new DuplexSession({
      sessionId: "session-1",
      maxQueuedAudioMs: 100,
      now: () => 123,
      newTurnId: () => `turn-${++nextTurn}`,
      onEvent: event => events.push(event),
    });
    return { value, events };
  }

  test("moves a turn through speech, thinking, speaking, and completion", () => {
    const { value, events } = session();
    value.start();
    const turn = value.startUserSpeech();
    expect(value.finalizeUserSpeech(turn.id)).toBe(true);
    expect(value.startThinking(turn.id)).toBe(true);
    expect(value.startSpeaking(turn.id)).toBe(true);
    expect(value.queueOutput(turn.id, audio(50))).toBe(true);
    expect(value.complete(turn.id)).toBe(true);
    expect(value.snapshot()).toEqual({
      sessionId: "session-1", state: "listening", lastSequence: 9, queuedAudioMs: 50,
    });
    expect(events.map(event => event.sequence)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(events.filter(event => event.type === "session.state").map(event => event.state)).toEqual([
      "listening", "speech_started", "finalizing", "thinking", "speaking", "listening",
    ]);
  });

  test("a new user speech interrupts and aborts the previous active turn", () => {
    const { value, events } = session();
    value.start();
    const first = value.startUserSpeech();
    value.finalizeUserSpeech(first.id);
    value.startThinking(first.id);
    value.startSpeaking(first.id);
    value.queueOutput(first.id, audio(50));
    const second = value.startUserSpeech();

    expect(first.signal.aborted).toBe(true);
    expect(first.signal.reason).toBe("barge_in");
    expect(value.state).toBe("speech_started");
    expect(value.currentTurn?.id).toBe(second.id);
    expect(value.output.length).toBe(0);
    expect(events.find(event => event.type === "turn.interrupted")).toMatchObject({
      turnId: first.id, reason: "barge_in",
    });
  });

  test("records a false barge-in against the speaking turn without stopping it", () => {
    const { value, events } = session();
    value.start();
    const turn = value.startUserSpeech();
    value.finalizeUserSpeech(turn.id);
    value.startThinking(turn.id);
    value.startSpeaking(turn.id);
    expect(value.recordFalseBargeIn()).toBe(true);
    expect(value.state).toBe("speaking");
    expect(turn.signal.aborted).toBe(false);
    expect(events.find(event => event.type === "turn.false_barge_in")).toMatchObject({ turnId: turn.id });
    value.complete(turn.id);
    // Outside of speaking there is no playback to protect, so there is nothing to record.
    expect(value.recordFalseBargeIn()).toBe(false);
  });

  test("rejects stale turn work and reports queue overflow", () => {
    const { value, events } = session();
    value.start();
    const turn = value.startUserSpeech();
    value.finalizeUserSpeech(turn.id);
    value.startThinking(turn.id);
    value.startSpeaking(turn.id);
    expect(value.queueOutput("stale", audio(10))).toBe(false);
    expect(value.queueOutput(turn.id, audio(80))).toBe(true);
    expect(value.queueOutput(turn.id, audio(30))).toBe(false);
    expect(events.filter(event => event.type === "audio.discarded")).toHaveLength(1);
    expect(events.filter(event => event.type === "audio.queue_overflow")).toHaveLength(1);
  });

  test("reconfiguration and close cancel active work and reject future input", () => {
    const { value } = session();
    value.start();
    const turn = value.startUserSpeech();
    value.reconfigure();
    expect(turn.signal.aborted).toBe(true);
    expect(value.state).toBe("reconfiguring");
    value.resumeAfterReconfigure();
    value.close();
    expect(value.state).toBe("closed");
    expect(() => value.startUserSpeech()).toThrow("closed");
  });
});
