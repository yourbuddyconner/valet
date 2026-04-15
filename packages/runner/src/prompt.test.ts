import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentClient } from "./agent-client.js";
import { PromptHandler } from "./prompt.js";

type FetchCall = {
  url: string;
  method: string;
  body?: unknown;
};

type AgentClientMock = {
  sendAgentStatus: ReturnType<typeof vi.fn>;
  sendComplete: ReturnType<typeof vi.fn>;
  sendError: ReturnType<typeof vi.fn>;
  sendTurnCreate: ReturnType<typeof vi.fn>;
  sendTurnFinalize: ReturnType<typeof vi.fn>;
  sendAnalyticsEvents: ReturnType<typeof vi.fn>;
  sendUsageReport: ReturnType<typeof vi.fn>;
  sendFilesChanged: ReturnType<typeof vi.fn>;
  sendChannelSessionCreated: ReturnType<typeof vi.fn>;
  sendThreadCreated: ReturnType<typeof vi.fn>;
  sendModelSwitched: ReturnType<typeof vi.fn>;
  sendAudioTranscript: ReturnType<typeof vi.fn>;
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function textResponse(body: string, status: number): Response {
  return new Response(body, { status });
}

function createAgentClientMock(): AgentClientMock & AgentClient {
  return {
    sendAgentStatus: vi.fn(),
    sendComplete: vi.fn(),
    sendError: vi.fn(),
    sendTurnCreate: vi.fn(),
    sendTurnFinalize: vi.fn(),
    sendAnalyticsEvents: vi.fn(),
    sendUsageReport: vi.fn(),
    sendFilesChanged: vi.fn(),
    sendChannelSessionCreated: vi.fn(),
    sendThreadCreated: vi.fn(),
    sendModelSwitched: vi.fn(),
    sendAudioTranscript: vi.fn(),
  } as unknown as AgentClientMock & AgentClient;
}

function createHandler(agentClient: AgentClientMock & AgentClient): PromptHandler {
  const handler = new PromptHandler("http://opencode.test", agentClient);
  (handler as any).eventStreamActive = true;
  (handler as any).pollUntilIdle = vi.fn().mockResolvedValue(undefined);
  (handler as any).checkAndTriggerMemoryFlush = vi.fn().mockResolvedValue(undefined);
  (handler as any).reportFilesChanged = vi.fn().mockResolvedValue(undefined);
  return handler;
}

describe("PromptHandler thread resume", () => {
  let fetchCalls: FetchCall[];

  beforeEach(() => {
    fetchCalls = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("reuses and verifies a persisted thread session before the first resumed prompt", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "http://opencode.test/session/persisted-thread" && method === "GET") {
        return jsonResponse({ id: "persisted-thread", status: { type: "idle" } });
      }

      if (url === "http://opencode.test/session/persisted-thread/message" && method === "POST") {
        return jsonResponse({ info: { role: "assistant", content: "reused reply" }, parts: [] });
      }

      if (url === "http://opencode.test/session/persisted-thread/prompt_async" && method === "POST") {
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await handler.handlePrompt(
      "message-1",
      "actual user prompt",
      undefined,
      undefined,
      undefined,
      undefined,
      "thread",
      "thread-1",
      "persisted-thread",
      "saved continuation context",
      "thread-1",
    );

    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://opencode.test/session/persisted-thread",
      "POST http://opencode.test/session/persisted-thread/message",
    ]);
    expect(fetchCalls[1]?.body).toMatchObject({
      parts: [{ type: "text", text: "actual user prompt" }],
    });
    expect(agentClient.sendThreadCreated).not.toHaveBeenCalled();
    expect(agentClient.sendError).not.toHaveBeenCalled();
  });

  it("recreates a missing persisted thread session once and uses continuation context only after fallback", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "http://opencode.test/session/persisted-missing" && method === "GET") {
        return textResponse("missing", 404);
      }

      if (url === "http://opencode.test/session/persisted-missing/prompt_async" && method === "POST") {
        return textResponse("missing", 404);
      }

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "new-thread-session" });
      }

      if (url === "http://opencode.test/session/new-thread-session/prompt_async" && method === "POST") {
        return new Response(null, { status: 204 });
      }

      if (url === "http://opencode.test/session/new-thread-session/message" && method === "POST") {
        return jsonResponse({ info: { role: "assistant", content: "fresh reply" }, parts: [] });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await handler.handlePrompt(
      "message-2",
      "resume this task",
      undefined,
      undefined,
      undefined,
      undefined,
      "thread",
      "thread-2",
      "persisted-missing",
      "restored conversation summary",
      "thread-2",
    );

    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET http://opencode.test/session/persisted-missing",
      "POST http://opencode.test/session",
      "POST http://opencode.test/session/new-thread-session/prompt_async",
      "POST http://opencode.test/session/new-thread-session/message",
    ]);
    expect(fetchCalls[2]?.body).toMatchObject({
      parts: [
        {
          type: "text",
          text: expect.stringContaining("restored conversation summary"),
        },
      ],
    });
    expect(fetchCalls[3]?.body).toMatchObject({
      parts: [{ type: "text", text: "resume this task" }],
    });
    expect(agentClient.sendThreadCreated).toHaveBeenCalledTimes(1);
    expect(agentClient.sendThreadCreated).toHaveBeenCalledWith("thread-2", "new-thread-session");
    expect(agentClient.sendError).not.toHaveBeenCalled();
  });

  it("injects continuation context if persisted-session verification fails transiently and the first prompt later recreates", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    let verificationAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "http://opencode.test/session/persisted-transient" && method === "GET") {
        verificationAttempts++;
        if (verificationAttempts === 1) {
          throw new Error("socket hang up");
        }
        return textResponse("missing", 404);
      }

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "recreated-after-transient" });
      }

      if (url === "http://opencode.test/session/recreated-after-transient/prompt_async" && method === "POST") {
        return new Response(null, { status: 204 });
      }

      if (url === "http://opencode.test/session/recreated-after-transient/message" && method === "POST") {
        return jsonResponse({ info: { role: "assistant", content: "reply after fallback" }, parts: [] });
      }

      if (url === "http://opencode.test/session/persisted-transient/message" && method === "POST") {
        return textResponse("missing", 404);
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await handler.handlePrompt(
      "message-3",
      "continue the work",
      undefined,
      undefined,
      undefined,
      undefined,
      "thread",
      "thread-3",
      "persisted-transient",
      "resume summary from before restart",
      "thread-3",
    );

    const callNames = fetchCalls.map((call) => `${call.method} ${call.url}`);
    expect(callNames).toContain("GET http://opencode.test/session/persisted-transient");
    expect(callNames).toContain("POST http://opencode.test/session");
    expect(callNames).toContain("POST http://opencode.test/session/recreated-after-transient/prompt_async");
    expect(callNames).toContain("POST http://opencode.test/session/recreated-after-transient/message");

    const contextIndex = callNames.indexOf("POST http://opencode.test/session/recreated-after-transient/prompt_async");
    const promptIndex = callNames.indexOf("POST http://opencode.test/session/recreated-after-transient/message");
    expect(contextIndex).toBeGreaterThan(-1);
    expect(promptIndex).toBeGreaterThan(contextIndex);
    expect(fetchCalls[contextIndex]?.body).toMatchObject({
      parts: [
        {
          type: "text",
          text: expect.stringContaining("resume summary from before restart"),
        },
      ],
    });
    expect(fetchCalls[promptIndex]?.body).toMatchObject({
      parts: [{ type: "text", text: "continue the work" }],
    });
    expect(agentClient.sendThreadCreated).toHaveBeenCalledWith("thread-3", "recreated-after-transient");
    expect(agentClient.sendError).not.toHaveBeenCalled();
  });

  it("injects continuation context when resuming a legacy thread with no persisted session id", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "new-session-without-persisted-id" });
      }

      if (url === "http://opencode.test/session/new-session-without-persisted-id/message" && method === "POST") {
        return jsonResponse({ info: { role: "assistant", content: "new session reply" }, parts: [] });
      }

      if (url === "http://opencode.test/session/new-session-without-persisted-id/prompt_async" && method === "POST") {
        return new Response(null, { status: 204 });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await handler.handlePrompt(
      "message-4",
      "start from here",
      undefined,
      undefined,
      undefined,
      undefined,
      "thread",
      "thread-4",
      undefined,
      "old summary that should be injected for legacy resume",
      "thread-4",
    );

    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://opencode.test/session",
      "POST http://opencode.test/session/new-session-without-persisted-id/prompt_async",
      "POST http://opencode.test/session/new-session-without-persisted-id/message",
    ]);
    expect(fetchCalls[1]?.body).toMatchObject({
      parts: [
        {
          type: "text",
          text: expect.stringContaining("old summary that should be injected for legacy resume"),
        },
      ],
    });
    expect(fetchCalls[2]?.body).toMatchObject({
      parts: [{ type: "text", text: "start from here" }],
    });
    expect(agentClient.sendThreadCreated).toHaveBeenCalledWith("thread-4", "new-session-without-persisted-id");
    expect(agentClient.sendError).not.toHaveBeenCalled();
  });
});

describe("PromptHandler dedup guard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("skips duplicate prompt when same messageId is already in flight as sync prompt", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    let fetchCalls: FetchCall[] = [];
    let resolveSyncPrompt: (() => void) | undefined;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "dedup-session" });
      }

      if (url === "http://opencode.test/session/dedup-session/message" && method === "POST") {
        // Never resolves — simulates a sync prompt that is still in flight
        return new Promise<Response>((resolve) => {
          resolveSyncPrompt = () => resolve(jsonResponse({ info: { role: "assistant" }, parts: [] }));
        });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    // Fire first prompt but don't await — it will hang on the sync fetch
    const firstPromise = handler.handlePrompt(
      "msg-1",
      "first prompt",
      undefined,
      undefined,
      undefined,
      undefined,
      "thread",
      "ch-dedup",
    );

    // Wait until syncPromptInFlight is set (first prompt has reached the fetch)
    await new Promise<void>((resolve) => {
      const check = () => {
        const channel = (handler as any).channels.get("thread:ch-dedup");
        if (channel?.syncPromptInFlight) {
          resolve();
        } else {
          setTimeout(check, 5);
        }
      };
      check();
    });

    // Send duplicate — same messageId, same channel
    await handler.handlePrompt(
      "msg-1",
      "first prompt",
      undefined,
      undefined,
      undefined,
      undefined,
      "thread",
      "ch-dedup",
    );

    // Duplicate path must send sendComplete to unblock the DO
    expect(agentClient.sendComplete).toHaveBeenCalledWith("msg-1");

    // Only one session creation and one sync prompt fetch should have been made
    const sessionCreates = fetchCalls.filter((c) => c.url === "http://opencode.test/session" && c.method === "POST");
    const syncPrompts = fetchCalls.filter((c) => c.url === "http://opencode.test/session/dedup-session/message" && c.method === "POST");
    expect(sessionCreates).toHaveLength(1);
    expect(syncPrompts).toHaveLength(1);

    // Clean up the hanging promise
    resolveSyncPrompt?.();
    await firstPromise.catch(() => {});
  });
});

describe("PromptHandler idle suppression", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not broadcast idle status while sync prompt is in flight", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const channel = (handler as any).getOrCreateChannel("thread", "ch-1");
    channel.syncPromptInFlight = true;
    channel.activeMessageId = "msg-1";
    (handler as any).currentPromptChannel = channel;

    (handler as any).handleSessionStatus({ status: { type: "idle" } }, channel);

    expect(agentClient.sendAgentStatus).not.toHaveBeenCalled();
  });

  it("broadcasts idle status when no sync prompt is in flight", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const channel = (handler as any).getOrCreateChannel("thread", "ch-1");
    channel.syncPromptInFlight = false;
    channel.activeMessageId = null;
    (handler as any).currentPromptChannel = channel;

    (handler as any).handleSessionStatus({ status: { type: "idle" } }, channel);

    expect(agentClient.sendAgentStatus).toHaveBeenCalledWith("idle", undefined, undefined);
  });
});

describe("PromptHandler reconnect readiness", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("re-emits idle after SSE reconnect even if the channel had already notified idle before", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const channel = (handler as any).getOrCreateChannel("thread", "thread-slack");
    (handler as any).currentPromptChannel = channel;
    channel.opencodeSessionId = "oc-thread-slack";
    (handler as any).ocSessionToChannel.set("oc-thread-slack", channel);
    channel.idleNotified = true;
    (handler as any).eventStreamActive = false;
    (handler as any).consumeEventStream = vi.fn().mockResolvedValue(undefined);

    await (handler as any).startEventStream();
    (handler as any).handleEvent({
      type: "session.idle",
      properties: { sessionID: channel.opencodeSessionId ?? "oc-thread-slack" },
    });

    expect(agentClient.sendAgentStatus).toHaveBeenCalledWith("idle", undefined, undefined);
  });
});

describe("PromptHandler SSE event routing", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("drops SSE event when sessionID is not in ocSessionToChannel", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    (handler as any).handleEvent({
      type: "message.updated",
      properties: { sessionID: "unknown-session-id" },
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Dropping SSE event \(unmapped session\)/)
    );
  });

  it("drops SSE event with no sessionID", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    (handler as any).handleEvent({
      type: "message.updated",
      properties: {},
    });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringMatching(/Dropping SSE event \(no session ID\)/)
    );
  });
});
