/**
 * Messages routes — the agent loop entry points.
 *
 * v1 scope: each session has a single implicit thread (the engine's
 * `web:default`). Multi-thread is a future enhancement; the wire shape
 * already carries `threadId` so adding more threads later doesn't break the
 * client.
 *
 *   GET  /api/sessions/:id/messages  → list messages on the default thread
 *   POST /api/sessions/:id/messages  → send prompt; engine streams via WS
 *   GET  /api/sessions/:id/threads   → returns the default thread (single-row)
 */
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import type { SessionEntry } from "@valet/engine";
import type { AppEnv } from "../env.js";
import { agentSessions } from "../schema/index.js";
import type {
  ListMessagesResponse,
  ListThreadsResponse,
  Message,
  MessagePart,
  MessageRole,
  SendPromptRequest,
  SendPromptResponse,
  ThreadSummary,
} from "../wire/types.js";
import { engineToWireParts } from "../engine/bridge.js";

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

messagesRouter.get("/:id/threads", async (c) => {
  const session = await loadOwnedSession(c);
  if (!session) return c.json({ error: "session not found" }, 404);

  // Materialize the engine's default thread so we can return its real id.
  const { engineHost } = c.var.providers;
  const engineSession = await engineHost.sessionFor(session.id, {
    userId: session.userId,
    orgId: session.orgId,
    workspace: session.workspace,
  });
  const thread = await engineSession.ensureDefaultThread();

  const summary: ThreadSummary = {
    id: thread.id,
    sessionId: session.id,
    title: undefined,
    createdAt: session.createdAt,
  };
  const body: ListThreadsResponse = { threads: [summary] };
  return c.json(body);
});

// ── Messages: list ────────────────────────────────────────────────────────

messagesRouter.get("/:id/messages", async (c) => {
  const session = await loadOwnedSession(c);
  if (!session) return c.json({ error: "session not found" }, 404);

  const { engineHost } = c.var.providers;
  const engineSession = await engineHost.sessionFor(session.id, {
    userId: session.userId,
    orgId: session.orgId,
    workspace: session.workspace,
  });
  const thread = await engineSession.ensureDefaultThread();

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
  const session = await loadOwnedSession(c);
  if (!session) return c.json({ error: "session not found" }, 404);

  let body: SendPromptRequest;
  try {
    body = (await c.req.json()) as SendPromptRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.text || typeof body.text !== "string") {
    return c.json({ error: "text is required" }, 400);
  }

  const { engineHost, db } = c.var.providers;
  const engineSession = await engineHost.sessionFor(session.id, {
    userId: session.userId,
    orgId: session.orgId,
    workspace: session.workspace,
  });
  const thread = engineSession.thread(); // default thread

  const receipt = await engineSession.prompt(body.text);

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
