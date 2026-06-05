import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  sendQuestion: ReturnType<typeof vi.fn>;
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
    sendQuestion: vi.fn(),
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

describe("PromptHandler question answers", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("replies to a pending question even when no prompt channel is current", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const channel = (handler as any).getOrCreateChannel("thread", "thread-question");
    channel.activeMessageId = "msg-question";
    (handler as any).handleQuestionAsked(
      {
        id: "question-request",
        questions: [
          {
            question: "Pick one",
            options: [{ label: "Yes" }, { label: "No" }],
          },
        ],
      },
      channel,
    );

    expect(agentClient.sendQuestion).toHaveBeenCalledWith(
      "msg-question",
      "question-request",
      "Pick one",
      ["Yes", "No"],
    );

    const fetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);
    (handler as any).currentPromptChannel = null;

    await handler.handleAnswer("question-request", "Yes");

    expect(fetchMock).toHaveBeenCalledWith(
      "http://opencode.test/question/question-request/reply",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ answers: [["Yes"]] }),
      }),
    );
  });
});

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
    // Adopted persisted sessions get refreshed date context (TKAI-79)
    const adoptedBody = fetchCalls[1]?.body as { parts: { text: string }[] };
    expect(adoptedBody.parts[0].text).toMatch(/^\[Today is .+\]\n\nactual user prompt$/);
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
    // First user prompt on a new session gets date context prepended (TKAI-79)
    const resumeBody = fetchCalls[3]?.body as { parts: { text: string }[] };
    expect(resumeBody.parts[0].text).toMatch(/^\[Today is .+\]\n\nresume this task$/);
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
    // First prompt on recreated session gets date context (TKAI-79)
    const transientBody = fetchCalls[promptIndex]?.body as { parts: { text: string }[] };
    expect(transientBody.parts[0].text).toMatch(/^\[Today is .+\]\n\ncontinue the work$/);
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
    // First user prompt on a new session gets date context prepended (TKAI-79)
    const legacyBody = fetchCalls[2]?.body as { parts: { text: string }[] };
    expect(legacyBody.parts[0].text).toMatch(/^\[Today is .+\]\n\nstart from here$/);
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

describe("PromptHandler audio transcription", () => {
  const originalFfmpegTimeout = process.env.VALET_AUDIO_FFMPEG_TIMEOUT_MS;
  const originalWhisperTimeout = process.env.VALET_AUDIO_WHISPER_TIMEOUT_MS;

  afterEach(() => {
    if (originalFfmpegTimeout === undefined) {
      delete process.env.VALET_AUDIO_FFMPEG_TIMEOUT_MS;
    } else {
      process.env.VALET_AUDIO_FFMPEG_TIMEOUT_MS = originalFfmpegTimeout;
    }
    if (originalWhisperTimeout === undefined) {
      delete process.env.VALET_AUDIO_WHISPER_TIMEOUT_MS;
    } else {
      process.env.VALET_AUDIO_WHISPER_TIMEOUT_MS = originalWhisperTimeout;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("times out hung ffmpeg conversion so the prompt can continue", async () => {
    process.env.VALET_AUDIO_FFMPEG_TIMEOUT_MS = "5";
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    const killed: string[] = [];

    vi.stubGlobal("Bun", {
      write: vi.fn().mockResolvedValue(undefined),
      spawn: vi.fn(() => ({
        exited: new Promise<number>(() => undefined),
        stderr: new ReadableStream<Uint8Array>(),
        kill: vi.fn((signal?: string) => {
          killed.push(signal || "SIGTERM");
        }),
      })),
    });

    const attachment = {
      type: "file" as const,
      mime: "audio/ogg",
      url: `data:audio/ogg;base64,${Buffer.from("ogg data").toString("base64")}`,
      filename: "voice.oga",
    };

    const resultPromise = (handler as any).transcribeAudioAttachments([attachment]);
    const result = await Promise.race([
      resultPromise,
      new Promise<"stuck">((resolve) => setTimeout(() => resolve("stuck"), 50)),
    ]);

    expect(result).not.toBe("stuck");
    expect(result).toEqual({ transcriptions: [], remaining: [attachment] });
    expect(killed).toContain("SIGKILL");
  });

  it("adds an explicit unavailable-transcription note when voice transcription fails", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    const attachment = {
      type: "file" as const,
      mime: "audio/ogg",
      url: `data:audio/ogg;base64,${Buffer.from("ogg data").toString("base64")}`,
      filename: "voice.oga",
    };
    (handler as any).transcribeAudioAttachments = vi.fn().mockResolvedValue({
      transcriptions: [],
      remaining: [attachment],
    });

    let promptBody: any;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "audio-session" });
      }

      if (url === "http://opencode.test/session/audio-session/message" && method === "POST") {
        promptBody = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        return jsonResponse({ info: { role: "assistant", content: "ok" }, parts: [] });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await handler.handlePrompt(
      "msg-audio-unavailable",
      "[Voice note, 2s]",
      undefined,
      undefined,
      undefined,
      [attachment],
      "thread",
      "audio-thread",
    );

    expect(promptBody?.parts).toHaveLength(1);
    expect(promptBody.parts[0].text).toContain("[Voice note, 2s]");
    expect(promptBody.parts[0].text).toContain("transcription is unavailable");
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
  let attachmentTempDir: string | undefined;
  const originalAttachmentDir = process.env.VALET_PROMPT_ATTACHMENT_DIR;
  const originalWorkDir = process.env.WORK_DIR;

  const tinyPdfBase64 =
    "JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA2MTIgNzkyXSAvUmVzb3VyY2VzIDw8IC9Gb250IDw8IC9GMSA0IDAgUiA+PiA+PiAvQ29udGVudHMgNSAwIFIgPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iago1IDAgb2JqCjw8IC9MZW5ndGggNDUgPj4Kc3RyZWFtCkJUIC9GMSAyNCBUZiAxMDAgNzAwIFRkIChIZWxsbyBQREYpIFRqIEVUCmVuZHN0cmVhbQplbmRvYmoKeHJlZgowIDYKMDAwMDAwMDAwMCA2NTUzNSBmIAowMDAwMDAwMDA5IDAwMDAwIG4gCjAwMDAwMDAwNTggMDAwMDAgbiAKMDAwMDAwMDExNSAwMDAwMCBuIAowMDAwMDAwMjQxIDAwMDAwIG4gCjAwMDAwMDAzMTEgMDAwMDAgbiAKdHJhaWxlcgo8PCAvU2l6ZSA2IC9Sb290IDEgMCBSID4+CnN0YXJ0eHJlZgo0MDIKJSVFT0YK";

  beforeEach(() => {
    fetchCalls = [];
    attachmentTempDir = mkdtempSync(join(tmpdir(), "valet-pdf-test-"));
    process.env.VALET_PROMPT_ATTACHMENT_DIR = attachmentTempDir;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (attachmentTempDir) rmSync(attachmentTempDir, { recursive: true, force: true });
    if (originalAttachmentDir === undefined) {
      delete process.env.VALET_PROMPT_ATTACHMENT_DIR;
    } else {
      process.env.VALET_PROMPT_ATTACHMENT_DIR = originalAttachmentDir;
    }
    if (originalWorkDir === undefined) {
      delete process.env.WORK_DIR;
    } else {
      process.env.WORK_DIR = originalWorkDir;
    }
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

    await handler.handlePrompt(
      "msg-text-1",
      "please review this file",
      undefined,
      undefined,
      undefined,
      [{ type: "file", mime: "text/plain", url: dataUrl, filename: "notes.txt" }],
      "thread",
      "ch-text",
    );

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

    await handler.handlePrompt(
      "msg-json-1",
      "analyze this config",
      undefined,
      undefined,
      undefined,
      [{ type: "file", mime: "application/json", url: dataUrl, filename: "config.json" }],
      "thread",
      "ch-json",
    );

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

    await handler.handlePrompt(
      "msg-mixed-1",
      "check both files",
      undefined,
      undefined,
      undefined,
      [
        { type: "file", mime: "text/plain", url: textDataUrl, filename: "code.txt" },
        { type: "file", mime: "image/png", url: imageDataUrl, filename: "screenshot.png" },
      ],
      "thread",
      "ch-mixed",
    );

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

  it("materializes PDFs and parsed text to disk instead of embedding PDF text in context", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const dataUrl = `data:application/pdf;base64,${tinyPdfBase64}`;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "pdf-materialize-session" });
      }

      if (url === "http://opencode.test/session/pdf-materialize-session/message" && method === "POST") {
        return jsonResponse({ info: { role: "assistant", content: "ok" }, parts: [] });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await handler.handlePrompt(
      "msg-pdf-materialize-1",
      "please inspect this PDF",
      undefined,
      undefined,
      undefined,
      [{ type: "file", mime: "application/pdf", url: dataUrl, filename: "paper.pdf" }],
      "thread",
      "ch-pdf-materialize",
    );

    const syncCall = fetchCalls.find(
      (c) => c.url === "http://opencode.test/session/pdf-materialize-session/message" && c.method === "POST",
    );
    expect(syncCall).toBeDefined();
    const body = syncCall!.body as { parts: Array<{ type: string; text?: string }> };
    const textPart = body.parts.find((p) => p.type === "text");
    expect(textPart?.text).toContain('The user attached a PDF named "paper.pdf"');
    expect(textPart?.text).toContain("read the parsed text file");
    expect(textPart?.text).not.toContain('<attached-file name="paper.pdf" type="application/pdf">');

    const pdfPath = textPart?.text?.match(/Original PDF: ([^\n]+\.pdf)/)?.[1];
    const textPath = textPart?.text?.match(/Parsed text: ([^\n]+\.txt)/)?.[1];
    expect(pdfPath).toBeDefined();
    expect(textPath).toBeDefined();
    expect(existsSync(pdfPath!)).toBe(true);
    expect(existsSync(textPath!)).toBe(true);
    expect(readFileSync(pdfPath!).equals(Buffer.from(tinyPdfBase64, "base64"))).toBe(true);
    expect(readFileSync(textPath!, "utf8")).toContain("Hello PDF");
    expect(textPart?.text).not.toContain("Hello PDF");

    const fileParts = body.parts.filter((p) => p.type === "file");
    expect(fileParts).toHaveLength(0);
  });

  it("defaults PDF materialization to the workspace attachments directory", async () => {
    const workspaceDir = mkdtempSync(join(tmpdir(), "valet-workspace-test-"));
    delete process.env.VALET_PROMPT_ATTACHMENT_DIR;
    process.env.WORK_DIR = workspaceDir;

    try {
      const agentClient = createAgentClientMock();
      const handler = createHandler(agentClient);
      const dataUrl = `data:application/pdf;base64,${tinyPdfBase64}`;

      const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? "GET";
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
        fetchCalls.push({ url, method, body });

        if (url === "http://opencode.test/session" && method === "POST") {
          return jsonResponse({ id: "pdf-workspace-session" });
        }

        if (url === "http://opencode.test/session/pdf-workspace-session/message" && method === "POST") {
          return jsonResponse({ info: { role: "assistant", content: "ok" }, parts: [] });
        }

        throw new Error(`Unexpected fetch: ${method} ${url}`);
      });

      vi.stubGlobal("fetch", fetchMock);

      await handler.handlePrompt(
        "msg-pdf-workspace-1",
        "please inspect this PDF",
        undefined,
        undefined,
        undefined,
        [{ type: "file", mime: "application/pdf", url: dataUrl, filename: "paper.pdf" }],
        "thread",
        "ch-pdf-workspace",
      );

      const syncCall = fetchCalls.find(
        (c) => c.url === "http://opencode.test/session/pdf-workspace-session/message" && c.method === "POST",
      );
      const body = syncCall!.body as { parts: Array<{ type: string; text?: string }> };
      const textPart = body.parts.find((p) => p.type === "text");
      const pdfPath = textPart?.text?.match(/Original PDF: ([^\n]+\.pdf)/)?.[1];
      const textPath = textPart?.text?.match(/Parsed text: ([^\n]+\.txt)/)?.[1];

      expect(pdfPath).toContain(join(workspaceDir, ".valet", "attachments"));
      expect(textPath).toContain(join(workspaceDir, ".valet", "attachments"));
      expect(existsSync(pdfPath!)).toBe(true);
      expect(existsSync(textPath!)).toBe(true);
    } finally {
      rmSync(workspaceDir, { recursive: true, force: true });
    }
  });

  it("clamps long materialized PDF filenames and logs the truncation", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);
    const longFilename = `${"a".repeat(251)}.pdf`;
    const dataUrl = `data:application/pdf;base64,${tinyPdfBase64}`;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "pdf-long-name-session" });
      }

      if (url === "http://opencode.test/session/pdf-long-name-session/message" && method === "POST") {
        return jsonResponse({ info: { role: "assistant", content: "ok" }, parts: [] });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await handler.handlePrompt(
      "msg-pdf-long-name-1",
      "please inspect this PDF",
      undefined,
      undefined,
      undefined,
      [{ type: "file", mime: "application/pdf", url: dataUrl, filename: longFilename }],
      "thread",
      "ch-pdf-long-name",
    );

    const syncCall = fetchCalls.find(
      (c) => c.url === "http://opencode.test/session/pdf-long-name-session/message" && c.method === "POST",
    );
    const body = syncCall!.body as { parts: Array<{ type: string; text?: string }> };
    const textPart = body.parts.find((p) => p.type === "text");
    const pdfPath = textPart?.text?.match(/Original PDF: ([^\n]+\.pdf)/)?.[1];
    const textPath = textPart?.text?.match(/Parsed text: ([^\n]+\.txt)/)?.[1];

    expect(pdfPath).toBeDefined();
    expect(textPath).toBeDefined();
    expect(pdfPath!.split("/").at(-1)!.length).toBeLessThanOrEqual(240);
    expect(textPath!.split("/").at(-1)!.length).toBeLessThanOrEqual(240);
    expect(existsSync(pdfPath!)).toBe(true);
    expect(existsSync(textPath!)).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Truncated PDF attachment filename"));
  });

  it("surfaces runner attachment fetch failures instead of reporting an invalid data URL", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "pdf-fetch-failure-session" });
      }

      if (url === "http://opencode.test/session/pdf-fetch-failure-session/message" && method === "POST") {
        return jsonResponse({ info: { role: "assistant", content: "ok" }, parts: [] });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await handler.handlePrompt(
      "msg-pdf-fetch-failure-1",
      "",
      undefined,
      undefined,
      undefined,
      [
        {
          type: "file",
          mime: "application/pdf",
          url: "valet-prompt-attachment-error://msg-missing/0?reason=404%20Not%20Found",
          filename: "missing.pdf",
        },
      ],
      "thread",
      "ch-pdf-fetch-failure",
    );

    const syncCall = fetchCalls.find(
      (c) => c.url === "http://opencode.test/session/pdf-fetch-failure-session/message" && c.method === "POST",
    );
    const body = syncCall!.body as { parts: Array<{ type: string; text?: string }> };
    const textPart = body.parts.find((p) => p.type === "text");

    expect(textPart?.text).toContain('The user attached a PDF named "missing.pdf"');
    expect(textPart?.text).toContain("could not fetch the attachment payload");
    expect(textPart?.text).toContain("404 Not Found");
    expect(textPart?.text).not.toContain("invalid data URL");
  });

  it("keeps a visible PDF path when parsed text cannot be produced", async () => {
    const agentClient = createAgentClientMock();
    const handler = createHandler(agentClient);

    const invalidPdfDataUrl = `data:application/pdf;base64,${Buffer.from("%PDF-1.4\nnot a real pdf").toString("base64")}`;

    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
      fetchCalls.push({ url, method, body });

      if (url === "http://opencode.test/session" && method === "POST") {
        return jsonResponse({ id: "pdf-failure-session" });
      }

      if (url === "http://opencode.test/session/pdf-failure-session/message" && method === "POST") {
        return jsonResponse({ info: { role: "assistant", content: "ok" }, parts: [] });
      }

      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    await handler.handlePrompt(
      "msg-pdf-failure-1",
      "",
      undefined,
      undefined,
      undefined,
      [{ type: "file", mime: "application/pdf", url: invalidPdfDataUrl, filename: "broken.pdf" }],
      "thread",
      "ch-pdf-failure",
    );

    const syncCall = fetchCalls.find(
      (c) => c.url === "http://opencode.test/session/pdf-failure-session/message" && c.method === "POST",
    );
    expect(syncCall).toBeDefined();
    const body = syncCall!.body as { parts: Array<{ type: string; text?: string }> };
    const textPart = body.parts.find((p) => p.type === "text");
    expect(textPart).toBeDefined();
    expect(textPart?.text).toContain('The user attached a PDF named "broken.pdf"');
    expect(textPart?.text).toContain("Original PDF:");
    expect(textPart?.text).toContain("Parsed text could not be produced");
    const pdfPath = textPart?.text?.match(/Original PDF: ([^\n]+\.pdf)/)?.[1];
    expect(pdfPath).toBeDefined();
    expect(existsSync(pdfPath!)).toBe(true);
    expect(readFileSync(pdfPath!, "utf8")).toContain("%PDF-1.4");
    const fileParts = body.parts.filter((p) => p.type === "file");
    expect(fileParts).toHaveLength(0);
  });
});
