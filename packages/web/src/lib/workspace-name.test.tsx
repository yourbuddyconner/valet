// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useWorkspaceName } from "./workspace-name";
vi.mock("~/api/settings", () => ({ useTeams: () => ({ data: { teams: [{ id: "team1", name: "Platform" }] } }) }));
describe("workspace names", () => {
  it("names the requested workspace and never falls back to another team's name", () => {
    const personal = renderHook(() => useWorkspaceName({ ownerType: "user", ownerId: "u1" }));
    expect(personal.result.current).toBe("your personal workspace");
    const team = renderHook(() => useWorkspaceName({ ownerType: "team", ownerId: "team1" }));
    expect(team.result.current).toBe("Platform");
    const inaccessible = renderHook(() => useWorkspaceName({ ownerType: "team", ownerId: "missing" }));
    expect(inaccessible.result.current).toBe("this team workspace");
  });
});
