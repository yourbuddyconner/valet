import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import { agentSessions, artifacts } from "../schema/index.js";
import { internalToken } from "../lib/internal-auth.js";

describe("artifact source attribution", () => {
  let api: TestApi;
  beforeAll(async () => {
    api = await bootTestApi();
    await api.providers.db.insert(agentSessions).values([
      { id: "owned", userId: "local-user", orgId: "local-org", ownerType: "user", ownerId: "local-user", workspace: "/tmp", createdAt: 1, updatedAt: 1 },
      { id: "other-user", userId: "test-member", orgId: "local-org", ownerType: "user", ownerId: "test-member", workspace: "/tmp", createdAt: 1, updatedAt: 1 },
      { id: "other-team", userId: "local-user", orgId: "local-org", ownerType: "team", ownerId: "team", workspace: "/tmp", createdAt: 1, updatedAt: 1 },
      { id: "other-org", userId: "local-user", orgId: "foreign-org", ownerType: "user", ownerId: "local-user", workspace: "/tmp", createdAt: 1, updatedAt: 1 },
    ]);
    for (const id of ["owned", "other-user"]) {
      await api.providers.engineStore.saveThread(id, {
        id: `${id}-thread`, sessionId: id, key: `web:${id}`, status: "active", queueMode: "followup", createdAt: 1, updatedAt: 1,
      });
    }
  });
  afterAll(async () => { await api.cleanup(); });

  async function publish(key: string, sessionId: string | undefined, threadId: string | undefined, internal: boolean) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (sessionId !== undefined) headers["x-valet-session-id"] = sessionId;
    if (threadId !== undefined) headers["x-valet-thread-id"] = threadId;
    if (internal) Object.assign(headers, {
      "x-valet-internal": internalToken(), "x-valet-owner": "user:local-user", "x-valet-actor": "local-user",
    });
    return fetch(`${api.baseUrl}/api/artifacts/share`, {
      method: "POST", headers, body: JSON.stringify({ key, content: "# Report" }),
    });
  }

  for (const internal of [false, true]) {
    it(`rejects forged source ownership and thread IDs (${internal ? "internal" : "user"} request)`, async () => {
      for (const source of ["other-user", "other-team", "other-org", "missing"]) {
        expect((await publish(`forged-${source}-${internal}`, source, undefined, internal)).status).toBe(404);
      }
      expect((await publish(`forged-thread-${internal}`, "owned", "other-user-thread", internal)).status).toBe(404);
      expect((await publish(`missing-thread-${internal}`, "owned", "missing", internal)).status).toBe(404);
      expect((await publish(`missing-session-${internal}`, undefined, "owned-thread", internal)).status).toBe(400);
      const saved = await api.providers.db.select().from(artifacts);
      expect(saved.filter(row => row.sourceMemoryPath.startsWith("forged-") || row.sourceMemoryPath.startsWith("missing-"))).toEqual([]);
    });
    it(`persists an authorized session and its thread (${internal ? "internal" : "user"} request)`, async () => {
      const key = `valid-${internal}`;
      expect((await publish(key, "owned", "owned-thread", internal)).status).toBe(200);
      const [saved] = await api.providers.db.select().from(artifacts).where(eq(artifacts.sourceMemoryPath, key));
      expect(saved.sourceSessionId).toBe("owned");
      expect(saved.sourceThreadId).toBe("owned-thread");
    });
  }
});
