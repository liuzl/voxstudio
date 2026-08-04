import { describe, expect, test } from "bun:test";
import { groupVoiceEntries } from "./VoicesPanel";

describe("voice replica grouping", () => {
  test("groups one display voice across engine-local registries without losing attribution", () => {
    expect(groupVoiceEntries([
      { id: "shuber", engine: "sz_ws_tts" },
      { id: "laok", engine: "tts" },
      { id: "shuber", engine: "tts" },
    ])).toEqual([
      {
        id: "shuber",
        replicas: [
          { id: "shuber", engine: "sz_ws_tts" },
          { id: "shuber", engine: "tts" },
        ],
      },
      { id: "laok", replicas: [{ id: "laok", engine: "tts" }] },
    ]);
  });
});
