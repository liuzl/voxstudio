import { describe, expect, test } from "bun:test";
import chunks from "../../../fixtures/text/chunks.json" with { type: "json" };
import estimates from "../../../fixtures/text/estimate.json" with { type: "json" };
import sanitization from "../../../fixtures/text/sanitize.json" with { type: "json" };
import { chunkText, estSeconds, sanitizeForTts, SentenceAssembler } from "./index";

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

describe("SentenceAssembler.takeClause", () => {
  test("cuts at the earliest clause boundary that already speaks long enough", () => {
    const assembler = new SentenceAssembler();
    assembler.push("今天的天气非常不错，适合出去");
    expect(assembler.takeClause(1.2)).toBe("今天的天气非常不错，");
    // The remainder stays buffered for the normal sentence rule.
    expect(assembler.push("走走。")).toEqual(["适合出去走走。"]);
  });

  test("waits while the prefix is still too short to seam", () => {
    const assembler = new SentenceAssembler();
    assembler.push("好的，");
    expect(assembler.takeClause(1.2)).toBeUndefined();
    expect(assembler.push("我来帮你查一下。")).toEqual(["好的，我来帮你查一下。"]);
  });

  test("ASCII separators inside numbers are not boundaries, and a trailing one cannot cut", () => {
    const assembler = new SentenceAssembler();
    assembler.push("The total came to 12,345 dollars overall,");
    // "12," is ruled out by the digit guard; the final comma has no lookahead yet.
    expect(assembler.takeClause(0.5)).toBeUndefined();
    assembler.push(" which surprised everyone");
    expect(assembler.takeClause(0.5)).toBe("The total came to 12,345 dollars overall,");
  });

  test("a closing quote after the boundary rides with its clause", () => {
    const assembler = new SentenceAssembler();
    assembler.push("他说“稍等一下我马上到，”然后就挂了");
    expect(assembler.takeClause(1.2)).toBe("他说“稍等一下我马上到，”");
  });
});

describe("SentenceAssembler.takeClause boundary edges", () => {
  test("a boundary at the buffer's edge waits for continuation", () => {
    const assembler = new SentenceAssembler();
    assembler.push("今天的天气非常不错，");
    // Nothing follows yet: the cut would strand the chunk in the stream's lookahead hold.
    expect(assembler.takeClause(1.2)).toBeUndefined();
    assembler.push("适合");
    expect(assembler.takeClause(1.2)).toBe("今天的天气非常不错，");
  });

  test("Unicode digits guard ASCII separators like ASCII digits do", () => {
    const assembler = new SentenceAssembler();
    assembler.push("المجموع ١٢,٣٤٥ ريال تقريبا يا صديقي,");
    assembler.push(" وهذا كثير");
    // "١٢," is inside a number; the clause comma later is the boundary.
    expect(assembler.takeClause(0.5)).toBe("المجموع ١٢,٣٤٥ ريال تقريبا يا صديقي,");
  });
});
