/**
 * Notifications — web delivery surface for the attention router (Phase 4
 * decision 19).
 *
 *   GET  /api/notifications?unread=1     → caller's own rows, newest first, limit 50
 *   POST /api/notifications/:id/read     → mark one of the caller's own rows read
 *   POST /api/notifications/read-all     → mark every unread row of the caller's read
 *   GET  /api/notifications/preferences  → caller's web-delivery preference per kind
 *   PUT  /api/notifications/preferences  → upsert caller's preference for one kind
 *
 * Own-rows-only: every route scopes by `c.var.user.id`. A caller can never
 * see or mark another user's notification — an `:id` belonging to someone
 * else 404s, same existence-hiding treatment used elsewhere in this
 * package (teams.ts) for cross-tenant access.
 *
 * Preferences mirror `isWebEnabled`'s default in `orchestrator/attention.ts`:
 * a kind with no row reports `web: true` and `teamDm: false`.
 */
import { Hono } from "hono";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { NotFoundError } from "@valet/shared";
import type { AppEnv } from "../env.js";
import { agentSessions, workflowRuns, workflowDefinitions, notifications, userNotificationPreferences, type NotificationRow } from "../schema/index.js";
import { canResolveSessionGate } from "../services/session-access.js";
import { engineGateToWire } from "../engine/bridge.js";
import type {
  ListNotificationPreferencesResponse,
  ListNotificationsResponse,
  ListNotificationDecisionsResponse,
  NotificationKind,
  NotificationSummary,
  SetNotificationPreferenceRequest,
} from "../wire/types.js";

export const notificationsRouter = new Hono<AppEnv>();

/** Read durable gates without waking their sessions or relying on notification read state. */
notificationsRouter.get("/decisions", async (c) => {
  const { db, engineStore } = c.var.providers;
  const sessions = await db.select().from(agentSessions).where(and(
    eq(agentSessions.orgId, c.var.user.orgId),
    ne(agentSessions.status, "deleted"),
    sql`EXISTS (SELECT 1 FROM engine_decision_gates g WHERE g.session_id = ${agentSessions.id} AND g.status = 'pending')`,
  ));
  const items: ListNotificationDecisionsResponse["items"] = [];
  for (const session of sessions) {
    if (!await canResolveSessionGate(db, session, c.var.principal)) continue;
    const gates = await engineStore.listDecisionGates(session.id, undefined, "pending");
    for (const gate of gates) items.push({ sessionId: session.id, title: session.title || "Thread approval", gate: engineGateToWire(gate) });
  }
  // Workflow agent sessions have no app session row. Their run owns the gates.
  const workflowSessions = await db.selectDistinct({
    session_id: sql<string>`g.session_id`,
    owner_type: workflowRuns.ownerType, owner_id: workflowRuns.ownerId, title: workflowDefinitions.name,
  }).from(sql`engine_decision_gates g`)
    .innerJoin(workflowRuns, sql`${workflowRuns.id} = split_part(g.session_id, ':', 2)`)
    .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
    .where(and(eq(workflowDefinitions.orgId, c.var.user.orgId), sql`g.status = 'pending' and g.session_id LIKE 'wf:%'`));
  for (const session of workflowSessions) {
    if (!await canResolveSessionGate(db, {
      ownerType: session.owner_type, ownerId: session.owner_id,
      userId: session.owner_type === "user" ? session.owner_id : "",
    }, c.var.principal)) continue;
    const gates = await engineStore.listDecisionGates(session.session_id, undefined, "pending");
    for (const gate of gates) {
      if (!items.some(item => item.gate.id === gate.id)) {
        items.push({ sessionId: session.session_id, title: session.title, gate: engineGateToWire(gate) });
      }
    }
  }
  return c.json({ items } satisfies ListNotificationDecisionsResponse);
});

const NOTIFICATION_KINDS: NotificationKind[] = ["notification", "question", "escalation", "approval", "review"];

function rowToSummary(row: NotificationRow): NotificationSummary {
  return {
    id: row.id,
    kind: row.kind as NotificationSummary["kind"],
    urgency: row.urgency as NotificationSummary["urgency"],
    title: row.title,
    body: row.body ?? undefined,
    href: row.href ?? undefined,
    sessionId: row.sessionId ?? undefined,
    createdAt: row.createdAt,
    readAt: row.readAt ?? undefined,
  };
}

notificationsRouter.get("/", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;
  const unreadOnly = c.req.query("unread") === "1";

  const rows = await db
    .select()
    .from(notifications)
    .where(
      unreadOnly
        ? and(eq(notifications.userId, userId), isNull(notifications.readAt))
        : eq(notifications.userId, userId),
    )
    .orderBy(desc(notifications.createdAt))
    .limit(50);

  const body: ListNotificationsResponse = { notifications: rows.map(rowToSummary) };
  return c.json(body);
});

notificationsRouter.post("/:id/read", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;
  const id = c.req.param("id");

  const rows = await db.select().from(notifications).where(eq(notifications.id, id)).limit(1);
  const row = rows[0];
  if (!row || row.userId !== userId) {
    const err = new NotFoundError("notification", id);
    return c.json({ error: err.message, code: err.code }, 404);
  }

  await db
    .update(notifications)
    .set({ readAt: row.readAt ?? Date.now() })
    .where(eq(notifications.id, id));

  return c.json({ ok: true });
});

notificationsRouter.post("/read-all", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;

  await db
    .update(notifications)
    .set({ readAt: Date.now() })
    .where(and(eq(notifications.userId, userId), isNull(notifications.readAt)));

  return c.json({ ok: true });
});

notificationsRouter.get("/preferences", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;

  const rows = await db
    .select()
    .from(userNotificationPreferences)
    .where(eq(userNotificationPreferences.userId, userId));
  const byKind = new Map(rows.map((r) => [r.kind, r]));

  const preferences = NOTIFICATION_KINDS.map((kind) => ({
    kind,
    web: byKind.get(kind)?.web ?? true,
    teamDm: byKind.get(kind)?.teamDm ?? false,
  }));

  const body: ListNotificationPreferencesResponse = { preferences };
  return c.json(body);
});

notificationsRouter.put("/preferences", async (c) => {
  const { db } = c.var.providers;
  const userId = c.var.user.id;

  let body: SetNotificationPreferenceRequest;
  try {
    body = (await c.req.json()) as SetNotificationPreferenceRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body === null || typeof body !== "object") return c.json({ error: "body must be an object" }, 400);
  if (!NOTIFICATION_KINDS.includes(body.kind)) {
    return c.json({ error: `kind must be one of ${NOTIFICATION_KINDS.join(", ")}` }, 400);
  }
  if (typeof body.web !== "boolean") {
    return c.json({ error: "web must be a boolean" }, 400);
  }

  if (body.teamDm !== undefined && typeof body.teamDm !== "boolean") {
    return c.json({ error: "teamDm must be a boolean. Choose whether to receive team direct messages." }, 400);
  }

  await db
    .insert(userNotificationPreferences)
    .values({ userId, kind: body.kind, web: body.web, teamDm: body.teamDm ?? false })
    .onConflictDoUpdate({
      target: [userNotificationPreferences.userId, userNotificationPreferences.kind],
      set: { web: body.web, ...(body.teamDm === undefined ? {} : { teamDm: body.teamDm }) },
    });

  return c.json({ ok: true });
});
