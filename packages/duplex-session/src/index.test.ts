import { describe, expect, test } from "bun:test";
import {
  BoundedAudioQueue,
  DuplexSession,
  type DuplexEvent,
  EnergyVadSegmenter,
  type OutputAudioFrame,
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
  test("keeps pre-roll, ends after silence, and bounds short noise", () => {
    const vad = new EnergyVadSegmenter({
      sampleRate: 1_000, threshold: 0.1, preRollMs: 20, minSpeechMs: 20, silenceMs: 30, maxSpeechMs: 200,
    });
    expect(vad.push(new Float32Array(20), 0)).toEqual([]);
    const started = vad.push(new Float32Array(20).fill(0.2), 20);
    expect(started).toEqual([{ type: "speech.start", timestampMs: 20, rms: expect.any(Number) }]);
    expect(vad.push(new Float32Array(20).fill(0.2), 40)).toEqual([]);
    expect(vad.push(new Float32Array(20), 60)).toEqual([]);
    const ended = vad.push(new Float32Array(20), 80);
    expect(ended).toHaveLength(1);
    const event = ended[0];
    expect(event).toMatchObject({ type: "speech.end", reason: "silence", startedAtMs: 20 });
    if (event?.type === "speech.end") expect(event.samples.length).toBe(100);
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
