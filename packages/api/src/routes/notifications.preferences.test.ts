/**
 * `GET`/`PUT /api/notifications/preferences` — web-delivery preference per
 * attention kind (`user_notification_preferences`, Phase 4 decision 19).
 * See `orchestrator/attention.ts` `isWebEnabled` for the read side this
 * table backs; `attention.test.ts` covers the router actually skipping a
 * disabled kind driven through this route.
 */
import { describe, it, expect, afterEach } from "vitest";
import { bootTestApi, type TestApi } from "../integration/_setup.js";
import type { ListNotificationPreferencesResponse } from "../wire/types.js";

let api: TestApi | undefined;

afterEach(async () => {
  await api?.cleanup();
  api = undefined;
});

describe("GET /api/notifications/preferences", () => {
  it("reports all five kinds as web-enabled by default", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/notifications/preferences`);
    expect(res.status).toBe(200);
    const { preferences } = (await res.json()) as ListNotificationPreferencesResponse;

    expect(preferences.map((p) => p.kind).sort()).toEqual(["approval", "escalation", "notification", "question", "review"]);
    expect(preferences.every((p) => p.web === true)).toBe(true);
    expect(preferences.every((p) => p.teamDm === false)).toBe(true);
  });
});

describe("PUT /api/notifications/preferences", () => {
  it("upserts a preference and round-trips through GET", async () => {
    api = await bootTestApi();

    const putRes = await fetch(`${api.baseUrl}/api/notifications/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "escalation", web: false, teamDm: true }),
    });
    expect(putRes.status).toBe(200);
    expect(await putRes.json()).toEqual({ ok: true });

    const getRes = await fetch(`${api.baseUrl}/api/notifications/preferences`);
    const { preferences } = (await getRes.json()) as ListNotificationPreferencesResponse;
    expect(preferences.find((p) => p.kind === "escalation")?.web).toBe(false);
    // Other kinds stay at the default.
    expect(preferences.find((p) => p.kind === "notification")?.web).toBe(true);

    // Flipping it back updates the same row rather than inserting a second.
    const putBackRes = await fetch(`${api.baseUrl}/api/notifications/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "escalation", web: true }),
    });
    expect(putBackRes.status).toBe(200);

    const getRes2 = await fetch(`${api.baseUrl}/api/notifications/preferences`);
    const { preferences: preferences2 } = (await getRes2.json()) as ListNotificationPreferencesResponse;
    expect(preferences2.find((p) => p.kind === "escalation")?.web).toBe(true);
    expect(preferences2.find((p) => p.kind === "escalation")?.teamDm).toBe(true);
  });

  it("rejects an invalid kind", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/notifications/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "bogus", web: false }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-boolean web value", async () => {
    api = await bootTestApi();

    const res = await fetch(`${api.baseUrl}/api/notifications/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "notification", web: "yes" }),
    });
    expect(res.status).toBe(400);
  });

  it("is own-user-only: setting a preference as one user does not affect another's", async () => {
    api = await bootTestApi();

    await fetch(`${api.baseUrl}/api/notifications/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "x-valet-test-user-id": "test-member" },
      body: JSON.stringify({ kind: "approval", web: false }),
    });

    const localUserRes = await fetch(`${api.baseUrl}/api/notifications/preferences`);
    const { preferences: localUserPrefs } = (await localUserRes.json()) as ListNotificationPreferencesResponse;
    expect(localUserPrefs.find((p) => p.kind === "approval")?.web).toBe(true);

    const memberRes = await fetch(`${api.baseUrl}/api/notifications/preferences`, {
      headers: { "x-valet-test-user-id": "test-member" },
    });
    const { preferences: memberPrefs } = (await memberRes.json()) as ListNotificationPreferencesResponse;
    expect(memberPrefs.find((p) => p.kind === "approval")?.web).toBe(false);
  });
});
