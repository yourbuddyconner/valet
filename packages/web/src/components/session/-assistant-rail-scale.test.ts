import type { AssistantSummary } from "@valet/api/wire";
import { describe, expect, it } from "vitest";
import { assistantLabel } from "~/lib/assistant-name";
function own(id: string, extra: Partial<AssistantSummary> = {}): AssistantSummary {
  return { id, sessionId: `assistant:${id}`, owner: { type: "user", id: "me" }, isDefault: false, createdAt: 1, ...extra };
}
describe("assistantLabel", () => {
  it("uses the name someone chose", () => {
    expect(assistantLabel(own("a", { name: "Aurora" }))).toBe("Aurora");
  });

  it("says an unnamed assistant is untitled rather than inventing a name", () => {
    expect(assistantLabel(own("a"))).toBe("Untitled assistant");
    expect(assistantLabel(own("a", { name: "  " }))).toBe("Untitled assistant");
  });

  it("names an unnamed default for what it is", () => {
    expect(assistantLabel(own("a", { isDefault: true }))).toBe("Default Orchestrator");
  });
});
