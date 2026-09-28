/**
 * GET /api/sessions — assistant-centered web UI decision 8: the list
 * excludes orchestrator ids and child ids server-side, seeded here directly
 * (no engine turns needed) — a standalone row, an orchestrator row, and a
 * child row, asserting only the standalone one comes back.
 */
import { describe, it, expect } from "vitest";
import { bootTestApi } from "./_setup.js";
import { assistantSessionId } from "@valet/engine";
import { agentSessions, childWatches, teams, teamMembers } from "../schema/index.js";
import type { ListSessionsResponse } from "../wire/types.js";

describe("GET /api/sessions: standalone-only filter", () => {
  it("lists archived team work only for current team members", async () => {
    const api = await bootTestApi();
    try {
      const { db } = api.providers;
      await db.insert(teams).values({ id: "work-team", orgId: "local-org", name: "Work", createdAt: 1 });
      await db.insert(teamMembers).values({ teamId: "work-team", userId: "test-member", role: "member" });
      await db.insert(agentSessions).values({
        id: "archived-team-child", userId: "local-user", orgId: "local-org", workspace: "/tmp/work",
        title: "Finished work", status: "archived", ownerType: "team", ownerId: "work-team", createdAt: 1, updatedAt: 1,
      });
      const url = `${api.baseUrl}/api/sessions?discovery=true&ownerType=team&ownerId=work-team`;
      expect((await fetch(url)).status).toBe(404);
      const response = await fetch(url, { headers: { "x-valet-test-user-id": "test-member" } });
      expect(response.status).toBe(200);
      const body = await response.json() as ListSessionsResponse;
      expect(body.sessions.map(row => row.id)).toEqual(["archived-team-child"]);
      expect(body.sessions[0].status).toBe("archived");
      const personal = await fetch(`${api.baseUrl}/api/sessions?discovery=true&ownerType=user&ownerId=local-user`);
      expect((await personal.json() as ListSessionsResponse).sessions).toEqual([]);
    } finally {
      await api.cleanup();
    }
  });

  it("excludes every assistant row and child rows, keeps standalone rows", async () => {
    const api = await bootTestApi();
    try {
      const { db } = api.providers;
      const now = Date.now();
      const defaultAssistantId = assistantSessionId("asst_default");
      const secondAssistantId = assistantSessionId("asst_second");

      await db
        .insert(agentSessions)
        .values([
          {
            id: "standalone-1",
            userId: "local-user",
            orgId: "local-org",
            workspace: "/tmp/standalone-1",
            title: "Standalone session",
            status: "active",
            ownerType: "user",
            ownerId: "local-user",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: defaultAssistantId,
            userId: "local-user",
            orgId: "local-org",
            workspace: "/tmp/assistant-default",
            title: "Assistant",
            status: "active",
            ownerType: "user",
            ownerId: "local-user",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: secondAssistantId,
            userId: "local-user",
            orgId: "local-org",
            workspace: "/tmp/assistant-second",
            title: "Research",
            status: "active",
            ownerType: "user",
            ownerId: "local-user",
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "child-1",
            userId: "local-user",
            orgId: "local-org",
            workspace: "/tmp/child-1",
            title: "Delegated work",
            status: "active",
            ownerType: "user",
            ownerId: "local-user",
            createdAt: now,
            updatedAt: now,
          },
        ]);

      await db
        .insert(childWatches)
        .values({
          childSessionId: "child-1",
          queueItemId: "qi-1",
          parentSessionId: defaultAssistantId,
          parentThreadId: "th-1",
          actorUserId: "local-user",
          orgId: "local-org",
          settled: false,
          createdAt: now,
        });

      const res = await fetch(`${api.baseUrl}/api/sessions`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as ListSessionsResponse;

      expect(body.sessions.map((s) => s.id)).toEqual(["standalone-1"]);

      const scope = "discovery=true&ownerType=user&ownerId=local-user&limit=1";
      const firstResponse = await fetch(`${api.baseUrl}/api/sessions?${scope}`);
      expect(firstResponse.status).toBe(200);
      const first = await firstResponse.json() as ListSessionsResponse;
      expect(first.sessions.map(row => row.id)).toEqual(["standalone-1"]);
      expect(first.nextCursor).toBeTruthy();
      const secondResponse = await fetch(`${api.baseUrl}/api/sessions?${scope}&cursor=${encodeURIComponent(first.nextCursor ?? "")}`);
      const second = await secondResponse.json() as ListSessionsResponse;
      expect(second.sessions.map(row => row.id)).toEqual(["child-1"]);
      expect(second.nextCursor).toBeNull();
      expect((await fetch(`${api.baseUrl}/api/sessions?discovery=true`)).status).toBe(400);
      expect((await fetch(`${api.baseUrl}/api/sessions?${scope}&cursor=invalid`)).status).toBe(400);
      expect((await fetch(`${api.baseUrl}/api/sessions?discovery=true&ownerType=user&ownerId=other`)).status).toBe(404);
      expect((await fetch(`${api.baseUrl}/api/sessions?discovery=true&ownerType=team&ownerId=missing`)).status).toBe(404);
    } finally {
      await api.cleanup();
    }
  });
});
