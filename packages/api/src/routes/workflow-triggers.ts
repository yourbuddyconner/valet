/**
 * `/api/workflows/{triggers,schedules,event-triggers,trigger-catalog}`
 * (spec 2026-08-15). Aggregated trigger read + kind-specific writes over
 * `schedule-service` / `trigger-service` / `WorkflowScheduler.fireNow`.
 *
 * MOUNT ORDER MATTERS: this router must be mounted on `/api/workflows`
 * BEFORE `workflowsRouter`, whose `GET /:id` would otherwise swallow
 * `/triggers` as a workflow id.
 */
import { getLinearIngressStatus } from "../services/linear-ingress.js";
import { Hono } from "hono";
import type { Context } from "hono";
import type { AppEnv } from "../env.js";
import {
  isAuthorizedForOwner,
  parseWorkflowOwnerFilter,
  triggerAccessSets,
  type WorkflowOwner,
} from "../workflows/service.js";
import { resolveCreateOwner } from "../lib/request-principal.js";
import { isTeamMember } from "../services/teams.js";
import type { TeamServiceReadinessDeps } from "../workflows/team-service-readiness.js";
import {
  createWorkflowSchedule,
  deleteWorkflowSchedule,
  listWorkflowSchedules,
  updateWorkflowSchedule,
} from "../workflows/schedule-service.js";
import {
  createWorkflowTrigger,
  deleteWorkflowTrigger,
  listEventTypes,
  listWorkflowTriggers,
  updateWorkflowTrigger,
} from "../workflows/trigger-service.js";
import type {
  CreateWorkflowEventTriggerRequest,
  CreateWorkflowScheduleRequest,
  GetWorkflowTriggerCatalogResponse,
  ListWorkflowTriggersResponse,
  UpdateWorkflowEventTriggerRequest,
  UpdateWorkflowScheduleRequest,
  WorkflowEventTriggerResponse,
  WorkflowScheduleResponse,
  WorkflowTriggerItem,
} from "../wire/types.js";

export const workflowTriggersRouter = new Hono<AppEnv>();

/** The caller as a `WorkflowOwner` — one construction for every handler,
 * so a change to the user context or the owner shape lands in one place.
 * The principal rides along: a team key reaches its team's rows only, and
 * keeps reaching them after the creating admin leaves. */
function ownerFrom(c: Context<AppEnv>): WorkflowOwner {
  return { userId: c.var.user.id, orgId: c.var.user.orgId, principal: c.var.principal };
}

/** The credential reads the team arm gate makes before a schedule or a
 * trigger arms (`workflows/team-service-readiness.ts#teamArmBlock`). */
function armDeps(c: Context<AppEnv>): TeamServiceReadinessDeps {
  const { db, engineCredentials, plugins, onePassword } = c.var.providers;
  return { db, credentials: engineCredentials, plugins, onePassword };
}

const CRON_HINT = ' Use 5 fields, for example "0 9 * * 1-5" (09:00 on weekdays).';

/** Cron/timezone service errors get the example appended once. */
function withCronHint(error: string): string {
  return error.includes("cron") ? error + CRON_HINT : error;
}

workflowTriggersRouter.get("/triggers", async (c) => {
  const { db } = c.var.providers;
  const owner = ownerFrom(c);
  const workflowId = c.req.query("workflowId") || undefined;

  // Optional `?ownerType=&ownerId=` scope: the hub's flat Triggers tab pins
  // one workspace, the same shape `GET /workflows` and `GET /workflows/runs`
  // take. A filter the caller may not use 404s like one that matches nothing.
  const filter = parseWorkflowOwnerFilter(c.req.query("ownerType"), c.req.query("ownerId"));
  if (filter.error) return c.json({ error: filter.error }, 400);
  if (filter.scope && !(await isAuthorizedForOwner(db, owner, filter.scope))) {
    return c.json({ error: "owner not found" }, 404);
  }

  // One access-set build serves both lists (unused when a scope narrows them).
  const sets = filter.scope ? undefined : await triggerAccessSets(db, owner);
  const [schedules, events] = await Promise.all([
    listWorkflowSchedules(db, owner, workflowId, sets, filter.scope),
    listWorkflowTriggers(db, owner, workflowId, sets, filter.scope),
  ]);
  const triggers: WorkflowTriggerItem[] = [
    ...schedules.map((s): WorkflowTriggerItem => ({
      kind: "schedule",
      id: s.scheduleId,
      workflowId: s.workflowId,
      name: s.name,
      enabled: s.enabled,
      detail: {
        cron: s.cron,
        timezone: s.timezone,
        targetKind: s.targetKind,
        prompt: s.prompt,
        input: s.input,
        nextFireAt: s.nextFireAt,
        lastFiredAt: s.lastFiredAt,
      },
    })),
    ...events.map((t): WorkflowTriggerItem => ({
      kind: "event",
      id: t.triggerId,
      workflowId: t.workflowId,
      name: t.name,
      enabled: t.enabled,
      detail: { eventKeys: t.eventKeys, filters: t.filters },
    })),
  ];
  const resp: ListWorkflowTriggersResponse = { triggers };
  return c.json(resp);
});

workflowTriggersRouter.get("/trigger-catalog", async (c) => {
  const { db, engineCredentials, plugins } = c.var.providers;
  const catalog = listEventTypes(plugins);
  const linear = catalog.some(item => item.service === "linear")
    ? await getLinearIngressStatus(db,engineCredentials,c.var.user.orgId) : undefined;
  const resp: GetWorkflowTriggerCatalogResponse = {
    catalog: catalog.map(item => item.service === "linear" && linear ? { ...item, readiness: { ready: linear.ready, ...(linear.reason ? { reason: linear.reason } : {}) } } : item),
  };
  return c.json(resp);
});

// `GET /api/workflows/runs` is not here. One cross-workflow run list serves
// the hub's Runs tab and every filtered read, in `routes/workflows.ts`:
// two handlers on one path meant the first mount silently won, and the
// filters, the 404 on an unreadable workflow id, and the cursor checks all
// stopped working.

// ── Schedules ────────────────────────────────────────────────────────────

workflowTriggersRouter.post("/schedules", async (c) => {
  const { db } = c.var.providers;
  const owner = ownerFrom(c);

  let body: CreateWorkflowScheduleRequest;
  try {
    body = (await c.req.json()) as CreateWorkflowScheduleRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object." }, 400);
  }
  if (!body.name || typeof body.name !== "string") {
    return c.json({ error: "name is required" }, 400);
  }
  if (body.target && typeof body.target === "object" && "assistantId" in body.target) return c.json({ error: "Choose a workspace instead of an assistant." }, 400);
  if (!body.target || (body.target.kind !== "workflow" && body.target.kind !== "orchestrator")) {
    return c.json(
      {
        error:
          'target.kind must be "workflow" (start a run) or "orchestrator" (send a prompt)',
      },
      400,
    );
  }
  // An orchestrator-prompt schedule created in a team workspace fires the
  // TEAM's assistant, so it is team-owned. `resolveCreateOwner` settles the
  // owner before anything is written: a cookie caller's team id needs live
  // membership (a non-member's id 404s like an unknown one), a personal key
  // cannot name a team, and a team key always schedules as its own team. A
  // workflow-target schedule ignores teamId (its owner follows the workflow).
  let teamId: string | undefined;
  if (body.target.kind === "orchestrator") {
    const created = await resolveCreateOwner({
      principal: c.var.principal,
      authVia: c.var.authVia,
      bodyTeamId: body.teamId,
      userId: owner.userId,
      isTeamMember: (id) => isTeamMember(db, id, owner.userId),
    });
    if (!created.ok) return c.json({ error: created.error }, created.status);
    teamId = created.owner.type === "team" ? created.owner.id : undefined;
  }

  const result = await createWorkflowSchedule(armDeps(c), owner, {
    name: body.name,
    cron: body.cron,
    timezone: body.timezone,
    workflowId: body.target.kind === "workflow" ? body.target.workflowId : undefined,
    prompt: body.target.kind === "orchestrator" ? body.target.prompt : undefined,
    input: body.target.kind === "workflow" ? body.target.input : undefined,
    teamId,
  });
  if (!result.ok) return c.json({ error: withCronHint(result.error) }, 400);
  const resp: WorkflowScheduleResponse = { schedule: result.schedule };
  return c.json(resp, 201);
});

workflowTriggersRouter.patch("/schedules/:id", async (c) => {
  const { db } = c.var.providers;
  let body: UpdateWorkflowScheduleRequest;
  try {
    body = (await c.req.json()) as UpdateWorkflowScheduleRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object." }, 400);
  }
  const owner = ownerFrom(c);
  const result = await updateWorkflowSchedule(db, owner, c.req.param("id"), body);
  if (!result.ok) {
    const msg =
      result.status === 404
        ? `${result.error} Confirm the id and that you have access to it.`
        : withCronHint(result.error);
    return c.json({ error: msg }, result.status);
  }
  const resp: WorkflowScheduleResponse = { schedule: result.schedule };
  return c.json(resp);
});

workflowTriggersRouter.delete("/schedules/:id", async (c) => {
  const { db } = c.var.providers;
  const owner = ownerFrom(c);
  const result = await deleteWorkflowSchedule(db, owner, c.req.param("id"));
  if (result === "not_found") return c.json({ error: "schedule not found. Confirm the id and that you have access to it." }, 404);
  return c.json({ ok: true });
});

workflowTriggersRouter.post("/schedules/:id/run", async (c) => {
  const result = await c.var.providers.workflowScheduler.fireNow(ownerFrom(c), c.req.param("id"));
  if (result === "not_found")
    return c.json({ error: "schedule not found. Confirm the id and that you have access to it." }, 404);
  if (result !== "ok") return c.json({ error: result.error }, 400);
  return c.json({ ok: true });
});

// ── Event triggers ───────────────────────────────────────────────────────

workflowTriggersRouter.post("/event-triggers", async (c) => {
  const { db, plugins } = c.var.providers;
  const owner = ownerFrom(c);
  let body: CreateWorkflowEventTriggerRequest;
  try {
    body = (await c.req.json()) as CreateWorkflowEventTriggerRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object." }, 400);
  }
  const result = await createWorkflowTrigger(armDeps(c), owner, {
    workflowId: body.workflowId,
    name: body.name,
    eventKeys: body.eventKeys,
    filters: body.filters,
    anyChannel: body.anyChannel,
  });
  if (!result.ok) return c.json({ error: result.error }, 400);
  const resp: WorkflowEventTriggerResponse = { trigger: result.trigger };
  return c.json(resp, 201);
});

workflowTriggersRouter.patch("/event-triggers/:id", async (c) => {
  const { db, plugins } = c.var.providers;
  let body: UpdateWorkflowEventTriggerRequest;
  try {
    body = (await c.req.json()) as UpdateWorkflowEventTriggerRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return c.json({ error: "Request body must be a JSON object." }, 400);
  }
  const owner = ownerFrom(c);
  const result = await updateWorkflowTrigger(armDeps(c), owner, c.req.param("id"), body);
  if (!result.ok) {
    const msg =
      result.status === 404
        ? `${result.error} Confirm the id and that you have access to it.`
        : result.error;
    return c.json({ error: msg }, result.status);
  }
  const resp: WorkflowEventTriggerResponse = { trigger: result.trigger };
  return c.json(resp);
});

workflowTriggersRouter.delete("/event-triggers/:id", async (c) => {
  const { db } = c.var.providers;
  const owner = ownerFrom(c);
  const result = await deleteWorkflowTrigger(db, owner, c.req.param("id"));
  if (result === "not_found")
    return c.json({ error: "trigger not found. Confirm the id and that you have access to it." }, 404);
  return c.json({ ok: true });
});

export type WorkflowTriggersRouter = typeof workflowTriggersRouter;
