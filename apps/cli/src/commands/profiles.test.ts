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

test("forwards explicit design generation parameters", async () => {
  const fetch = async (_url: Request | URL | string, init?: RequestInit) => {
    expect(JSON.parse(String(init?.body))).toEqual({
      id: "tuned", description: "warm voice", anchor_text: "锚点", seed: 43, cfg_value: 2.5, timesteps: 12,
    });
    return Response.json({ id: "tuned" });
  };
  const io = { out: () => {}, err: () => {} };
  await runProfiles([
    "create", "tuned", "--description", "warm voice", "--anchor-text", "锚点", "--seed", "43",
    "--cfg", "2.5", "--timesteps", "12",
  ], parseConfig(), io, fetch);
});

test("validates design generation parameters", async () => {
  const io = { out: () => {}, err: () => {} };
  await expect(runProfiles([
    "create", "bad", "--description", "voice", "--anchor-text", "锚点", "--seed", "1", "--cfg", "NaN",
  ], parseConfig(), io)).rejects.toThrow("profiles: --cfg must be a number");
  await expect(runProfiles([
    "create", "bad", "--description", "voice", "--anchor-text", "锚点", "--seed", "1", "--timesteps", "1.5",
  ], parseConfig(), io)).rejects.toThrow("profiles: --timesteps must be a safe integer");
});

test("reproduces a profile from its recorded generation settings", async () => {
  const fetch = async (url: Request | URL | string, init?: RequestInit) => {
    if (!init?.method) {
      expect(String(url)).toEndWith("/v1/voices/source");
      return Response.json({
        id: "source", prompt_text: "锚点",
        design_profile: { description: "warm voice", seed: 43, cfg_value: 2.5, timesteps: 12, model: "test" },
      });
    }
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      id: "copy", description: "warm voice", anchor_text: "锚点", seed: 43, cfg_value: 2.5, timesteps: 12,
    });
    return Response.json({ id: "copy" });
  };
  const out: string[] = [];
  await runProfiles(["reproduce", "source", "copy"], parseConfig(), { out: line => out.push(line), err: () => {} }, fetch);
  expect(out).toEqual(["{\"id\":\"copy\"}"]);
});

test("does not reproduce profiles without a recorded anchor text", async () => {
  const fetch = async () => Response.json({
    id: "source", design_profile: { description: "warm voice", seed: 43, cfg_value: 2.5, timesteps: 12, model: "test" },
  });
  const io = { out: () => {}, err: () => {} };
  await expect(runProfiles(["reproduce", "source", "copy"], parseConfig(), io, fetch))
    .rejects.toThrow("profiles reproduce: source has no anchor text");
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
