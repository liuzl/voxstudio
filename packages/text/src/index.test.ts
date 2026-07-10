import { describe, expect, test } from "bun:test";
import chunks from "../../../fixtures/text/chunks.json" with { type: "json" };
import estimates from "../../../fixtures/text/estimate.json" with { type: "json" };
import sanitization from "../../../fixtures/text/sanitize.json" with { type: "json" };
import { chunkText, estSeconds, sanitizeForTts } from "./index";

describe("shared text fixtures", () => {
  for (const fixture of sanitization) {
    test(`sanitize: ${fixture.name}`, () => {
      expect(sanitizeForTts(fixture.input)).toEqual({
        text: fixture.clean,
        dropped: fixture.dropped,
      });
    });
  }

  for (const fixture of estimates) {
    test(`estimate: ${fixture.name}`, () => {
      const expected = "sameAs" in fixture ? estSeconds(fixture.sameAs) : fixture.expected;
      expect(estSeconds(fixture.input)).toBeCloseTo(expected, 12);
    });
  }

  for (const fixture of chunks) {
    test(`chunk: ${fixture.name}`, () => {
      const maxSeconds = "capText" in fixture
        ? estSeconds(fixture.capText)
        : fixture.maxSeconds;
      const firstMaxSeconds = "firstCapText" in fixture
        ? estSeconds(fixture.firstCapText)
        : "firstMaxSeconds" in fixture ? fixture.firstMaxSeconds : undefined;
      const options = firstMaxSeconds === undefined
        ? { maxSeconds }
        : { maxSeconds, firstMaxSeconds };
      expect(chunkText(fixture.input, options)).toEqual(fixture.expected);
    });
  }
});

describe("chunking invariants", () => {
  test("never drops or reorders normalized text", () => {
    const inputs = [
      `第一句。${"长".repeat(250)}。收尾。`,
      "Speech synthesis has improved. Voices sound natural now. Anyone can use them.".repeat(4),
      "Mixed 中英 text。With English. And 中文句子。",
    ];
    for (const input of inputs) {
      const budgets: Array<readonly [number, number]> = [[30, 4.5], [2, 0.8], [1, 1], [40, 90]];
      for (const [maxSeconds, firstMaxSeconds] of budgets) {
        expect(chunkText(input, { maxSeconds, firstMaxSeconds }).join(""))
          .toBe(input.trim().split(/\s+/u).join(" "));
      }
    }
  });

  test("a thousand chunks ramp without arithmetic overflow", () => {
    const input = "啊".repeat(5_000);
    const result = chunkText(input, { maxSeconds: 0.5, firstMaxSeconds: 0.5 });
    expect(result.length).toBeGreaterThan(1_024);
    expect(result.join("")).toBe(input);
  });

  test("each emitted chunk bounds the growth of the next", () => {
    const input = `${"甲".repeat(20)}。${"乙".repeat(15)}。${"丙".repeat(55)}。${"丁".repeat(55)}。`;
    const spans = chunkText(input, { maxSeconds: 30, firstMaxSeconds: 4.5, growth: 2 })
      .map(estSeconds);
    for (let index = 1; index < spans.length; index += 1) {
      expect(spans[index] as number).toBeLessThanOrEqual((spans[index - 1] as number) * 2 * (1 + 1e-9));
    }
  });

  test("large unpunctuated input remains practical", () => {
    const input = "啊".repeat(100_000);
    const started = performance.now();
    expect(chunkText(input, { maxSeconds: 30 }).join("")).toBe(input);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});
