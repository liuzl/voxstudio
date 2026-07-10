import { describe, expect, test } from "bun:test";
import cases from "../../../fixtures/config/cases.json" with { type: "json" };
import { engine, parseConfig } from "./index";

function expectSubset(actual: unknown, expected: unknown): void {
  if (typeof expected !== "object" || expected === null || Array.isArray(expected)) {
    expect(actual).toEqual(expected);
    return;
  }
  expect(typeof actual).toBe("object");
  expect(actual).not.toBeNull();
  for (const [key, value] of Object.entries(expected)) {
    expectSubset((actual as Record<string, unknown>)[key], value);
  }
}

describe("shared configuration fixtures", () => {
  for (const fixture of cases) {
    test(fixture.name, () => {
      if ("errorContains" in fixture) {
        expect(() => parseConfig(fixture.raw, fixture.env)).toThrow(fixture.errorContains);
        return;
      }
      expectSubset(parseConfig(fixture.raw, fixture.env), fixture.expected);
    });
  }

  test("missing engines fail with a stable configuration error", () => {
    expect(() => engine(parseConfig(), "nope")).toThrow("engines.nope");
  });
});
