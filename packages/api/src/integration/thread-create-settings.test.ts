import { eq } from "drizzle-orm";
import { afterEach, describe, expect, it } from "vitest";
import { bootTestApi, type TestApi } from "./_setup.js";
import { users } from "../schema/index.js";
import type {
  CreateSessionResponse,
  CreateThreadResponse,
  ListThreadsResponse,
  PatchThreadResponse,
} from "../wire/types.js";

async function createSession(baseUrl: string): Promise<string> {
  const response = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspace: "/tmp" }),
  });
  expect(response.status).toBe(201);
  return ((await response.json()) as CreateSessionResponse).id;
}

async function listThreads(baseUrl: string, sessionId: string): Promise<ListThreadsResponse> {
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/threads`);
  expect(response.status).toBe(200);
  return (await response.json()) as ListThreadsResponse;
}

async function patchThread(
  baseUrl: string,
  sessionId: string,
  threadId: string,
  body: { model?: string; reasoning?: string },
): Promise<PatchThreadResponse> {
  const response = await fetch(`${baseUrl}/api/sessions/${sessionId}/threads/${threadId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(200);
  return (await response.json()) as PatchThreadResponse;
}

async function createThread(
  baseUrl: string,
  sessionId: string,
  sourceThreadId?: string,
): Promise<Response> {
  return fetch(`${baseUrl}/api/sessions/${sessionId}/threads`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(sourceThreadId === undefined ? {} : { sourceThreadId }),
  });
}

describe("POST /api/sessions/:id/threads settings", () => {
  let api: TestApi | undefined;

  afterEach(async () => {
    await api?.cleanup();
    api = undefined;
  });

  it("keeps the source thread model tier and effective reasoning by default", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const source = (await listThreads(api.baseUrl, sessionId)).threads[0]!;
    await patchThread(api.baseUrl, sessionId, source.id, { model: "m", reasoning: "high" });

    const response = await createThread(api.baseUrl, sessionId, source.id);
    expect(response.status).toBe(201);
    expect((await response.json()) as CreateThreadResponse).toMatchObject({
      model: "m",
      reasoning: "high",
    });

    const persisted = await api.providers.engineStore.getThread(
      sessionId,
      ((await listThreads(api.baseUrl, sessionId)).threads.find((thread) => thread.id !== source.id))!.id,
    );
    expect(persisted).toMatchObject({ model: "m", reasoning: "high" });
  }, 30_000);

  it("uses fresh defaults when the preference requests them", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const source = (await listThreads(api.baseUrl, sessionId)).threads[0]!;
    await patchThread(api.baseUrl, sessionId, source.id, {
      model: "claude-opus-4-5",
      reasoning: "high",
    });
    await api.providers.db
      .update(users)
      .set({
        defaultModel: "m",
        defaultReasoning: "low",
        newThreadBehavior: "use_defaults",
      })
      .where(eq(users.id, "local-user"));

    const response = await createThread(api.baseUrl, sessionId, source.id);
    expect(response.status).toBe(201);
    expect((await response.json()) as CreateThreadResponse).toMatchObject({
      model: "m",
      reasoning: "low",
    });

    const unchanged = (await listThreads(api.baseUrl, sessionId)).threads.find(
      (thread) => thread.id === source.id,
    );
    expect(unchanged).toMatchObject({ model: "claude-opus-4-5", reasoning: "high" });
  }, 30_000);

  it("uses fresh defaults instead of an active thread when no source is supplied", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const source = (await listThreads(api.baseUrl, sessionId)).threads[0]!;
    await patchThread(api.baseUrl, sessionId, source.id, { model: "m", reasoning: "high" });
    await api.providers.db
      .update(users)
      .set({ defaultModel: "l", defaultReasoning: "medium" })
      .where(eq(users.id, "local-user"));

    const response = await createThread(api.baseUrl, sessionId);
    expect(response.status).toBe(201);
    const created = (await response.json()) as CreateThreadResponse;
    expect(created).toMatchObject({ model: "l", reasoning: "medium" });
    expect(await api.providers.engineStore.getThread(sessionId, created.id)).toMatchObject({
      model: "l",
      reasoning: "medium",
    });
  }, 30_000);

  it("does not inherit historical session reasoning when fresh defaults clear it", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const source = (await listThreads(api.baseUrl, sessionId)).threads[0]!;
    const sessionPatch = await fetch(`${api.baseUrl}/api/sessions/${sessionId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reasoning: "high" }),
    });
    expect(sessionPatch.status).toBe(200);
    await api.providers.db
      .update(users)
      .set({ defaultReasoning: null, newThreadBehavior: "use_defaults" })
      .where(eq(users.id, "local-user"));

    const response = await createThread(api.baseUrl, sessionId, source.id);
    expect(response.status).toBe(201);
    const created = (await response.json()) as CreateThreadResponse;
    expect(created.reasoning).toBeNull();
    expect((await api.providers.engineStore.getThread(sessionId, created.id))?.reasoning).toBe(
      "off",
    );
  }, 30_000);

  it("rejects a missing or cross-session source without creating a thread", async () => {
    api = await bootTestApi();
    const sessionId = await createSession(api.baseUrl);
    const otherSessionId = await createSession(api.baseUrl);
    const otherSource = (await listThreads(api.baseUrl, otherSessionId)).threads[0]!;
    const before = (await listThreads(api.baseUrl, sessionId)).threads.length;

    for (const sourceThreadId of ["", "th-missing", otherSource.id]) {
      const response = await createThread(api.baseUrl, sessionId, sourceThreadId);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({
        error: "thread not found. Select a thread from this session.",
      });
    }
    expect((await listThreads(api.baseUrl, sessionId)).threads).toHaveLength(before);
  }, 30_000);
});
