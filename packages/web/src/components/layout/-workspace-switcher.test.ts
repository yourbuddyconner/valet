import type { TeamSummary } from "@valet/api/wire";
import { describe, expect, it } from "vitest";
import { workspaceOptions } from "./workspace-switcher";
const team: TeamSummary = { id: "t1", name: "Platform", orgId: "org", createdAt: 1, memberCount: 1, callerRole: "member", origin: "local", externalId: null, defaultModel: null };
describe("workspaceOptions", () => {
  it("lists personal and team ownership without querying assistant profiles", () => {
    expect(workspaceOptions([team])).toEqual([
      { key: "user", label: "Personal", isTeam: false },
      { key: "t1", label: "Platform", isTeam: true },
    ]);
  });
  it("offers Personal when no teams are available", () => {
    expect(workspaceOptions([]).map(option => option.key)).toEqual(["user"]);
  });
});
