import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ArchivedAssistantError, resolveDefaultAssistant, retireAssistant } from "../assistants/service.js";
import { assistants } from "../schema/index.js";
import { bootTestApi, type TestApi } from "./_setup.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
  // This file is in the "integration" vitest project, which — unlike
  // "unit" — has no `vitest.setup.ts` scrub between tests (integration
  // suites need the real ambient ANTHROPIC_API_KEY). A `vi.stubEnv` in one
  // test would otherwise leak into the next.
  vi.unstubAllEnvs();
});

const MEMBER_HEADERS = { "x-valet-test-user-id": "test-member" };
const JSON_HEADERS = { "Content-Type": "application/json" };

describe("removed assistant profile endpoints", () => {
  it("offers no profile writes or assistant-addressed open route", async () => {
    api = await bootTestApi();
    const row = await resolveDefaultAssistant(api.providers.db, "local-org", { type: "user", id: "local-user" });
    for (const [method, path] of [["POST", "/api/assistants"], ["PATCH", `/api/assistants/${row.id}`], ["DELETE", `/api/assistants/${row.id}`], ["POST", `/api/assistants/${row.id}/session`]]) {
      const response = await fetch(`${api.baseUrl}${path}`, { method, headers: JSON_HEADERS, body: JSON.stringify({ name: "New profile" }) });
      expect(response.status).toBe(404);
    }
    expect((await fetch(`${api.baseUrl}/api/assistants`)).status).toBe(404);
    expect(await api.providers.db.select().from(assistants)).toHaveLength(1);
  });
});

describe("workspace session initialization", () => {
  it("opens the singleton session idempotently and makes its session readable", async () => {
    api = await bootTestApi();
    const responses = await Promise.all(Array.from({ length: 3 }, () => fetch(`${api!.baseUrl}/api/workspaces/user/runtime`, { method: "POST" })));
    const bodies: Array<{ sessionId: string }> = [];
    for (const response of responses) {
      expect(response.status).toBe(200);
      bodies.push(await response.json() as { sessionId: string });
    }
    expect(new Set(bodies.map(body => body.sessionId)).size).toBe(1);
    expect(await api.providers.db.select().from(assistants)).toHaveLength(1);
    expect((await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(bodies[0]!.sessionId)}`)).status).toBe(200);
    expect((await fetch(`${api.baseUrl}/api/sessions/${encodeURIComponent(bodies[0]!.sessionId)}`, { headers: MEMBER_HEADERS })).status).toBe(404);
  });
});

describe("retired singleton sessions", () => {
  it("a retired assistant's session refuses to wake", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    const created = await resolveDefaultAssistant(db, "local-org", { type: "user", id: "local-user" });
    await retireAssistant(db, created.id);

    await expect(
      engineHost.assistantSessionFor(created.id, {
        actorUserId: "local-user",
        orgId: "local-org",
      }),
    ).rejects.toBeInstanceOf(ArchivedAssistantError);
  });

  // Migrated rows keep legacy `orchestrator:*` session ids that sessionFor's
  // prefix parse cannot recognize — the column-lookup fallback must route
  // them to the assistant build, where the archived refusal applies.
  it("a retired migrated assistant refuses to wake through the generic sessionFor path", async () => {
    api = await bootTestApi();
    const { db, engineHost } = api.providers;
    await db.insert(assistants).values({
      id: "asst_legacy_wake",
      orgId: "local-org",
      ownerType: "user",
      ownerId: "local-user",
      sessionId: "orchestrator:user:local-user",
      createdAt: Date.now(),
      archivedAt: null,
    });
    await retireAssistant(db, "asst_legacy_wake");

    await expect(
      engineHost.sessionFor("orchestrator:user:local-user", {
        userId: "local-user",
        orgId: "local-org",
        workspace: "/tmp/legacy-wake",
      }),
    ).rejects.toBeInstanceOf(ArchivedAssistantError);
  });
});
