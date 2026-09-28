/**
 * Workflow schedule loop — the time-based counterpart of the event
 * dispatcher. Polls `workflow_schedules` for due rows (enabled AND
 * next_fire_at <= now) and starts a run per fire.
 *
 * Semantics:
 *   - Idempotent fires: the runId is DERIVED from (scheduleId, slot) —
 *     `wfrun_sch_{id8}_{nextFireAt}` — so a crash between run-start and the
 *     next_fire_at advance can't double-start on the next tick.
 *   - Catch-up collapses: next_fire_at advances from `now`, not from the
 *     missed slot, so downtime produces at most ONE catch-up run rather
 *     than replaying every missed occurrence.
 *   - A schedule whose cron/timezone stops parsing (edited badly, tz db
 *     drift) is DISABLED with the error logged, not retried forever.
 *
 * Same lifecycle shape as `EventDispatcher`: constructed in providers,
 * `start()`/`stop()` from main.ts.
 */
import type { RunHost, RunParams, WorkflowStore, WorkflowTriggerPayload } from "@valet/workflow";
import { and, eq, lte } from "drizzle-orm";
import type { OrchestratorDeliverFn } from "../events/dispatcher.js";
import type { AppDb } from "../lib/drizzle.js";
import { workflowDefinitions, workflowRuns, workflowSchedules } from "../schema/index.js";
import { definitionVersionId } from "./definition-version.js";
import { accessibleScheduleRow, nextFireAt } from "./schedule-service.js";
import type { WorkflowOwner } from "./service.js";

const POLL_MS = 30_000;

export interface WorkflowSchedulerDeps {
  db: AppDb;
  workflowStore: WorkflowStore;
  workflowRunHost: RunHost;
  /** Orchestrator-target fires submit the schedule's prompt through the
   * same delivery seam event subscriptions use (idempotent by dispatchId,
   * org-asserted, lands on a dedicated orchestrator thread). */
  deliverToOrchestrator: OrchestratorDeliverFn;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Pure: the derived, idempotent run id for one (schedule, slot) fire. */
export function scheduledRunId(scheduleId: string, slotMs: number): string {
  return `wfrun_sch_${scheduleId.replace(/-/g, "").slice(0, 8)}_${slotMs}`;
}

export class WorkflowScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private readonly deps: WorkflowSchedulerDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), POLL_MS);
    // Immediate pass so due schedules don't wait a full poll after boot.
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One poll pass. Public for tests + boot. Never throws. */
  async tick(): Promise<void> {
    if (this.ticking) return; // a slow pass must not stack
    this.ticking = true;
    try {
      const now = (this.deps.now ?? Date.now)();
      const due = await this.deps.db
        .select()
        .from(workflowSchedules)
        .where(and(eq(workflowSchedules.enabled, true), lte(workflowSchedules.nextFireAt, now)));
      for (const schedule of due) {
        try {
          await this.fire(schedule, now);
        } catch (err) {
          console.error(`workflow scheduler: fire failed for ${schedule.id} (will retry next tick):`, err);
        }
      }
    } catch (err) {
      console.error("workflow scheduler: tick failed:", err);
    } finally {
      this.ticking = false;
    }
  }

  /** Dispatch one fire for `slotMs`. Shared by the poll loop (slot =
   * next_fire_at) and fireNow (slot = now → a distinct, still-idempotent
   * runId per manual fire). Returns an error string for states the poll
   * loop responds to by disabling. Does NOT touch next_fire_at. */
  private async dispatch(
    schedule: typeof workflowSchedules.$inferSelect,
    slotMs: number,
  ): Promise<"ok" | { error: string }> {
    const { db, workflowRunHost } = this.deps;

    if (schedule.targetKind === "orchestrator") {
      if (!schedule.prompt || schedule.prompt.trim() === "") {
        return { error: "orchestrator target without a prompt. Edit the schedule and set a prompt." };
      }
      await this.deps.deliverToOrchestrator({
        orgId: schedule.orgId,
        ownerType: schedule.ownerType,
        ownerId: schedule.ownerId,
        // The schedule's author, not its owner: on a team or org schedule
        // the owner is not a user, and nobody is present when cron fires.
        actorUserId: schedule.createdBy,
        signal: {
          kind: "signal",
          signalType: "schedule",
          body: schedule.prompt,
          attributes: {
            scheduleId: schedule.id,
            scheduleName: schedule.name,
            cron: schedule.cron,
            firedAt: new Date(slotMs).toISOString(),
          },
        },
        dispatchId: `schedule:${schedule.id}:${slotMs}`,
        // Null on a schedule from before the column and on one that named no
        // assistant; both fall back to the owner's default at delivery.
      });
      return "ok";
    }

    if (!schedule.workflowId) {
      return { error: "workflow target without a workflow_id. Delete this schedule and recreate it against a workflow." };
    }
    const defRows = await db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.id, schedule.workflowId), eq(workflowDefinitions.orgId, schedule.orgId)))
      .limit(1);
    const def = defRows[0];
    if (!def) {
      return { error: `workflow ${schedule.workflowId} is gone. Delete this schedule or recreate the workflow.` };
    }

    const runId = scheduledRunId(schedule.id, slotMs);
    const existing = await db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    if (existing.length === 0) {
      const trigger: WorkflowTriggerPayload = {
        type: "schedule",
        triggerId: schedule.id,
        timestamp: new Date(slotMs).toISOString(),
        data: { scheduleName: schedule.name, cron: schedule.cron, input: schedule.input ?? {} },
        metadata: { scheduleId: schedule.id, timezone: schedule.timezone },
      };
      const params: RunParams = {
        workflowId: schedule.workflowId,
        definitionVersionId: definitionVersionId(def.definition),
        triggerId: schedule.id,
        input: trigger,
      };
      // Bill the WORKFLOW's own owner, not `schedule.ownerType`/`ownerId`
      // (whoever created the schedule) — those can differ, since schedule
      // creation only checks org membership (`schedule-service.ts`), and
      // `def` (the workflow definition row) is already fetched above.
      // Matches `events/dispatcher.ts`'s workflow-target fire, which
      // never had this bug.
      await workflowRunHost.start(runId, params, def.definition, {
        ownerType: def.ownerType,
        ownerId: def.ownerId,
      });
    }
    return "ok";
  }

  private async fire(schedule: typeof workflowSchedules.$inferSelect, now: number): Promise<void> {
    const { db } = this.deps;
    const next = nextFireAt(schedule.cron, schedule.timezone, now);
    if (!next.ok) {
      console.error(`workflow scheduler: disabling ${schedule.id} — ${next.error}`);
      await db.update(workflowSchedules).set({ enabled: false, updatedAt: now }).where(eq(workflowSchedules.id, schedule.id));
      return;
    }
    const result = await this.dispatch(schedule, schedule.nextFireAt);
    if (result !== "ok") {
      console.error(`workflow scheduler: disabling ${schedule.id} — ${result.error}`);
      await db.update(workflowSchedules).set({ enabled: false, updatedAt: now }).where(eq(workflowSchedules.id, schedule.id));
      return;
    }
    await db
      .update(workflowSchedules)
      .set({ lastFiredAt: now, nextFireAt: next.at, updatedAt: now })
      .where(eq(workflowSchedules.id, schedule.id));
  }

  /** Manual fire from the API. Uses `now` as the slot (distinct idempotent
   * runId per press), updates lastFiredAt, never moves nextFireAt, and
   * works on disabled schedules (firing by hand is how you test one).
   * Owner-scoped like every schedule read: a schedule the caller cannot
   * access answers `not_found`, so an org member cannot fire a colleague's
   * personal automation. */
  async fireNow(owner: WorkflowOwner, scheduleId: string): Promise<"ok" | "not_found" | { error: string }> {
    const { db } = this.deps;
    const now = (this.deps.now ?? Date.now)();
    const schedule = await accessibleScheduleRow(db, owner, scheduleId);
    if (!schedule) return "not_found";
    const result = await this.dispatch(schedule, now);
    if (result !== "ok") return result;
    await db
      .update(workflowSchedules)
      .set({ lastFiredAt: now, updatedAt: now })
      .where(and(eq(workflowSchedules.id, scheduleId), eq(workflowSchedules.orgId, owner.orgId)));
    return "ok";
  }
}
