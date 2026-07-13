import { describe, expect, test } from "bun:test";
import { bargeIns, evaluateGate, scoreDoubleTalk, syntheticSource, type ScenarioResult } from "./aec-measure";

// These score the speaker-duplex gate. A silent error here would report a passing
// AEC that self-interrupts, or a failing one that works, so they are tested without
// hardware in the loop.

const captureRate = 16_000;

function speech(milliseconds: number, amplitude: number): Float32Array {
  const samples = new Float32Array(captureRate * milliseconds / 1_000);
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = amplitude * Math.sin(2 * Math.PI * 200 * index / captureRate);
  }
  return samples;
}

function concat(parts: Float32Array[]): Float32Array {
  const output = new Float32Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

describe("barge-in detection", () => {
  test("reports no barge-in for a capture below the CLI's VAD threshold", () => {
    // Residual echo well under the 0.01 threshold must not read as user speech.
    expect(bargeIns(speech(3_000, 0.002))).toEqual([]);
  });

  test("reports one barge-in for a single sustained utterance", () => {
    const capture = concat([speech(1_000, 0), speech(1_000, 0.2), speech(2_000, 0)]);
    expect(bargeIns(capture)).toHaveLength(1);
  });

  test("ignores a burst shorter than the confirmation duration, as the product now does", () => {
    // Before the provisional-barge-in policy, `listen` aborted the turn on `speech.start` —
    // the first frame over the threshold — so this 100ms burst killed a whole reply. It now
    // interrupts only on `speech.confirmed` (minSpeechMs of voiced audio), which a transient
    // echo spike never reaches; the burst is recorded as a false barge-in instead.
    const capture = concat([speech(1_000, 0), speech(100, 0.2), speech(2_000, 0)]);
    expect(bargeIns(capture)).toEqual([]);
  });
});

describe("double-talk scoring", () => {
  const cues = [{ startMs: 1_000, endMs: 3_500 }, { startMs: 6_500, endMs: 9_000 }];

  test("counts a detection inside a cue as heard, and reports its latency", () => {
    const score = scoreDoubleTalk(cues, [1_400, 6_900]);
    expect(score).toMatchObject({ detected: 2, missed: 0, falseBargeIns: 0 });
    expect(score.latenciesMs).toEqual([400, 400]);
  });

  test("counts a cue with no detection as a missed barge-in", () => {
    expect(scoreDoubleTalk(cues, [1_400])).toMatchObject({ detected: 1, missed: 1, falseBargeIns: 0 });
  });

  test("counts a detection outside every cue as a self-interruption", () => {
    expect(scoreDoubleTalk(cues, [1_400, 5_000, 6_900])).toMatchObject({
      detected: 2, missed: 0, falseBargeIns: 1,
    });
  });

  test("admits a detection that lands after the cue window while the VAD is still confirming", () => {
    expect(scoreDoubleTalk(cues, [4_000])).toMatchObject({ detected: 1, missed: 1 });
  });

  test("never lets one detection satisfy two cues", () => {
    // Without claiming, a single stray detection between two cues could mark both heard.
    expect(scoreDoubleTalk([{ startMs: 1_000, endMs: 2_000 }, { startMs: 2_100, endMs: 3_000 }], [2_050]))
      .toMatchObject({ detected: 1, missed: 1, falseBargeIns: 0 });
  });
});

describe("gate verdict", () => {
  const real = "outputs/reply.wav";
  function results(overrides: Partial<Record<string, Record<string, number>>> = {}): ScenarioResult[] {
    return [
      { scenario: "self-interruption", metrics: { echoAttributablePerMinute: 0, ...overrides["self-interruption"] } },
      { scenario: "capture-to-mute", metrics: { trials: 5, observed: 5, invalidTrials: 0, ...overrides["capture-to-mute"] } },
      { scenario: "double-talk", metrics: { cues: 6, ...overrides["double-talk"] } },
    ];
  }

  test("passes only when every scenario ran on real speech and nothing self-interrupted", () => {
    expect(evaluateGate(results(), real)).toEqual({ status: "pass", reasons: [] });
  });

  test("fails on any self-interruption, which is the one target this phase states", () => {
    const gate = evaluateGate(results({ "self-interruption": { echoAttributablePerMinute: 1.41 } }), real);
    expect(gate.status).toBe("fail");
    expect(gate.reasons[0]).toContain("1.41/min");
  });

  test("refuses to pass a run whose far-end was synthetic", () => {
    expect(evaluateGate(results(), syntheticSource).status).toBe("incomplete");
  });

  test("refuses to pass when a scenario was never measured", () => {
    const gate = evaluateGate(results().filter(result => result.scenario !== "double-talk"), real);
    expect(gate).toMatchObject({ status: "incomplete", reasons: ["double-talk was not measured"] });
  });

  test("refuses to pass an incomplete capture-to-mute run", () => {
    // Trials that never observed silence must not read as a clean latency result.
    const gate = evaluateGate(results({ "capture-to-mute": { trials: 5, observed: 2, invalidTrials: 3 } }), real);
    expect(gate.status).toBe("incomplete");
    expect(gate.reasons[0]).toContain("2/5");
  });

  test("refuses to pass when self-interruption has no silent baseline to subtract", () => {
    const gate = evaluateGate(results({ "self-interruption": { echoAttributablePerMinute: Number.NaN } }), real);
    expect(gate.status).toBe("incomplete");
  });

  test("never passes a quick run, even when every scenario happens to look clean", () => {
    // A few seconds of echo cannot establish a per-minute rate. The convenience flag must
    // not become a way to certify a route.
    const gate = evaluateGate(results(), real, true);
    expect(gate.status).toBe("incomplete");
    expect(gate.reasons[0]).toContain("--quick");
  });

  test("still fails a quick run that self-interrupts, so a smoke test can catch a regression", () => {
    const gate = evaluateGate(results({ "self-interruption": { echoAttributablePerMinute: 3 } }), real, true);
    expect(gate.status).toBe("fail");
  });
});
