import { describe, expect, test } from "bun:test";
import { agentPath, agentRouteFromPath } from "./App";

describe("Agent Builder routes", () => {
  test("keeps the legacy detail URL as Configuration", () => {
    expect(agentRouteFromPath("/agents/customer-support")).toEqual({
      id: "customer-support",
      section: "configuration",
    });
  });

  test("round-trips encoded ids and durable sections", () => {
    const path = agentPath("support.zh", "speech");
    expect(path).toBe("/agents/support.zh/speech");
    expect(agentRouteFromPath(path)).toEqual({ id: "support.zh", section: "speech" });
    expect(agentRouteFromPath(agentPath("support.zh", "deployment"))).toEqual({
      id: "support.zh",
      section: "deployment",
    });
  });

  test("refuses unknown sections and malformed ids", () => {
    expect(agentRouteFromPath("/agents/support/statistics")).toBeUndefined();
    expect(agentRouteFromPath("/agents/%E0%A4%A/configuration")).toBeUndefined();
  });
});
