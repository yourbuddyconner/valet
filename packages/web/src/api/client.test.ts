/**
 * `client.ts` URL-building unit test — orchestrator and other session ids
 * contain colons (`orchestrator:user:{userId}`), so every path segment that
 * interpolates an id must be `encodeURIComponent`-ed or the colon collides
 * with Hono's own path-param parsing on some routes. Spies on global
 * `fetch` to assert the exact request URL without a real server.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { api } from "./client";

function stubFetchOk(body: unknown = {}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const COLON_ID = "orchestrator:user:local-user";

describe("api client: colon-safe URL encoding", () => {
  it("getSession encodes a colon-bearing session id", async () => {
    const fetchMock = stubFetchOk();
    await api.getSession(COLON_ID);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(`/api/sessions/${encodeURIComponent(COLON_ID)}`);
    expect(url).not.toContain("orchestrator:user:local-user");
  });

  it("listThreads encodes the session id", async () => {
    const fetchMock = stubFetchOk();
    await api.listThreads(COLON_ID);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(`/api/sessions/${encodeURIComponent(COLON_ID)}/threads`);
  });

  it("patchThread encodes both the session id and the thread id", async () => {
    const fetchMock = stubFetchOk();
    await api.patchThread(COLON_ID, "thread:1", { model: "claude-haiku-4-5" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      `/api/sessions/${encodeURIComponent(COLON_ID)}/threads/${encodeURIComponent("thread:1")}`,
    );
  });

  it("sendPrompt encodes the session id", async () => {
    const fetchMock = stubFetchOk();
    await api.sendPrompt(COLON_ID, { text: "hi" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(`/api/sessions/${encodeURIComponent(COLON_ID)}/messages`);
  });

  it("resolveDecision encodes session id and gate id", async () => {
    const fetchMock = stubFetchOk();
    await api.resolveDecision(COLON_ID, "gate:1", { actionId: "approve" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      `/api/sessions/${encodeURIComponent(COLON_ID)}/decisions/${encodeURIComponent("gate:1")}/resolve`,
    );
  });

  it("ensureOrchestrator posts to /orchestrator with no id to encode", async () => {
    const fetchMock = stubFetchOk({ sessionId: COLON_ID });
    const res = await api.ensureWorkspaceRuntime("user");
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe("/api/workspaces/user/runtime");
    expect(res.sessionId).toBe(COLON_ID);
  });

  it("abortThread encodes both the session id and the thread id", async () => {
    const fetchMock = stubFetchOk();
    await api.abortThread(COLON_ID, "thread:1", { targetItemId: "item:1" });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toBe(
      `/api/sessions/${encodeURIComponent(COLON_ID)}/threads/${encodeURIComponent("thread:1")}/abort`,
    );
    const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(opts.body).toBe(JSON.stringify({ targetItemId: "item:1" }));
  });

  it("resumeThread encodes both the session id and the thread id", async () => {
    const fetchMock = stubFetchOk();
    await api.resumeThread(COLON_ID, "thread:1");
    expect(fetchMock.mock.calls[0]?.[0]).toBe(
      `/api/sessions/${encodeURIComponent(COLON_ID)}/threads/${encodeURIComponent("thread:1")}/resume`,
    );
  });
});

describe("api client: notification preferences", () => {
  it("listNotificationPreferences GETs the preferences endpoint", async () => {
    const fetchMock = stubFetchOk({ preferences: [] });
    await api.listNotificationPreferences();
    const url = fetchMock.mock.calls[0]?.[0] as string;
    const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(url).toBe("/api/notifications/preferences");
    expect(opts.method).toBe("GET");
  });

  it("setNotificationPreference PUTs the kind/web body", async () => {
    const fetchMock = stubFetchOk({ ok: true });
    await api.setNotificationPreference({ kind: "approval", web: false });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    const opts = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(url).toBe("/api/notifications/preferences");
    expect(opts.method).toBe("PUT");
    expect(JSON.parse(opts.body as string)).toEqual({ kind: "approval", web: false });
  });
});

describe("api client: usage period URLs", () => {
  it("builds month and custom URLs with the selected scope", async () => {
    const fetchMock = stubFetchOk({});
    await api.usageBreakdown({ kind: "month", month: "2024-02" }, "org");
    expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/usage/breakdown?month=2024-02&scope=org");

    expect(api.usageExportCsvUrl(
      { kind: "custom", start: "2024-02-01", end: "2024-02-29" },
      "team",
      "turn",
      "team-x",
    )).toBe("/api/usage/export.csv?start=2024-02-01&end=2024-02-29&scope=team&teamId=team-x&granularity=turn");

    const validateFetch = stubFetchOk();
    await api.validateUsageExport({ kind: "lookback", window: "7d" }, "me", "day");
    expect(validateFetch.mock.calls[0]?.[0]).toBe(
      "/api/usage/export.csv?window=7d&scope=me&granularity=day&validate=1",
    );
  });
});

it("scopes child work and pagination to an encoded parent session", async () => {
  const fetchMock = stubFetchOk({ children: [], nextCursor: null, runningCount: 0 });
  await api.getChildWork("parent:team", { cursor: "cursor+/=", limit: 25 });
  const url = new URL(fetchMock.mock.calls[0]?.[0] as string, "https://example.test");
  expect(url.pathname).toBe("/api/sessions/parent%3Ateam/children");
  expect(url.searchParams.get("cursor")).toBe("cursor+/=");
  expect(url.searchParams.get("limit")).toBe("25");
});

it("dismisses a child under an explicit encoded parent", async () => {
  const fetchMock = stubFetchOk({ ok: true });
  await api.dismissChild("parent:team", "child:one");
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/sessions/parent%3Ateam/children/child%3Aone/dismiss");
});

it("encodes receipt search and page cursor", async () => {
  const fetchMock = stubFetchOk();
  await api.listEventReceipts({ q: "C123 + Ev456", cursor: "cursor+/=", limit: 25 });
  const url = new URL(fetchMock.mock.calls[0]?.[0] as string, "https://example.test");
  expect(url.pathname).toBe("/api/events/receipts");
  expect(url.searchParams.get("q")).toBe("C123 + Ev456");
  expect(url.searchParams.get("cursor")).toBe("cursor+/=");
  expect(url.searchParams.get("limit")).toBe("25");
});
