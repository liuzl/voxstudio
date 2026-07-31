import { describe, expect, test } from "bun:test";
import { useTheme } from "./theme";

describe("theme state", () => {
  test("imports and changes preference without browser globals", () => {
    const previous = useTheme.getState().preference;
    try {
      useTheme.getState().setPreference("dark");
      expect(useTheme.getState().preference).toBe("dark");
      useTheme.getState().setPreference("system");
      expect(useTheme.getState().preference).toBe("system");
    } finally {
      useTheme.setState({ preference: previous });
    }
  });
});
