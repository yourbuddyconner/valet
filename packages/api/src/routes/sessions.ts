import { Hono } from "hono";
import { and, count, desc, eq } from "drizzle-orm";
import type { AppEnv } from "../env.js";
import { agentSessions, messages as messagesTable } from "../schema/index.js";
import type {
  CreateSessionRequest,
  CreateSessionResponse,
  GetSessionResponse,
  ListSessionsResponse,
  SessionDetail,
  SessionStatus,
  SessionSummary,
} from "../wire/types.js";

export const sessionsRouter = new Hono<AppEnv>();

function newId(prefix: string): string {
  // Short URL-safe id; not cryptographic. Engine's own id collision domain is
  // separate (prefixed `sess-...` by the engine); we use `s_...` here.
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function rowToSummary(row: typeof agentSessions.$inferSelect): SessionSummary {
  return {
    id: row.id,
    workspace: row.workspace,
    status: row.status as SessionStatus,
    title: row.title ?? undefined,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ── List ──────────────────────────────────────────────────────────────────

sessionsRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;

  const rows = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.userId, userId), eq(agentSessions.status, "active")))
    .orderBy(desc(agentSessions.updatedAt))
    .all();

  const body: ListSessionsResponse = { sessions: rows.map(rowToSummary) };
  return c.json(body);
});

// ── Create ────────────────────────────────────────────────────────────────

sessionsRouter.post("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  let body: CreateSessionRequest;
  try {
    body = (await c.req.json()) as CreateSessionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (!body.workspace || typeof body.workspace !== "string") {
    return c.json({ error: "workspace is required" }, 400);
  }

  const now = Date.now();
  const id = newId("s");
  await db
    .insert(agentSessions)
    .values({
      id,
      userId: user.id,
      orgId: user.orgId,
      workspace: body.workspace,
      title: body.title ?? null,
      status: "active",
      createdAt: now,
      updatedAt: now,
    })
    .run();

  const detail: CreateSessionResponse = {
    id,
    workspace: body.workspace,
    status: "active",
    title: body.title,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
  };
  return c.json(detail, 201);
});

// ── Get ───────────────────────────────────────────────────────────────────

sessionsRouter.get("/:id", async (c) => {
  const { db } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  const row = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.userId, userId)))
    .get();
  if (!row) return c.json({ error: "session not found" }, 404);

  const [{ n }] = await db
    .select({ n: count() })
    .from(messagesTable)
    .where(eq(messagesTable.sessionId, id))
    .all();

  const detail: GetSessionResponse = {
    ...rowToSummary(row),
    messageCount: Number(n ?? 0),
  };
  return c.json(detail);
});

// ── Delete ────────────────────────────────────────────────────────────────

sessionsRouter.delete("/:id", async (c) => {
  const { db, engineHost } = c.var.providers;
  const id = c.req.param("id");
  const userId = c.var.user.id;

  const row = await db
    .select()
    .from(agentSessions)
    .where(and(eq(agentSessions.id, id), eq(agentSessions.userId, userId)))
    .get();
  if (!row) return c.json({ error: "session not found" }, 404);

  // Tear down engine + sandbox first; even if it fails we still want to soft-delete.
  await engineHost.destroy(id).catch((err) => {
    console.error(`engineHost.destroy(${id}) failed:`, err);
  });

  await db
    .update(agentSessions)
    .set({ status: "deleted", updatedAt: Date.now() })
    .where(eq(agentSessions.id, id))
    .run();

  return c.json({ ok: true });
});

export type SessionsRouter = typeof sessionsRouter;
