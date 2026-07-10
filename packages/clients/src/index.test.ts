import { describe, expect, test } from "bun:test";
import errors from "../../../fixtures/contracts/errors.json" with { type: "json" };
import transcripts from "../../../fixtures/contracts/transcripts.json" with { type: "json" };
import chatContent from "../../../fixtures/contracts/chat-content.json" with { type: "json" };
import { extractChatContent, normalizeEngineError, parseTranscript } from "./index";

describe("shared engine fixtures", () => {
  for (const fixture of errors) {
    test(`error: ${fixture.name}`, () => {
      const result = normalizeEngineError(fixture.status, fixture.body);
      expect(result.status).toBe(fixture.status);
      expect(result.code).toBe(fixture.expected.code);
      if ("message" in fixture.expected) expect(result.message).toBe(fixture.expected.message);
      if ("messageContains" in fixture.expected) {
        expect(result.message).toContain(fixture.expected.messageContains);
      }
      expect(result.type).toBe("type" in fixture.expected ? fixture.expected.type : undefined);
    });
  }

  for (const fixture of transcripts) {
    test(`transcript: ${fixture.name}`, () => {
      expect(parseTranscript(fixture.raw)).toEqual(fixture.expected);
    });
  }

  for (const fixture of chatContent) {
    test(`chat: ${fixture.name}`, () => {
      expect(extractChatContent(fixture.payload)).toBe(fixture.expected);
    });
  }
});
