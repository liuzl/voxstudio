import { describe, expect, test } from "bun:test";
import chunks from "../../../fixtures/text/chunks.json" with { type: "json" };
import estimates from "../../../fixtures/text/estimate.json" with { type: "json" };
import sanitization from "../../../fixtures/text/sanitize.json" with { type: "json" };
import { applyPronunciations, chunkText, estSeconds, sanitizeForTts, SentenceAssembler } from "./index";

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

describe("applyPronunciations", () => {
  test("longest term first, every occurrence, case-insensitive latin", () => {
    const entries = { "VoxStudio Pro": "沃克斯 Pro", "VoxStudio": "沃克斯" };
    expect(applyPronunciations("用 voxstudio 和 VoxStudio Pro。", entries)).toBe("用 沃克斯 和 沃克斯 Pro。");
  });

  test("regex metacharacters in terms are literal", () => {
    expect(applyPronunciations("价格是 C++ 之上", { "C++": "西加加" })).toBe("价格是 西加加 之上");
  });

  test("replacement tokens in readings are literal — a spoken reading must not rearrange the reply", () => {
    // Readings are user-controlled at runtime (remember_pronunciation): $&, $' and $`
    // would otherwise expand to the match and its surroundings.
    expect(applyPronunciations("前文 X 后文", { X: "$&$'$`" })).toBe("前文 $&$'$` 后文");
    expect(applyPronunciations("A X B", { X: "$1" })).toBe("A $1 B");
  });
});

describe("oversized-sentence word boundaries", () => {
  // No chunk seam may ever land inside a Latin/number run: the halves would be
  // synthesized independently and spliced.
  test("never splits an embedded Latin word", () => {
    const input = "这个项目使用VoxStudio进行语音合成然后再把结果保存到本地磁盘上面供后续使用没有任何标点符号来断句";
    const chunks = chunkText(input, { maxSeconds: 3, firstMaxSeconds: 3 });
    expect(chunks.join("")).toBe(input);
    for (const chunk of chunks) {
      expect(chunk.startsWith("Studio")).toBe(false);
      expect(chunk.endsWith("Vox")).toBe(false);
      expect(chunk.endsWith("VoxStu")).toBe(false);
    }
  });

  test("takes a clause break even in the first half of the window", () => {
    const input = "先说结论，然后是一大段完全没有任何停顿标点的详细展开内容一直说下去不停顿。";
    const chunks = chunkText(input, { maxSeconds: 4, firstMaxSeconds: 4 });
    expect(chunks.join("")).toBe(input);
    expect(chunks[0]).toBe("先说结论，");
  });

  test("prefers a CJK function-character boundary over an arbitrary split", () => {
    const input = "我们昨天讨论过的那个方案其实还有很多细节需要进一步确认才能开始动手实现整个系统";
    const chunks = chunkText(input, { maxSeconds: 4, firstMaxSeconds: 4 });
    expect(chunks.join("")).toBe(input);
    const seam = Array.from(chunks[0] as string).pop() as string;
    const nextStart = Array.from(chunks[1] as string)[0] as string;
    expect("的了着过地得吧吗呢啊呀嘛哦嗯".includes(seam) || "是在和与或但而就都也还又只更把被让从向对给为于跟同".includes(nextStart)).toBe(true);
  });
});
