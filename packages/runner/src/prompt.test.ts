import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentClient } from "./agent-client.js";
import { ChannelSession, PromptHandler } from "./prompt.js";

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

    await handler.handlePrompt({
      messageId: "message-1",
      content: "actual user prompt",
      channelType: "thread",
      channelId: "thread-1",
      opencodeSessionId: "persisted-thread",
      continuationContext: "saved continuation context",
      threadId: "thread-1",
    });

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

    await handler.handlePrompt({
      messageId: "message-2",
      content: "resume this task",
      channelType: "thread",
      channelId: "thread-2",
      opencodeSessionId: "persisted-missing",
      continuationContext: "restored conversation summary",
      threadId: "thread-2",
    });

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

    await handler.handlePrompt({
      messageId: "message-3",
      content: "continue the work",
      channelType: "thread",
      channelId: "thread-3",
      opencodeSessionId: "persisted-transient",
      continuationContext: "resume summary from before restart",
      threadId: "thread-3",
    });

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

    await handler.handlePrompt({
      messageId: "message-4",
      content: "start from here",
      channelType: "thread",
      channelId: "thread-4",
      continuationContext: "old summary that should be injected for legacy resume",
      threadId: "thread-4",
    });

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
    const firstPromise = handler.handlePrompt({
      messageId: "msg-1",
      content: "first prompt",
      channelType: "thread",
      channelId: "ch-dedup",
    });

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
    await handler.handlePrompt({
      messageId: "msg-1",
      content: "first prompt",
      channelType: "thread",
      channelId: "ch-dedup",
    });

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

describe("PromptHandler provider retry loop failover", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("aborts a zero-output OpenCode retry loop and falls back to the next model", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    let primaryAttemptAbortSignal: AbortSignal | undefined;
    let rejectPrimaryAttempt: ((reason?: unknown) => void) | undefined;
    let primaryAttemptStarted: (() => void) | undefined;
    const primaryAttemptReady = new Promise<void>((resolve) => {
      primaryAttemptStarted = resolve;
    });

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "retry-loop-session" });
      }

      if (url === "http://opencode.test/session/retry-loop-session/abort" && method === "POST") {
        return new Response(null, { status: 204 });
      }

      if (url === "http://opencode.test/session/retry-loop-session/message" && method === "POST") {
        const requestedModel = body?.model as { providerID?: string; modelID?: string } | undefined;
        const fullModel = requestedModel
          ? `${requestedModel.providerID}/${requestedModel.modelID}`
          : undefined;

        if (fullModel === "openai/gpt-5.5") {
          primaryAttemptAbortSignal = init?.signal ?? undefined;
          primaryAttemptStarted?.();
          return new Promise<Response>((_resolve, reject) => {
            rejectPrimaryAttempt = reject;
            primaryAttemptAbortSignal?.addEventListener("abort", () => {
              reject(new DOMException("This operation was aborted", "AbortError"));
            });
          });
        }

        if (fullModel === "anthropic/claude-sonnet-4-5") {
          return jsonResponse({
            info: { id: "assistant-fallback", role: "assistant", content: "fallback reply" },
            parts: [],
          });
        }
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const promptPromise = handler.handlePrompt(
      "msg-retry-loop",
      "please continue",
      "openai/gpt-5.5",
      undefined,
      ["anthropic/claude-sonnet-4-5"],
      undefined,
      "thread",
      "retry-loop-thread",
    );

    await primaryAttemptReady;
    const channel = (handler as any).channels.get("thread:retry-loop-thread");

    for (let i = 0; i < 4; i++) {
      (handler as any).handlePartUpdated(
        { part: { type: "step-start", id: `step-${i}` } },
        channel,
      );
      (handler as any).handleSessionStatus(
        { status: { type: "retry" } },
        channel,
      );
    }

    const outcome = await Promise.race([
      promptPromise.then(() => "completed"),
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 25)),
    ]);
    if (outcome !== "completed") {
      rejectPrimaryAttempt?.(new Error("cleanup after stuck primary attempt"));
      await promptPromise.catch(() => undefined);
    }

    expect(outcome).toBe("completed");
    expect(primaryAttemptAbortSignal?.aborted).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://opencode.test/session/retry-loop-session/abort",
      { method: "POST" },
    );
    expect(agentClient.sendModelSwitched).toHaveBeenCalledWith(
      "msg-retry-loop",
      "openai/gpt-5.5",
      "anthropic/claude-sonnet-4-5",
      expect.stringContaining("retry"),
    );
    expect(agentClient.sendTurnFinalize).toHaveBeenCalledWith(
      expect.any(String),
      "end_turn",
      "fallback reply",
    );
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

describe("PromptHandler.extractChannelContext", () => {
  it("returns undefined threadId for non-thread channels", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    const channel = new ChannelSession("web:default");

    const ctx = (handler as any).extractChannelContext(channel);

    expect(ctx).toEqual({
      channelType: "web",
      channelId: "default",
      threadId: undefined,
    });
  });

  it("returns threadId for thread channels", () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    const channel = new ChannelSession("thread:abc-123");

    const ctx = (handler as any).extractChannelContext(channel);

    expect(ctx).toEqual({
      channelType: "thread",
      channelId: "abc-123",
      threadId: "abc-123",
    });
  });
});

describe("PromptHandler text file extraction", () => {
  let fetchCalls: FetchCall[];

  beforeEach(() => {
    fetchCalls = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("extracts text file content and prepends it to the prompt", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const textContent = "Hello, this is a text file.\nLine two.";
    const base64 = Buffer.from(textContent).toString("base64");
    const dataUrl = `data:text/plain;base64,${base64}`;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "text-session" });
      }

      if (url === "http://opencode.test/session/text-session/message" && method === "POST") {
        return jsonResponse({ info: { role: "assistant", content: "ok" }, parts: [] });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await handler.handlePrompt({
      messageId: "msg-text-1",
      content: "please review this file",
      attachments: [{ type: "file", mime: "text/plain", url: dataUrl, filename: "notes.txt" }],
      channelType: "thread",
      channelId: "ch-text",
    });

    // The sync prompt should have text file content appended after the message and no file parts
    const syncCall = fetchCalls.find(
      (c) => c.url === "http://opencode.test/session/text-session/message" && c.method === "POST",
    );
    expect(syncCall).toBeDefined();
    const body = syncCall!.body as any;
    expect(body.parts).toEqual([
      { type: "text", text: expect.stringContaining('<attached-file name="notes.txt"') },
    ]);
    expect(body.parts[0].text).toContain(textContent);
    expect(body.parts[0].text).toContain("</attached-file>");
    expect(body.parts[0].text).toContain("please review this file");
    // No file attachments should remain
    const fileParts = body.parts.filter((p: any) => p.type === "file");
    expect(fileParts).toHaveLength(0);
  });

  it("extracts application/json files as text", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const jsonContent = JSON.stringify({ key: "value", nested: { a: 1 } });
    const base64 = Buffer.from(jsonContent).toString("base64");
    const dataUrl = `data:application/json;base64,${base64}`;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "json-session" });
      }

      if (url === "http://opencode.test/session/json-session/message" && method === "POST") {
        return jsonResponse({ info: { role: "assistant", content: "ok" }, parts: [] });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await handler.handlePrompt({
      messageId: "msg-json-1",
      content: "analyze this config",
      attachments: [{ type: "file", mime: "application/json", url: dataUrl, filename: "config.json" }],
      channelType: "thread",
      channelId: "ch-json",
    });

    const syncCall = fetchCalls.find(
      (c) => c.url === "http://opencode.test/session/json-session/message" && c.method === "POST",
    );
    expect(syncCall).toBeDefined();
    const body = syncCall!.body as any;
    expect(body.parts[0].text).toContain('<attached-file name="config.json" type="application/json">');
    expect(body.parts[0].text).toContain(jsonContent);
    const fileParts = body.parts.filter((p: any) => p.type === "file");
    expect(fileParts).toHaveLength(0);
  });

  it("preserves image attachments while extracting text files", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const textContent = "some code here";
    const base64 = Buffer.from(textContent).toString("base64");
    const textDataUrl = `data:text/plain;base64,${base64}`;
    const imageDataUrl = "data:image/png;base64,iVBORw0KGgo=";

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "mixed-session" });
      }

      if (url === "http://opencode.test/session/mixed-session/message" && method === "POST") {
        return jsonResponse({ info: { role: "assistant", content: "ok" }, parts: [] });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await handler.handlePrompt({
      messageId: "msg-mixed-1",
      content: "check both files",
      attachments: [
        { type: "file", mime: "text/plain", url: textDataUrl, filename: "code.txt" },
        { type: "file", mime: "image/png", url: imageDataUrl, filename: "screenshot.png" },
      ],
      channelType: "thread",
      channelId: "ch-mixed",
    });

    const syncCall = fetchCalls.find(
      (c) => c.url === "http://opencode.test/session/mixed-session/message" && c.method === "POST",
    );
    expect(syncCall).toBeDefined();
    const body = syncCall!.body as any;
    // Image attachment should still be present as a file part
    const fileParts = body.parts.filter((p: any) => p.type === "file");
    expect(fileParts).toHaveLength(1);
    expect(fileParts[0].mime).toBe("image/png");
    // Text content should be in the text part (file parts come first in buildPromptBody)
    const textPart = body.parts.find((p: any) => p.type === "text");
    expect(textPart).toBeDefined();
    expect(textPart.text).toContain('<attached-file name="code.txt" type="text/plain">');
    expect(textPart.text).toContain(textContent);
  });
});
