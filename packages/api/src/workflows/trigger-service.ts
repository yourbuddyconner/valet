/**
 * Workflow trigger management over the event-subscription system. A
 * "trigger" here is an `event_subscriptions` row with a
 * `{ kind: "workflow", workflowId }` target — the event dispatcher starts
 * a run for every matching event, delivering the event as
 * `trigger.data = { key, summary, refs, payload }`.
 *
 * Scoped deliberately to workflow targets: orchestrator/signal
 * subscriptions have their own management surface (`/api/event-subscriptions`).
 */
import { linearEventArmBlock } from "../services/linear-ingress.js";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { ValetPlugin } from "@valet/engine";
import type { WorkflowDefinition } from "@valet/workflow";
import type { AppDb } from "../lib/drizzle.js";
import { eventSubscriptions, workflowDefinitions } from "../schema/index.js";
import { teamArmBlock, type TeamServiceReadinessDeps } from "./team-service-readiness.js";
import { withAuthorizedTeamOwnership } from "../services/teams.js";
import { catalogForService } from "../events/ingest.js";
import { storedAnyChannelState } from "../events/mention-scope.js";
import { validateSubscriptionWrite } from "../events/subscription-write.js";
import type { SubscriptionFilter } from "../events/match.js";
import {
  canAccessTriggerRow,
  canAccessTriggerRowInScope,
  armableDefinitionRow,
  scopedTriggerAccess,
  triggerAccessSets,
  type TriggerAccessSets,
  type WorkflowOwner,
  type WorkflowOwnerRef,
} from "./service.js";

export interface WorkflowTriggerSummary {
  triggerId: string;
  workflowId: string;
  name: string;
  eventKeys: string[];
  filters: unknown[];
  enabled: boolean;
}

export interface EventTypeCatalog {
  service: string;
  entries: { key: string; description: string; filters: { field: string; description: string }[] }[];
}

export function listEventTypes(plugins: ValetPlugin[]): EventTypeCatalog[] {
  const services = [...new Set(plugins.flatMap((p) => p.triggers ?? []).map((t) => t.service))];
  return services.map((service) => ({
    service,
    entries: catalogForService(plugins, service).map((e) => ({
      key: e.key,
      description: e.description,
      filters: e.filters.map((f) => ({ field: f.field, description: f.description })),
    })),
  }));
}

function rowToTrigger(row: typeof eventSubscriptions.$inferSelect): WorkflowTriggerSummary | null {
  const target = row.target as { kind?: string; workflowId?: string };
  if (target?.kind !== "workflow" || typeof target.workflowId !== "string") return null;
  return {
    triggerId: row.id,
    workflowId: target.workflowId,
    name: row.name,
    eventKeys: row.eventKeys as string[],
    filters: (row.filters as unknown[]) ?? [],
    enabled: row.enabled,
  };
}

/**
 * A trigger arms unattended work, so creating one needs the credential
 * reads `teamArmBlock` makes, not the database and the registry alone. The
 * deps are required rather than optional: an optional bag is a gate every
 * new caller can forget, which is how the install gate and this path came
 * to disagree (TKAI-444).
 */
export async function createWorkflowTrigger(
  deps: TeamServiceReadinessDeps,
  owner: WorkflowOwner,
  input: { workflowId: string; name: string; eventKeys: string[]; filters?: unknown[]; anyChannel?: boolean },
): Promise<{ ok: true; trigger: WorkflowTriggerSummary } | { ok: false; error: string }> {
  const db = deps.db;
  const target = { kind: "workflow" as const, workflowId: input.workflowId };
  const write = await validateSubscriptionWrite(
    db,
    deps.plugins,
    { name: input.name, eventKeys: input.eventKeys, filters: input.filters ?? [], target },
    { creatorUserId: owner.userId, anyChannel: input.anyChannel === true, matchChanged: true },
  );
  if (!write.ok) return { ok: false, error: write.error };
  const filters = write.filters;

  // Owner-scoped, not just org-scoped: checking only `orgId` let any org
  // member wire event-driven automation onto a workflow they don't own.
  // Unlike the schedule path, run ownership at fire time was already
  // correct here (`events/dispatcher.ts` bills the workflow definition's
  // own owner) — only this creation-time check needed the fix. The owner
  // carries the request principal, so a team key reaches its team's
  // workflows only.
  const owned = await armableDefinitionRow(db, owner, input.workflowId);
  if (!owned) return { ok: false, error: `workflow not found: ${input.workflowId}` };

  const ingressBlocked = await linearEventArmBlock(db,deps.credentials,owner.orgId,input.eventKeys);
  if (ingressBlocked) return { ok: false, error: ingressBlocked };

  // An event-fired team run bills the team, so it resolves the TEAM's
  // credentials. Refuse here rather than arm a trigger that fails on every
  // event; the person is present and can act on the reason now.
  if (owned.ownerType === "team") {
    const blocked = await teamArmBlock(deps, {
      orgId: owner.orgId,
      teamId: owned.ownerId,
      // jsonb, so drizzle types the column `unknown`; the dag validator ran
      // before any definition reached the row.
      definition: owned.definition as WorkflowDefinition,
      step: "create the trigger",
    });
    if (blocked) return { ok: false, error: blocked };
  }

  const now = Date.now();
  const values = {
    id: randomUUID(),
    orgId: owner.orgId,
    // Owner follows the workflow, team only — see the insert in `routes/events.ts`.
    ownerType: owned.ownerType === "team" ? ("team" as const) : ("user" as const),
    ownerId: owned.ownerType === "team" ? owned.ownerId : owner.userId,
    name: input.name,
    eventKeys: input.eventKeys,
    filters,
    target,
    enabled: true,
    createdBy: owner.userId,
    createdAt: now,
    updatedAt: now,
  };

  let insertedRow: typeof eventSubscriptions.$inferSelect | undefined;
  if (owned.ownerType === "team") {
    // `deleteTeam` reaps a team's own workflows and event_subscriptions
    // under this same lock (services/teams.ts). Without it, a trigger that
    // already passed `teamArmBlock` above can still insert after the team
    // (or its target workflow) is gone, landing as a permanent orphan — the
    // race #709 closed for schedules. Rechecking the workflow row inside
    // the lock mirrors `schedule-service.ts`'s create path.
    const rows = await withAuthorizedTeamOwnership(
      db,
      {
        teamId: owned.ownerId,
        orgId: owner.orgId,
        userId: owner.userId,
        principalTeamId: owner.principal?.type === "team" ? owner.principal.id : null,
        requireMembership: owner.requireTeamMembership === true,
      },
      async (tx) => {
        const [targetWorkflow] = await tx
          .select({ id: workflowDefinitions.id })
          .from(workflowDefinitions)
          .where(
            and(
              eq(workflowDefinitions.id, input.workflowId),
              eq(workflowDefinitions.orgId, owner.orgId),
              eq(workflowDefinitions.ownerType, "team"),
              eq(workflowDefinitions.ownerId, owned.ownerId),
            ),
          );
        if (!targetWorkflow) return [];
        return tx.insert(eventSubscriptions).values(values).returning();
      },
    );
    if (!rows?.[0]) {
      return { ok: false, error: "Team or trigger target is no longer available. Refresh and select an active target." };
    }
    insertedRow = rows[0];
  } else {
    const inserted = await db.insert(eventSubscriptions).values(values).returning();
    insertedRow = inserted[0];
  }

  const trigger = rowToTrigger(insertedRow!);
  if (!trigger) return { ok: false, error: "trigger insert produced an unexpected row shape" };
  return { ok: true, trigger };
}

/** Row shape for `canAccessTriggerRow`. The workflow-reach arm stays for
 * older rows that still carry their creator as owner. One builder, so the
 * list filter and the single-row loader judge the same shape. */
function triggerAccessRow(
  row: typeof eventSubscriptions.$inferSelect,
  trigger: WorkflowTriggerSummary,
): { ownerType: string; ownerId: string; workflowId: string } {
  return { ownerType: row.ownerType, ownerId: row.ownerId, workflowId: trigger.workflowId };
}

/** Pass `sets` when the caller already holds this request's
 * `triggerAccessSets` (the aggregated triggers read builds them once for
 * both lists); omitted, the sets are fetched here. */
export async function listWorkflowTriggers(
  db: AppDb,
  owner: WorkflowOwner,
  workflowId?: string,
  sets?: TriggerAccessSets,
  scope?: WorkflowOwnerRef,
): Promise<WorkflowTriggerSummary[]> {
  const conditions = [eq(eventSubscriptions.orgId, owner.orgId)];
  // `target` is JSONB; the workflow id lives at target->>'workflowId'.
  if (workflowId !== undefined) conditions.push(sql`${eventSubscriptions.target}->>'workflowId' = ${workflowId}`);
  const rows = await db.select().from(eventSubscriptions).where(and(...conditions));
  // Scoped list: one workspace's rows only (owned by the scope, or targeting a
  // workflow it owns) — a personal row does not ride along into a team scope.
  const scopedAccess = scope ? await scopedTriggerAccess(db, scope) : undefined;
  const resolvedSets = scopedAccess ? undefined : sets ?? (await triggerAccessSets(db, owner));
  return rows
    .map((row) => {
      const trigger = rowToTrigger(row);
      if (!trigger) return null;
      const accessRow = triggerAccessRow(row, trigger);
      const allowed = scopedAccess
        ? canAccessTriggerRowInScope(scopedAccess, accessRow)
        : canAccessTriggerRow(owner, resolvedSets!, accessRow);
      return allowed ? trigger : null;
    })
    .filter((t): t is WorkflowTriggerSummary => t !== null);
}

/**
 * Loads one workflow-target trigger the caller may act on. Missing rows,
 * non-workflow subscriptions, and rows the caller cannot access all return
 * null — the route answers the same 404 for each, so a trigger id never
 * confirms another member's automation exists.
 */
async function accessibleTriggerRow(
  db: AppDb,
  owner: WorkflowOwner,
  triggerId: string,
): Promise<{ row: typeof eventSubscriptions.$inferSelect; trigger: WorkflowTriggerSummary } | null> {
  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.id, triggerId), eq(eventSubscriptions.orgId, owner.orgId)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  const trigger = rowToTrigger(row);
  if (!trigger) return null;
  if (!canAccessTriggerRow(owner, await triggerAccessSets(db, owner), triggerAccessRow(row, trigger))) return null;
  return { row, trigger };
}

export interface WorkflowTriggerPatch {
  name?: string;
  eventKeys?: string[];
  filters?: unknown[];
  enabled?: boolean;
  anyChannel?: boolean;
}

export async function updateWorkflowTrigger(
  deps: TeamServiceReadinessDeps,
  owner: WorkflowOwner,
  triggerId: string,
  patch: WorkflowTriggerPatch,
): Promise<
  | { ok: true; trigger: WorkflowTriggerSummary }
  | { ok: false; status: 400 | 404; error: string }
> {
  const { db, plugins } = deps;
  const accessible = await accessibleTriggerRow(db, owner, triggerId);
  if (!accessible) return { ok: false, status: 404, error: "trigger not found" };
  const current = accessible.trigger;

  const name = patch.name ?? current.name;
  const eventKeys = patch.eventKeys ?? current.eventKeys;
  // Mention scoping is keyed to the row's creator and skipped for a patch
  // that does not change the match — same rule as the subscriptions PATCH
  // route. The cast narrows filters a prior gated write stored.
  const write = await validateSubscriptionWrite(
    db,
    plugins,
    {
      name,
      eventKeys,
      filters: patch.filters ?? current.filters,
      target: { kind: "workflow", workflowId: current.workflowId },
    },
    {
      creatorUserId: accessible.row.createdBy,
      anyChannel: patch.anyChannel === true,
      matchChanged: patch.filters !== undefined || patch.eventKeys !== undefined,
      storedAnyChannel: storedAnyChannelState(
        current.eventKeys,
        current.filters as SubscriptionFilter[],
      ),
    },
  );
  if (!write.ok) return { ok: false, status: 400, error: write.error };
  const filters = write.filters;

  if ((patch.enabled ?? current.enabled) && (patch.enabled === true || patch.eventKeys !== undefined || patch.filters !== undefined)) {
    const ingressBlocked = await linearEventArmBlock(db,deps.credentials,owner.orgId,eventKeys);
    if (ingressBlocked) return { ok: false, status: 400, error: ingressBlocked };
  }

  const updated = await db
    .update(eventSubscriptions)
    .set({ name, eventKeys, filters, enabled: patch.enabled ?? current.enabled, updatedAt: Date.now() })
    .where(and(eq(eventSubscriptions.id, triggerId), eq(eventSubscriptions.orgId, owner.orgId)))
    .returning();
  const trigger = rowToTrigger(updated[0]!);
  if (!trigger) return { ok: false, status: 400, error: "trigger update produced an unexpected row shape" };
  return { ok: true, trigger };
}

export async function deleteWorkflowTrigger(
  db: AppDb,
  owner: WorkflowOwner,
  triggerId: string,
): Promise<"ok" | "not_found"> {
  // `accessibleTriggerRow` also refuses non-workflow subscriptions through
  // this seam — those belong to the orchestrator subscription surface.
  const accessible = await accessibleTriggerRow(db, owner, triggerId);
  if (!accessible) return "not_found";
  await db.delete(eventSubscriptions).where(and(eq(eventSubscriptions.id, triggerId), eq(eventSubscriptions.orgId, owner.orgId)));
  return "ok";
}
