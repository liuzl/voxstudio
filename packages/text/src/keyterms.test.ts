import { describe, expect, test } from "bun:test";
import { correctKeyterms } from "./keyterms";

const bank = ["zliu", "legendliu", "zf_001", "zf_002", "af_maple", "laok"];

describe("correctKeyterms", () => {
  test("normalized equality: case and separators collapse onto the canonical id", () => {
    expect(correctKeyterms("帮我把音色换成ZF001，谢谢", bank)).toEqual({
      text: "帮我把音色换成zf_001，谢谢",
      corrections: [{ from: "ZF001", to: "zf_001" }],
    });
    expect(correctKeyterms("换成 zf 001 吧", bank).text).toBe("换成 zf_001 吧");
    expect(correctKeyterms("用 af-maple 读", bank).text).toBe("用 af_maple 读");
  });

  test("a short span contained in exactly one keyterm corrects; ambiguity does not", () => {
    expect(correctKeyterms("换成 zli 的声音", bank).text).toBe("换成 zliu 的声音");
    // "li" sits inside both zliu and legendliu: the model asks, we do not guess.
    expect(correctKeyterms("换成 li 的声音", bank).text).toBe("换成 li 的声音");
  });

  test("tight edit distance for longer spans, unique match only", () => {
    expect(correctKeyterms("换成 zilu 的声音", bank).text).toBe("换成 zliu 的声音");
    expect(correctKeyterms("用 legendlui 说话", bank).text).toBe("用 legendliu 说话");
    // zf_001 vs zf_002 are both within distance 1 of "zf_003": ambiguous, untouched.
    expect(correctKeyterms("换成 zf_003", bank).text).toBe("换成 zf_003");
  });

  test("already-correct ids and plain prose pass through untouched", () => {
    expect(correctKeyterms("换成 zliu 的声音", bank)).toEqual({
      text: "换成 zliu 的声音", corrections: [],
    });
    expect(correctKeyterms("今天天气怎么样？", bank).corrections).toEqual([]);
    expect(correctKeyterms("opus 和 pcm 有什么区别", bank).corrections).toEqual([]);
    expect(correctKeyterms("语速调到 1.5 倍", bank).corrections).toEqual([]);
  });

  test("no keyterms means no work", () => {
    expect(correctKeyterms("换成 ZF001", [])).toEqual({ text: "换成 ZF001", corrections: [] });
  });
});
