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

test("lists and removes only profile voices", async () => {
  const out: string[] = [];
  const fetch = async (url: Request | URL | string, init?: RequestInit) => {
    if (String(url).endsWith("/v1/voices") && !init?.method) {
      return Response.json({ voices: [{ id: "profile", design_profile: { description: "calm", seed: 42, cfg_value: 2, timesteps: 10, model: "test" } }, { id: "plain" }] });
    }
    if (String(url).endsWith("/v1/voices/profile") && !init?.method) {
      return Response.json({ id: "profile", design_profile: { description: "calm", seed: 42, cfg_value: 2, timesteps: 10, model: "test" } });
    }
    expect(init?.method).toBe("DELETE");
    return Response.json({ id: "profile", deleted: true });
  };
  const io = { out: (line: string) => out.push(line), err: () => {} };
  await runProfiles(["list"], parseConfig(), io, fetch);
  await runProfiles(["rm", "profile"], parseConfig(), io, fetch);
  expect(out).toEqual(["{\"id\":\"profile\",\"design_profile\":{\"description\":\"calm\",\"seed\":42,\"cfg_value\":2,\"timesteps\":10,\"model\":\"test\"}}", "deleted profile"]);
});

test("refuses to show or remove a non-profile voice", async () => {
  let deletes = 0;
  const fetch = async (_url: Request | URL | string, init?: RequestInit) => {
    if (init?.method === "DELETE") deletes += 1;
    return Response.json({ id: "plain" });
  };
  const io = { out: () => {}, err: () => {} };
  await expect(runProfiles(["show", "plain"], parseConfig(), io, fetch))
    .rejects.toThrow("profiles: plain is not a design profile");
  await expect(runProfiles(["rm", "plain"], parseConfig(), io, fetch))
    .rejects.toThrow("profiles: plain is not a design profile");
  expect(deletes).toBe(0);
});
