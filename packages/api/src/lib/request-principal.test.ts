import { describe, expect, it } from "vitest";
import {
  clientMetadataHasTeamId,
  coerceApiKeyMetadata,
  parseApiKeyMetadata,
  resolveCreateOwner,
  teamApiKeyPathAllowed,
  teamIdFromApiKeyMetadata,
} from "./request-principal.js";

describe("teamIdFromApiKeyMetadata", () => {
  it("reads a non-empty teamId string", () => {
    expect(teamIdFromApiKeyMetadata({ teamId: "team_1", createdBy: "u1" })).toBe("team_1");
  });

  it("ignores a missing, empty, or non-string teamId", () => {
    expect(teamIdFromApiKeyMetadata(null)).toBeUndefined();
    expect(teamIdFromApiKeyMetadata({})).toBeUndefined();
    expect(teamIdFromApiKeyMetadata({ teamId: "" })).toBeUndefined();
    expect(teamIdFromApiKeyMetadata({ teamId: 12 })).toBeUndefined();
  });
});

describe("parseApiKeyMetadata", () => {
  it("parses a JSON object and rejects junk", () => {
    expect(parseApiKeyMetadata('{"teamId":"t1"}')).toEqual({ teamId: "t1" });
    expect(parseApiKeyMetadata("not-json")).toBeNull();
    expect(parseApiKeyMetadata("[1]")).toBeNull();
    expect(parseApiKeyMetadata(null)).toBeNull();
  });

  it("coerces a string or object from verifyApiKey", () => {
    expect(coerceApiKeyMetadata('{"teamId":"t1"}')).toEqual({ teamId: "t1" });
    expect(coerceApiKeyMetadata({ teamId: "t1" })).toEqual({ teamId: "t1" });
    expect(teamIdFromApiKeyMetadata('{"teamId":"t1"}')).toBe("t1");
  });
});

describe("resolveCreateOwner", () => {
  const isMember = async (teamId: string) => teamId === "team_1";

  it("a team principal owns the team even without body.teamId", async () => {
    const result = await resolveCreateOwner({
      principal: { type: "team", id: "team_1" },
      authVia: "apiKey",
      bodyTeamId: undefined,
      userId: "departed-admin",
      isTeamMember: isMember,
    });
    expect(result).toEqual({ ok: true, owner: { type: "team", id: "team_1" } });
  });

  it("a team principal refuses a different teamId", async () => {
    const result = await resolveCreateOwner({
      principal: { type: "team", id: "team_1" },
      authVia: "apiKey",
      bodyTeamId: "team_other",
      userId: "u1",
      isTeamMember: isMember,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.error).toContain("own team");
  });

  it("a personal API key cannot send teamId", async () => {
    const result = await resolveCreateOwner({
      principal: { type: "user", id: "u1" },
      authVia: "apiKey",
      bodyTeamId: "team_1",
      userId: "u1",
      isTeamMember: isMember,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.error).toContain("personal API key");
  });

  it("a cookie session may send teamId when the caller is a member", async () => {
    const result = await resolveCreateOwner({
      principal: { type: "user", id: "u1" },
      authVia: "session",
      bodyTeamId: "team_1",
      userId: "u1",
      isTeamMember: isMember,
    });
    expect(result).toEqual({ ok: true, owner: { type: "team", id: "team_1" } });
  });

  it("a cookie session 404s a team the caller is not on", async () => {
    const result = await resolveCreateOwner({
      principal: { type: "user", id: "u1" },
      authVia: "session",
      bodyTeamId: "team_other",
      userId: "u1",
      isTeamMember: isMember,
    });
    expect(result).toEqual({ ok: false, status: 404, error: "team not found" });
  });

  it("treats teamId: null as personal for a cookie session", async () => {
    const result = await resolveCreateOwner({
      principal: { type: "user", id: "u1" },
      authVia: "stub",
      bodyTeamId: null,
      userId: "u1",
      isTeamMember: isMember,
    });
    expect(result).toEqual({ ok: true, owner: { type: "user", id: "u1" } });
  });
});

describe("clientMetadataHasTeamId", () => {
  it("detects a client stamp and ignores a personal create", () => {
    expect(clientMetadataHasTeamId({ name: "CI", metadata: { teamId: "team_1" } })).toBe(true);
    expect(clientMetadataHasTeamId({ name: "personal" })).toBe(false);
    expect(clientMetadataHasTeamId({ metadata: { note: "x" } })).toBe(false);
  });
});

describe("teamApiKeyPathAllowed", () => {
  const TEAM = "team_1";

  it("allows session, workflow, and GET /api/me only", () => {
    expect(teamApiKeyPathAllowed("/api/me", "GET", TEAM)).toBe(true);
    expect(teamApiKeyPathAllowed("/api/me", "PATCH", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/me/identity-links", "GET", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/sessions", "POST", TEAM)).toBe(true);
    expect(teamApiKeyPathAllowed("/api/workflows/wf_1/runs", "GET", TEAM)).toBe(true);
    expect(teamApiKeyPathAllowed("/api/assistants", "POST", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/credentials", "GET", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/org/settings", "PATCH", TEAM)).toBe(false);
  });

  it("anchors on path segments, not prefixes", () => {
    expect(teamApiKeyPathAllowed("/api/sessions/s1/messages", "POST", TEAM)).toBe(true);
    expect(teamApiKeyPathAllowed("/api/sessionsX", "GET", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/sessions-export", "GET", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/workflowsX/wf_1", "GET", TEAM)).toBe(false);
  });

  it("reaches runtime reads and initialization for its own team only", () => {
    expect(teamApiKeyPathAllowed("/api/workspaces/team_1/runtime", "POST", TEAM)).toBe(true);
    expect(teamApiKeyPathAllowed("/api/workspaces/team_2/runtime", "POST", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/workspaces/team_1/runtime", "GET", TEAM)).toBe(true);
    expect(teamApiKeyPathAllowed("/api/workspaces/team_1/outcomes", "GET", TEAM)).toBe(true);
    expect(teamApiKeyPathAllowed("/api/workspaces/team_1/active-work", "GET", TEAM)).toBe(true);
    expect(teamApiKeyPathAllowed("/api/workspaces/team_1/briefings", "GET", TEAM)).toBe(true);
    expect(teamApiKeyPathAllowed("/api/workspaces/team_2/briefings", "GET", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/workspaces/user/briefings", "GET", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/workspaces/team_2/active-work", "GET", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/workspaces/user/active-work", "GET", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/workspaces/team_2/outcomes", "GET", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/workspaces/user/outcomes", "GET", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/workspaces/team_1/outcomes", "POST", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/workspaces/team_1/runtime/info", "GET", TEAM)).toBe(true);
    expect(teamApiKeyPathAllowed("/api/workspaces/user/runtime", "POST", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/workspaces/team_2/runtime/info", "GET", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/workspaces/team_1/runtime/x", "POST", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/teams/team_1", "GET", TEAM)).toBe(false);
    expect(teamApiKeyPathAllowed("/api/teams/team_1/members", "POST", TEAM)).toBe(false);
  });
});
