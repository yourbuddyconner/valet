/** Child execution discovery and dismissal. Runtime access lives under /workspaces. */
import { parseAssistantSessionId } from "@valet/engine";
import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { assistantOwner, canViewAssistantOwner } from "../assistants/access.js";
import {
  findDefaultAssistant,
  loadAssistant,
} from "../assistants/service.js";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { userPrincipal, type RequestPrincipal } from "../lib/request-principal.js";
import { agentSessions, childWatches } from "../schema/index.js";
import { canViewSession } from "../services/session-access.js";
import type {
  GetOrchestratorChildrenResponse,
  OrchestratorChildSummary,
} from "../wire/types.js";

export const orchestratorRouter = new Hono<AppEnv>();

/**
 * May the caller view the children of `parentSessionId`? A child run's parent
 * is an assistant session (`assistant:{id}`), so authority comes from the
 * assistant's OWNER — a team member reaches a team assistant's runs, the same
 * audience `canViewAssistantOwner` serves. Authorizing off the assistant row
 * (not an `agent_sessions` row) is what lets this work before the assistant's
 * engine session is ever materialized: the workspace runtime info route hands out a
 * session id without writing that row. A non-assistant parent (not produced by
 * any spawn path today) falls back to the session row's own view check.
 * Returns false when neither resolves.
 */
async function canViewChildrenOf(
  db: AppDb,
  parentSessionId: string,
  caller: RequestPrincipal,
): Promise<boolean> {
  const assistantId = parseAssistantSessionId(parentSessionId);
  if (assistantId !== null) {
    const row = await loadAssistant(db, assistantId);
    return row ? canViewAssistantOwner(db, assistantOwner(row), caller) : false;
  }
  const rows = await db
    .select()
    .from(agentSessions)
    .where(eq(agentSessions.id, parentSessionId))
    .limit(1);
  const row = rows[0];
  return row ? canViewSession(db, row, caller) : false;
}

// ── Children ─────────────────────────────────────────────────────────────

/** GET /api/orchestrator/children — decision 6: `child_watches` ⋈
 * `agent_sessions` for one assistant, newest first. Creates nothing: an
 * assistant with no children answers the empty list honestly. `outcome` is
 * never populated this pass — `child_watches` has no outcome column, and
 * decision 6 marks deriving one (e.g. from the engine store's submission
 * outcome) as an optional future improvement, not required here; the UI only
 * needs `status: 'settled'` to show a checkmark.
 *
 * `?sessionId=` names WHICH assistant session to list children for. The chat
 * thread tree passes the OPEN assistant's session id, so a TEAM assistant's
 * runs — e.g. a team worker trigger's child — nest under it the same way your
 * own default's do. Any session the caller can view (`canViewSession`, so a
 * team member reaches a team assistant) is allowed; existence-hiding 404s the
 * rest. Absent = your own default assistant, the original behavior a caller
 * that named only itself is asking for. */
orchestratorRouter.get("/children", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const scopedSessionId = c.req.query("sessionId");
  let parentSessionId: string;
  if (scopedSessionId !== undefined) {
    // Existence-hiding: an unknown id and one the caller cannot view answer
    // the same 404 every cross-owner session read here uses.
    if (!(await canViewChildrenOf(db, scopedSessionId, c.var.principal))) {
      return c.json({ error: "session not found" }, 404);
    }
    parentSessionId = scopedSessionId;
  } else {
    const assistant = await findDefaultAssistant(db, user.orgId, userPrincipal(user.id));
    if (!assistant) {
      const empty: GetOrchestratorChildrenResponse = { children: [] };
      return c.json(empty);
    }
    parentSessionId = assistant.sessionId;
  }

  const rows = await db
    .select({
      sessionId: childWatches.childSessionId,
      parentThreadId: childWatches.parentThreadId,
      settled: childWatches.settled,
      createdAt: childWatches.createdAt,
      title: agentSessions.title,
    })
    .from(childWatches)
    .innerJoin(agentSessions, eq(agentSessions.id, childWatches.childSessionId))
    .where(
      and(
        eq(childWatches.parentSessionId, parentSessionId),
        isNull(childWatches.dismissedAt),
      ),
    )
    .orderBy(desc(sql`COALESCE(${agentSessions.lastActivityAt}, ${childWatches.createdAt})`));

  const children: OrchestratorChildSummary[] = rows.map((r) => ({
    sessionId: r.sessionId,
    title: r.title ?? r.sessionId,
    parentThreadId: r.parentThreadId,
    status: r.settled ? "settled" : "running",
    createdAt: r.createdAt,
  }));

  const body: GetOrchestratorChildrenResponse = { children };
  return c.json(body);
});

/** POST /children/:childSessionId/dismiss — hide a settled child from the
 * tree. Display state only: the watch row gets `dismissed_at`, the child
 * session and its history stay reachable from the Sessions page. */
orchestratorRouter.post("/children/:childSessionId/dismiss", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const childSessionId = c.req.param("childSessionId");

  // Authority comes from the watch row's PARENT session, not the caller's own
  // default assistant: a team assistant's child is dismissed by any member who
  // can view that assistant, the same audience the scoped children list serves.
  // Deriving the parent from the caller's default (the old behavior) 404'd
  // every team child even when the caller could see it.
  const rows = await db
    .select({ parentSessionId: childWatches.parentSessionId, settled: childWatches.settled })
    .from(childWatches)
    .where(eq(childWatches.childSessionId, childSessionId))
    .limit(1);
  const watch = rows[0];
  if (!watch) return c.json({ error: "child not found" }, 404);

  // Existence-hiding: a child whose parent assistant the caller cannot view
  // answers the same "not found" a missing child does.
  if (!(await canViewChildrenOf(db, watch.parentSessionId, c.var.principal))) {
    return c.json({ error: "child not found" }, 404);
  }
  if (!watch.settled) {
    return c.json(
      { error: "child is still running. Wait for it to settle, then dismiss it." },
      409,
    );
  }

  // The UPDATE carries the full invariant, not just ownership (house
  // pattern: guarded updates own their WHERE, e.g. `writeHibernated`):
  // settled — never hide a row that flipped back to running; dismissedAt
  // IS NULL — a repeat dismiss is a no-op that keeps the first timestamp.
  await db
    .update(childWatches)
    .set({ dismissedAt: Date.now() })
    .where(
      and(
        eq(childWatches.childSessionId, childSessionId),
        eq(childWatches.parentSessionId, watch.parentSessionId),
        eq(childWatches.settled, true),
        isNull(childWatches.dismissedAt),
      ),
    );
  return c.json({ ok: true });
});
