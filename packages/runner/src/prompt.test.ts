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

  it("does not inject continuation context when there is no persisted session id", async () => {
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
      "old summary that should not be injected",
      "thread-4",
    );

    expect(fetchCalls.map((call) => `${call.method} ${call.url}`)).toEqual([
      "POST http://opencode.test/session",
      "POST http://opencode.test/session/new-session-without-persisted-id/message",
    ]);
    expect(fetchCalls[1]?.body).toMatchObject({
      parts: [{ type: "text", text: "start from here" }],
    });
    expect(agentClient.sendThreadCreated).toHaveBeenCalledWith("thread-4", "new-session-without-persisted-id");
    expect(agentClient.sendError).not.toHaveBeenCalled();
  });
});
