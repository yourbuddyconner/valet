/**
 * `workspaceOfAssistant` — the pure half of the workspace scope.
 *
 * These cases moved here from the switcher's test when the scope stopped
 * being derived state and became held state. The function survives because
 * the open assistant still WINS over the stored key: that is what stops the
 * nav from claiming one workspace while the conversation on screen belongs
 * to another.
 *
 * It returns `undefined` rather than "Personal" when nothing is open, which
 * is the whole reason the stored key exists. Its predecessor answered
 * "Personal" here, and that answer was wrong on every route without an
 * `?assistant=` — `/skills`, `/workflows` and `/events` all read as personal
 * no matter which workspace the reader was in.
 */
import type { AssistantSummary, TeamSummary } from "@valet/api/wire";
import { describe, expect, it } from "vitest";
import {
  PERSONAL,
  resolveWorkspaceKey,
  workspaceKeyForOwner,
} from "./workspace-scope";

const ME = { type: "user", id: "u1" } as const;

function team(id: string): TeamSummary {
  return {
    id,
    orgId: "org_1",
    name: id,
    origin: "local",
    externalId: null,
    createdAt: 0,
    memberCount: 2,
    callerRole: "member",
    defaultModel: null,
  };
}



describe("resolveWorkspaceKey", () => {
  const TEAM = "team_1";

  it("keeps a stored team while membership is still loading", () => {
    // Exactly the race: the org query answered, the teams query has not, so
    // `available` is Personal-only and says nothing about team_1 yet.
    expect(
      resolveWorkspaceKey({
        derived: undefined,
        stored: TEAM,
        available: [PERSONAL],
        membershipKnown: false,
      }),
    ).toBe(TEAM);
  });

  it("keeps a stored team once membership confirms it", () => {
    expect(
      resolveWorkspaceKey({
        derived: undefined,
        stored: TEAM,
        available: [PERSONAL, TEAM],
        membershipKnown: true,
      }),
    ).toBe(TEAM);
  });

  it("drops a team the caller has actually left", () => {
    expect(
      resolveWorkspaceKey({
        derived: undefined,
        stored: TEAM,
        available: [PERSONAL],
        membershipKnown: true,
      }),
    ).toBe(PERSONAL);
  });

  it("lets the open assistant win over the stored key", () => {
    expect(
      resolveWorkspaceKey({
        derived: "team_2",
        stored: TEAM,
        available: [PERSONAL, TEAM],
        membershipKnown: true,
      }),
    ).toBe("team_2");
  });

  it("lets the open assistant win before membership is known", () => {
    // Arriving on a team conversation from a notification must move the
    // scope immediately, not after two queries settle.
    expect(
      resolveWorkspaceKey({
        derived: "team_2",
        stored: PERSONAL,
        available: [PERSONAL],
        membershipKnown: false,
      }),
    ).toBe("team_2");
  });
});

describe("workspaceKeyForOwner (deep-link scope adoption)", () => {
  it("maps a team-owned resource to that team's key", () => {
    expect(workspaceKeyForOwner({ type: "team", id: "team_9" })).toBe("team_9");
  });

  it("maps a user-owned resource to the personal workspace", () => {
    expect(workspaceKeyForOwner({ type: "user", id: "u1" })).toBe(PERSONAL);
  });

  it("maps an org-owned resource to the personal workspace (no switcher scope for org)", () => {
    expect(workspaceKeyForOwner({ type: "org", id: "org1" })).toBe(PERSONAL);
  });

  it("is undefined while the owner is unknown, so adoption waits for the data", () => {
    expect(workspaceKeyForOwner(undefined)).toBeUndefined();
  });
});
