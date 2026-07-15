import { describe, expect, test } from "bun:test";
import cases from "../../../fixtures/config/cases.json" with { type: "json" };
import { engine, engineByCapability, enginesOfKind, parseConfig, roleInstance } from "./index";

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

describe("engine registry", () => {
  const registry = {
    engines: {
      kokoro: { kind: "tts", base_url: "http://k.test", model: "kokoro", capabilities: ["preset", "fast"] },
      voxcpm2: { kind: "tts", base_url: "http://v.test", model: "voxcpm2", capabilities: ["clone", "design"] },
      sensevoice: { kind: "asr", base_url: "http://s.test", model: "sv" },
      gemma: { kind: "llm", base_url: "http://g.test", model: "gemma" },
    },
    roles: { tts: "kokoro", asr: "sensevoice", llm: "gemma" },
  };

  test("roles resolve to their instances and legacy role-named engines still work", () => {
    const config = parseConfig(registry);
    expect(engine(config, "tts").baseUrl).toBe("http://k.test");
    expect(roleInstance(config, "tts")).toBe("kokoro");
    // No roles section: an instance named like the role is the default (today's configs).
    const legacy = parseConfig({ engines: { tts: { base_url: "http://legacy.test" } } });
    expect(engine(legacy, "tts").baseUrl).toBe("http://legacy.test");
    expect(legacy.engines.tts?.kind).toBe("tts");
    const longform = parseConfig({ engines: { asr_longform: { base_url: "http://lf.test" } } });
    expect(longform.engines.asr_longform?.kind).toBe("asr");
  });

  test("capability routing prefers the role default, then declaration order", () => {
    const config = parseConfig(registry);
    // kokoro is the tts default but lacks clone; voxcpm2 declares it.
    expect(engineByCapability(config, "tts", "clone")?.[0]).toBe("voxcpm2");
    expect(engineByCapability(config, "tts", "fast")?.[0]).toBe("kokoro");
    expect(engineByCapability(config, "tts", "nonexistent")).toBeUndefined();
    const tts = enginesOfKind(config, "tts").map(([name]) => name);
    expect(tts).toContain("kokoro");
    expect(tts).toContain("voxcpm2");
    expect(tts[0]).toBe("kokoro"); // role default sorts first
  });

  test("an assigned role drops the undeclared default-named phantom", () => {
    const config = parseConfig(registry);
    // roles.tts = kokoro and no user-declared `tts` instance: the built-in default
    // must not appear as a routable engine.
    expect(config.engines.tts).toBeUndefined();
    // asr/llm roles are also assigned here; unassigned defaults would remain.
    const partial = parseConfig({ engines: { kokoro: { kind: "tts", base_url: "http://k.test" } }, roles: { tts: "kokoro" } });
    expect(partial.engines.tts).toBeUndefined();
    expect(partial.engines.asr?.baseUrl).toContain("127.0.0.1");
  });

  test("rejects unknown role targets and malformed kinds", () => {
    expect(() => parseConfig({ engines: {}, roles: { tts: "ghost" } })).toThrow("unknown engine");
    expect(() => parseConfig({ engines: { x: { base_url: "http://x", kind: "video" } } })).toThrow("kind");
    expect(() => parseConfig({ engines: { x: { base_url: "http://x", capabilities: "clone" } } })).toThrow("list of strings");
  });
});
