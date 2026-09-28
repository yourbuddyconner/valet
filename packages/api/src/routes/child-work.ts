import { and, asc, count, desc, eq, exists, isNull, lt, or } from "drizzle-orm";
import { Hono } from "hono";
import { assistantOwner, canViewAssistantOwner } from "../assistants/access.js";
import { loadAssistantBySessionId } from "../assistants/service.js";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { decodePageCursor, encodePageCursor, readLimit } from "../lib/page-cursor.js";
import type { RequestPrincipal } from "../lib/request-principal.js";
import { agentSessions, childWatches } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import type { ChildWorkResponse } from "../wire/types.js";

export const childWorkRouter = new Hono<AppEnv>();
const ORDER = "running-created-id-v1";

/** Runtime metadata remains authoritative before its app session is materialized. */
async function canViewParent(db: AppDb, sessionId: string, orgId: string, principal: RequestPrincipal) {
  const runtime = await loadAssistantBySessionId(db, sessionId);
  if (runtime) return runtime.orgId === orgId && await canViewAssistantOwner(db, assistantOwner(runtime), principal)
    ? { type: runtime.ownerType, id: runtime.ownerId } : undefined;
  const [session] = await db.select().from(agentSessions)
    .where(and(eq(agentSessions.id, sessionId), eq(agentSessions.orgId, orgId))).limit(1);
  return session !== undefined && await canViewSession(db, session, principal)
    ? { type: session.ownerType, id: session.ownerId } : undefined;
}

childWorkRouter.get("/:sessionId/children", async (c) => {
  const { db } = c.var.providers;
  const parentSessionId = c.req.param("sessionId");
  const orgId = c.var.user.orgId;
  const owner = await canViewParent(db, parentSessionId, orgId, c.var.principal);
  if (!owner) return c.json({ error: "session not found" }, 404);
  const limit = readLimit(c.req.query("limit"), 25, 100);
  if (limit === undefined) return c.json({ error: "Send a positive whole number for limit." }, 400);
  const raw = c.req.query("cursor");
  const cursor = raw !== undefined && raw.length <= 4096 ? decodePageCursor(raw) : undefined;
  if (raw !== undefined && (!cursor || cursor.parentSessionId !== parentSessionId || cursor.order !== ORDER ||
    (cursor.settled !== 0 && cursor.settled !== 1) || typeof cursor.createdAt !== "number" || !Number.isSafeInteger(cursor.createdAt) ||
    typeof cursor.childSessionId !== "string" || cursor.childSessionId.length === 0)) {
    return c.json({ error: "Invalid child-work cursor. Remove it to start at the first page." }, 400);
  }
  const scope = and(eq(childWatches.parentSessionId, parentSessionId), eq(childWatches.orgId, orgId),
    eq(agentSessions.orgId, orgId), eq(agentSessions.ownerType, owner.type), eq(agentSessions.ownerId, owner.id), isNull(childWatches.dismissedAt));
  const after = cursor ? or(
    cursor.settled === 0 ? eq(childWatches.settled, true) : undefined,
    and(eq(childWatches.settled, cursor.settled === 1), or(
      lt(childWatches.createdAt, Number(cursor.createdAt)),
      and(eq(childWatches.createdAt, Number(cursor.createdAt)), lt(childWatches.childSessionId, String(cursor.childSessionId))),
    )),
  ) : undefined;
  const [rows, counts] = await Promise.all([
    db.select({ sessionId: childWatches.childSessionId, title: agentSessions.title, parentThreadId: childWatches.parentThreadId,
      settled: childWatches.settled, createdAt: childWatches.createdAt }).from(childWatches)
      .innerJoin(agentSessions, eq(agentSessions.id, childWatches.childSessionId)).where(and(scope, after))
      .orderBy(asc(childWatches.settled), desc(childWatches.createdAt), desc(childWatches.childSessionId)).limit(limit + 1),
    db.select({ n: count() }).from(childWatches).innerJoin(agentSessions, eq(agentSessions.id, childWatches.childSessionId))
      .where(and(scope, eq(childWatches.settled, false))),
  ]);
  const visible = rows.slice(0, limit);
  const last = visible.at(-1);
  const response: ChildWorkResponse = {
    children: visible.map(row => ({ sessionId: row.sessionId, title: row.title ?? row.sessionId,
      parentThreadId: row.parentThreadId, status: row.settled ? "settled" : "running", createdAt: row.createdAt })),
    runningCount: counts[0]?.n ?? 0,
    nextCursor: rows.length > limit && last ? encodePageCursor({ parentSessionId, order: ORDER, settled: last.settled ? 1 : 0,
      createdAt: last.createdAt, childSessionId: last.sessionId }) : null,
  };
  return c.json(response);
});

childWorkRouter.post("/:sessionId/children/:childSessionId/dismiss", async (c) => {
  const { db } = c.var.providers;
  const parentSessionId = c.req.param("sessionId");
  const childSessionId = c.req.param("childSessionId");
  const orgId = c.var.user.orgId;
  const owner = await canViewParent(db, parentSessionId, orgId, c.var.principal);
  if (!owner) return c.json({ error: "child not found" }, 404);
  const scope = and(eq(childWatches.parentSessionId, parentSessionId), eq(childWatches.childSessionId, childSessionId), eq(childWatches.orgId, orgId),
    exists(db.select({ id: agentSessions.id }).from(agentSessions).where(and(eq(agentSessions.id, childSessionId),
      eq(agentSessions.orgId, orgId), eq(agentSessions.ownerType, owner.type), eq(agentSessions.ownerId, owner.id)))));
  const [watch] = await db.select().from(childWatches).where(scope).limit(1);
  if (!watch) return c.json({ error: "child not found" }, 404);
  if (!watch.settled) return c.json({ error: "Child is still running. Wait for it to settle, then dismiss it." }, 409);
  await db.update(childWatches).set({ dismissedAt: Date.now() })
    .where(and(scope, eq(childWatches.settled, true), isNull(childWatches.dismissedAt)));
  return c.json({ ok: true });
});
