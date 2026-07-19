import { describe, expect, test } from "bun:test";
import { PlaybackTimeline } from "./audio";

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
});
