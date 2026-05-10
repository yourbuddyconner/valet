/**
 * Messages + threads routes — the agent loop entry points.
 *
 * Each session has a default engine thread (`web:default`); the user can
 * create additional threads via POST /threads. Subsequent calls to
 * /messages can target any thread by id (defaults to the default thread
 * when omitted, so single-thread clients keep working).
 *
 *   GET  /api/sessions/:id/threads   → all threads for the session
 *   POST /api/sessions/:id/threads   → create a new engine thread
 *   GET  /api/sessions/:id/messages  → list messages (?threadId=…)
 *   POST /api/sessions/:id/messages  → send prompt (body.threadId optional)
 */
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import type { SessionEntry, Session as EngineSession } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { agentSessions } from "../schema/index.js";
import type {
  CreateThreadRequest,
  CreateThreadResponse,
  ListDecisionsResponse,
  ListMessagesResponse,
  ListThreadsResponse,
  Message,
  MessagePart,
  MessageRole,
  ResolveDecisionRequest,
  SendPromptRequest,
  SendPromptResponse,
  ThreadSummary,
  WithdrawDecisionRequest,
} from "../wire/types.js";
import { engineGateToWire, engineToWireParts } from "../engine/bridge.js";

export const messagesRouter = new Hono<AppEnv>();

async function loadOwnedSession(c: Context<AppEnv>) {
  const { db } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;
  const row = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.userId, userId)))
    .get();
  return row ?? null;
}

function entryToMessage(e: SessionEntry, sessionId: string, threadId: string): Message | null {
  if (e.type !== "message") return null;
  // Engine has 4 roles: user/assistant/tool/system. We forward as-is.
  const role: MessageRole = e.role;
  const parts: MessagePart[] = engineToWireParts(e.parts);
  // Engine entries have createdAt as `string` (ISO-ish) per BaseEntry. Coerce
  // to number for the wire.
  const created = typeof e.createdAt === "number" ? e.createdAt : Date.parse(e.createdAt as unknown as string);
  return {
    id: e.id,
    sessionId,
    threadId,
    role,
    content: e.content,
    parts,
    createdAt: Number.isFinite(created) ? created : Date.now(),
  };
}

// ── Threads ───────────────────────────────────────────────────────────────

function threadToSummary(
  threadId: string,
  createdAt: number,
  sessionId: string,
  title?: string,
  model?: string,
): ThreadSummary {
  return { id: threadId, sessionId, title, createdAt, model };
}

async function loadEngineSession(
  c: Context<AppEnv>,
): Promise<{ session: typeof agentSessions.$inferSelect; engineSession: EngineSession } | { error: Response }> {
  const session = await loadOwnedSession(c);
  if (!session) return { error: c.json({ error: "session not found" }, 404) };
  const { engineHost } = c.var.providers;
  const engineSession = await engineHost.sessionFor(session.id, {
    userId: session.userId,
    orgId: session.orgId,
    workspace: session.workspace,
  });
  return { session, engineSession };
}

messagesRouter.get("/:id/threads", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  await engineSession.ensureDefaultThread();
  const threads = engineSession.listThreads();
  const summaries = threads.map((t) =>
    threadToSummary(
      t.id,
      t.toThreadData().createdAt,
      session.id,
      undefined,
      t.modelId(),
    ),
  );
  const body: ListThreadsResponse = { threads: summaries };
  return c.json(body);
});

messagesRouter.patch("/:id/threads/:threadId", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  const threadId = c.req.param("threadId");
  const thread = engineSession.threadById(threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  let body: { model?: string | null };
  try {
    body = (await c.req.json()) as { model?: string | null };
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.model === undefined) {
    return c.json({ error: "model is required (use null to clear)" }, 400);
  }

  try {
    await thread.setModel(
      typeof body.model === "string" ? body.model : null,
    );
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }

  const summary = threadToSummary(
    thread.id,
    thread.toThreadData().createdAt,
    session.id,
    undefined,
    thread.modelId(),
  );
  return c.json(summary);
});

messagesRouter.post("/:id/threads", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  let body: CreateThreadRequest = {};
  try {
    const text = await c.req.text();
    body = text ? (JSON.parse(text) as CreateThreadRequest) : {};
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  // Engine identifies threads by `key`; we generate a fresh one so each
  // POST creates a new thread (calling thread() with an existing key
  // returns the cached one).
  const key = `web:${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const thread = engineSession.thread(key);
  const summary: CreateThreadResponse = threadToSummary(
    thread.id,
    thread.toThreadData().createdAt,
    session.id,
    body.title,
    thread.modelId(),
  );
  return c.json(summary, 201);
});

/**
 * Resolve the target thread from a `?threadId=` query param or body field.
 * Returns either the matching engine Thread, or the session's default thread
 * when no id was supplied. Returns null if a specific id was given but no
 * thread matches — caller should 404.
 */
function resolveThread(
  engineSession: EngineSession,
  threadId: string | undefined,
) {
  if (!threadId) return engineSession.thread();
  return engineSession.threadById(threadId);
}

// ── Messages: list ────────────────────────────────────────────────────────

messagesRouter.get("/:id/messages", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;

  await engineSession.ensureDefaultThread();
  const requested = c.req.query("threadId") || undefined;
  const thread = resolveThread(engineSession, requested);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  const limit = Number.parseInt(c.req.query("limit") ?? "100", 10);
  const cursor = c.req.query("cursor") ?? undefined;
  const entries = await thread.readEntries({ limit, cursor });

  const messages = entries
    .map((e) => entryToMessage(e, session.id, thread.id))
    .filter((m): m is Message => m !== null);

  const body: ListMessagesResponse = {
    messages,
    hasMore: entries.length === limit,
    nextCursor: undefined, // engine cursor pagination is opaque; revisit if needed
  };
  return c.json(body);
});

// ── Messages: send prompt ─────────────────────────────────────────────────

messagesRouter.post("/:id/messages", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { session, engineSession } = result;
  const { db } = c.var.providers;

  let body: SendPromptRequest;
  try {
    body = (await c.req.json()) as SendPromptRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.text || typeof body.text !== "string") {
    return c.json({ error: "text is required" }, 400);
  }

  await engineSession.ensureDefaultThread();
  const thread = resolveThread(engineSession, body.threadId);
  if (!thread) return c.json({ error: "thread not found" }, 404);

  const receipt = await thread.submitPrompt(body.text, {});

  // Touch the session row so list ordering reflects recency.
  await db
    .update(agentSessions)
    .set({ updatedAt: Date.now() })
    .where(eq(agentSessions.id, session.id))
    .run();

  const resp: SendPromptResponse = {
    messageId: receipt.queueItemId,
    threadId: thread.id,
  };
  return c.json(resp, 202);
});

// ── Decision gates ────────────────────────────────────────────────────────
//
// A gate is created by a tool calling `ctx.requestDecision(...)`. The engine
// emits `decision_gate` on the bus (forwarded to the WS by the bridge) and
// suspends the thread on `blocked_on_decision_gate` status. The user resolves
// or withdraws via these endpoints, which routes to `Session.resolveDecision`
// / `Session.withdrawDecision` — which finds the thread that owns the gate
// and unblocks it.

messagesRouter.get("/:id/decisions", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;

  const pending = await engineSession.pendingDecisionGates();
  const body: ListDecisionsResponse = { gates: pending.map(engineGateToWire) };
  return c.json(body);
});

messagesRouter.post("/:id/decisions/:gateId/resolve", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;
  const gateId = c.req.param("gateId");

  let body: ResolveDecisionRequest;
  try {
    body = (await c.req.json()) as ResolveDecisionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.actionId === undefined && body.value === undefined) {
    return c.json({ error: "actionId or value is required" }, 400);
  }

  // Confirm the gate is actually pending in this session before resolving.
  // Without this check, a stale gateId from the client would silently no-op.
  const pending = await engineSession.pendingDecisionGates();
  const gate = pending.find((g) => g.id === gateId);
  if (!gate) return c.json({ error: "gate not pending" }, 404);

  await engineSession.resolveDecision(gateId, {
    actionId: body.actionId,
    value: body.value,
    resolvedBy: c.var.user.id,
    resolvedAt: Date.now(),
    source: { channelType: "web" },
  });
  return c.json({ ok: true });
});

messagesRouter.post("/:id/decisions/:gateId/withdraw", async (c) => {
  const result = await loadEngineSession(c);
  if ("error" in result) return result.error;
  const { engineSession } = result;
  const gateId = c.req.param("gateId");

  let body: WithdrawDecisionRequest = {};
  try {
    const text = await c.req.text();
    body = text ? (JSON.parse(text) as WithdrawDecisionRequest) : {};
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  // The user-initiated path should always be `cancel`. `steer` and `abort`
  // are engine-internal reasons; reject them so we don't end up with
  // misleading audit records.
  const reason = body.reason ?? "cancel";
  if (reason !== "cancel") {
    return c.json({ error: "only reason='cancel' is allowed from clients" }, 400);
  }

  const pending = await engineSession.pendingDecisionGates();
  const gate = pending.find((g) => g.id === gateId);
  if (!gate) return c.json({ error: "gate not pending" }, 404);

  await engineSession.withdrawDecision(gateId, reason);
  return c.json({ ok: true });
});
