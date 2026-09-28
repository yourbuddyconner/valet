/**
 * The caller's DEFAULT assistant (Phase 4 decision 17/22).
 *
 *   POST /api/orchestrator → ensure the caller's default assistant session
 *                             exists (instant sandbox-less wake), return its id.
 *   GET  /api/orchestrator → probe only, never creates anything.
 *
 * A user owns any number of assistants. Every route here means the DEFAULT
 * one — the target a caller that named only a principal can be asking for.
 * `GET/POST/PATCH /api/assistants` (`routes/assistants.ts`) is where the
 * others are listed, created and administered, and a team's assistant is
 * reached through `POST /api/teams/:id/orchestrator`.
 *
 * `resolveDefaultAssistant` (`assistants/service.ts`) creates the default
 * row on first use. That row is not the engine session: it is one insert,
 * with no sandbox and no agent loop behind it. Routes below say which of
 * the two they create.
 */
import { parseAssistantSessionId } from "@valet/engine";
import { and, count, desc, eq, isNull, sql } from "drizzle-orm";
import { Hono } from "hono";
import { assistantOwner, canViewAssistantOwner } from "../assistants/access.js";
import {
  WORKSPACE_ASSISTANT_MESSAGE,
  ensureDefaultAssistantSession,
  findDefaultAssistant,
  loadAssistant,
  resolveDefaultAssistant,
} from "../assistants/service.js";
import type { AppEnv } from "../env.js";
import type { AppDb } from "../lib/drizzle.js";
import { userPrincipal, type RequestPrincipal } from "../lib/request-principal.js";
import { agentSessions, childWatches } from "../schema/index.js";
import { readOwnFile, type MemoryScope } from "../services/memory.js";
import { canViewSession } from "../services/session-access.js";
import type {
  EnsureOrchestratorResponse,
  GetOrchestratorChildrenResponse,
  GetOrchestratorInfoResponse,
  GetOrchestratorResponse,
  OrchestratorChildSummary,
  OrchestratorPresence,
} from "../wire/types.js";

export const orchestratorRouter = new Hono<AppEnv>();

/**
 * May the caller view the children of `parentSessionId`? A child run's parent
 * is an assistant session (`assistant:{id}`), so authority comes from the
 * assistant's OWNER — a team member reaches a team assistant's runs, the same
 * audience `canViewAssistantOwner` serves. Authorizing off the assistant row
 * (not an `agent_sessions` row) is what lets this work before the assistant's
 * engine session is ever materialized: `GET /orchestrator/info` hands out a
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

// ── Ensure (create-if-absent) ───────────────────────────────────────────────

orchestratorRouter.post("/", async (c) => {
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const principal = userPrincipal(user.id);

  const { sessionId } = await ensureDefaultAssistantSession({ db, engineHost }, principal, {
    actorUserId: user.id,
    orgId: user.orgId,
  });

  const body: EnsureOrchestratorResponse = { sessionId };
  return c.json(body, 200);
});

// ── Probe (no create) ───────────────────────────────────────────────────────

/**
 * Creates nothing — not the assistant row, not the engine session. A caller
 * with no default assistant yet gets `exists: false` and a null
 * `sessionId`, because there is no session to address until one exists. The
 * id is no longer derivable from the caller: an assistant addresses its
 * session by its own id, so only a lookup can supply one.
 */
orchestratorRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const assistant = await findDefaultAssistant(db, user.orgId, userPrincipal(user.id));

  const body: GetOrchestratorResponse = {
    sessionId: assistant?.sessionId ?? null,
    exists: assistant !== undefined,
  };
  return c.json(body);
});

// ── Info (identity + presence) ──────────────────────────────────────────────

/**
 * GET /api/orchestrator/info — decision 4. Never creates the engine session
 * or the `agent_sessions` row; a first-visit caller sees `name: null`.
 *
 * It DOES resolve (and therefore create) the caller's default assistant
 * row, because the response carries that assistant's `sessionId` and the id
 * is no longer derivable from the caller alone. The row costs one insert
 * and starts nothing.
 *
 * Presence source (documented per task-2 brief, "pick the cheapest honest
 * source"): `working` if any child_watches row is unsettled; else `thinking`
 * if the assistant is LIVE in this process (`engineHost.liveSession`,
 * which never builds/restores) and any of its threads has a running queue
 * item (`Thread.runningItemId()`); else `idle`. This collapses the wire
 * `status` event's finer-grained `thinking`/`tool_calling`/`streaming`
 * states into one bucket — a running item is "the assistant is doing
 * something", which is all the dashboard's presence dot needs — rather than
 * replaying/holding onto the transient per-turn status stream server-side.
 */
orchestratorRouter.get("/info", async (c) => {
  const { db, engineHost } = c.var.providers;
  const user = c.var.user;
  const principal = userPrincipal(user.id);

  const assistant = await resolveDefaultAssistant(db, user.orgId, principal);
  const sessionId = assistant.sessionId;
  const name = assistant.name;

  // The EFFECTIVE personality — the same precedence the wake path applies
  // (`resolvePersonaPrefix`): the assistants.personality column when set,
  // else the legacy assistant/personality.md memory file. Reporting only the
  // file here showed a persona that was not in effect once the assistant
  // editor wrote the column. Own-scope only — a team member's file must
  // never leak into this user's persona/info response (`readOwnFile`
  // bypasses `readFile`'s team read-union entirely).
  let personality: string | null = assistant.personality;
  if (personality === null) {
    const scope: MemoryScope = { owner: principal, actorUserId: user.id };
    const personalityRow = await readOwnFile(db, scope, "assistant/personality.md");
    personality = personalityRow ? personalityRow.content : null;
  }

  const unsettledRows = await db
    .select({ n: count() })
    .from(childWatches)
    .where(and(eq(childWatches.parentSessionId, sessionId), eq(childWatches.settled, false)))
    .limit(1);
  const activeChildren = unsettledRows[0]?.n ?? 0;

  let presence: OrchestratorPresence = "idle";
  if (activeChildren > 0) {
    presence = "working";
  } else {
    const live = engineHost.liveSession(sessionId);
    if (live && live.listThreads().some((t) => t.runningItemId() !== undefined)) {
      presence = "thinking";
    }
  }

  const body: GetOrchestratorInfoResponse = { sessionId, name, personality, presence, activeChildren };
  return c.json(body);
});

orchestratorRouter.patch("/info", (c) => c.json({ error: WORKSPACE_ASSISTANT_MESSAGE }, 409));

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
