import { describe, expect, test } from "bun:test";
import { parseConfig } from "@voxstudio/config";
import { runProfiles } from "./profiles";

test("creates a design profile", async () => {
  const out: string[] = [];
  const fetch = async (_url: Request | URL | string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({ id: "calm", description: "calm voice", anchor_text: "锚点", seed: 42 });
    return Response.json({ id: "calm" });
  };
  await runProfiles(["create", "calm", "--description", "calm voice", "--anchor-text", "锚点", "--seed", "42"],
    parseConfig(), { out: line => out.push(line), err: () => {} }, fetch);
  expect(out).toEqual(["{\"id\":\"calm\"}"]);
});
