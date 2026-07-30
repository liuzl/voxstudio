import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { en, type MessageKey } from "./en";
import { allCatalogs, resolveLocale, t } from "./index";

const keys = Object.keys(en) as MessageKey[];

/** All app source (excluding this directory and tests) concatenated, for usage scans. */
function corpus(): string {
  const parts: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        if (name !== "i18n" && name !== "node_modules") walk(path);
      } else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
        parts.push(readFileSync(path, "utf8"));
      }
    }
  };
  walk(join(import.meta.dir, ".."));
  return parts.join("\n");
}

const placeholders = (text: string): string[] =>
  [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1] ?? "").sort();

describe("i18n catalogs", () => {
  test("no dead keys: every key appears in app source", () => {
    // Substring match is deliberately lenient — a short key contained in a longer
    // string passes — so anything flagged here is definitely dead.
    const source = corpus();
    const dead = keys.filter(key => !source.includes(key));
    expect(dead).toEqual([]);
  });

  test("every catalog covers the full key set", () => {
    for (const [locale, catalog] of Object.entries(allCatalogs)) {
      const missing = keys.filter(key => !(key in catalog));
      const extra = Object.keys(catalog).filter(key => !(key in en));
      expect({ locale, missing, extra }).toEqual({ locale, missing: [], extra: [] });
    }
  });

  test("placeholders survive translation", () => {
    const broken: string[] = [];
    for (const [locale, catalog] of Object.entries(allCatalogs)) {
      for (const key of keys) {
        const translated = catalog[key];
        if (translated !== undefined && placeholders(translated).join(",") !== placeholders(key).join(","))
          broken.push(`${locale}: ${key}`);
      }
    }
    expect(broken).toEqual([]);
  });

  test("t() falls back to English for unresolvable locales and formats params", () => {
    expect(resolveLocale("en")).toBe("en");
    expect(t("共 {n} 条", { n: 3 })).toContain("3");
  });
});
