import { describe, expect, it } from "vitest";
import { orchestratorName } from "./assistant-name";

describe("assistant display names", () => {
  it.each([undefined, null, "", "   "])("uses the exact fallback for %s", (name) => {
    expect(orchestratorName(name)).toBe("Default Orchestrator");
  });

  it("uses the configured name, including on a default assistant", () => {
    expect(orchestratorName("  Sentinel  ")).toBe("Sentinel");
  });

});
