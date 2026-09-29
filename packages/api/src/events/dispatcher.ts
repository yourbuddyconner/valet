/**
 * Event-delivery dispatcher: drains `event_deliveries` rows into their
 * subscription targets (workflow run start / orchestrator signal prompt /
 * parked-run workflow signals).
 *
 * Same lifecycle pattern as `LocalRunHost`: a poll loop (1s) that the
 * ingest path nudges in-process via `nudge()`, so the interval is a
 * staleness floor, not the delivery path.
 *
 * Claiming deviates from the design sketch's `SELECT ... FOR UPDATE SKIP
 * LOCKED`: a bare `FOR UPDATE` outside an enclosing transaction releases
 * its locks at statement end (autocommit), so it wouldn't fence anything
 * here — and this codebase's established row-claim pattern is a
 * single-statement CAS (`pg-store.ts` `claimRun`). The claim below is one
 * atomic `UPDATE ... RETURNING id` whose OUTER `WHERE` repeats the due
 * conditions (status + `next_attempt_at <= now`); the `id IN (<subquery>)`
 * part only provides ordering/LIMIT. That outer qual is the cross-process
 * fence: under READ COMMITTED, when two connections race, the loser's
 * EvalPlanQual recheck re-evaluates the outer predicate against the
 * winner's committed row — where `next_attempt_at` has already been
 * pushed forward by the lease — so the recheck fails and the loser skips
 * the row. (Fencing only via the `IN (subquery)` would NOT work: EPQ
 * rechecks the subquery against its original snapshot, so both sides
 * would claim the row.) A crash mid-delivery leaves the row pending; it
 * becomes due again when the lease lapses.
 */
import type { ChannelOrigin, SignalContent, ValetPlugin } from "@valet/engine";
import type { RunHost, RunParams, WorkflowStore, WorkflowTriggerPayload } from "@valet/workflow";
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { AppDb } from "../lib/drizzle.js";
import { eventDeliveries, events, eventSubscriptions, workflowDefinitions, workflowRuns } from "../schema/index.js";
import { definitionVersionId } from "../workflows/definition-version.js";
import { findFollowedThread, upsertFollowedThread } from "./followed-threads.js";
import { hasTeamCoverage } from "./delivery-policy.js";
import { allCatalogEntries } from "./ingest.js";
import { buildPromptValues, hasPromptConfig, renderEventPrompt } from "./prompt-template.js";
import {
  followBindingAuthorized,
  isTeamAssistantMention,
  mentionAudience,
  teamMentionActor,
} from "./team-slack-gate.js";

/** Retry backoff per failed attempt; a failure past the last entry is dead. */
const BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000];
const POLL_MS = 1_000;
const BATCH = 20;
/** How long a claimed-but-unresolved row stays invisible to other polls. */
const CLAIM_LEASE_MS = 60_000;
const MAX_ERROR_CHARS = 2_000;
const MAX_BODY_EXCERPT_CHARS = 4_000;

export interface OrchestratorDeliverFn {
  (args: {
    orgId: string;
    ownerType: "user" | "team" | "org";
    ownerId: string;
    /**
     * The human the delivery acts for. NOT `ownerId`: on a team or org
     * subscription the owner is a team/org id, and this value is written to
     * `agent_sessions.user_id`, which holds a user. The subscription's
     * author is the actor for ordinary events. Team mentions use the linked
     * sender, after the live membership check.
     */
    actorUserId: string;
    signal: SignalContent;
    dispatchId: string;
  }): Promise<void>;
}

export interface EventDispatcherDeps {
  db: AppDb;
  workflowRunHost: RunHost;
  workflowStore: WorkflowStore;
  /** Seam over `ensureDefaultAssistantSession` + `thread("events").submitPrompt` — see `orchestrator-target.ts`. */
  deliverToOrchestrator: OrchestratorDeliverFn;
  /**
   * Where a channel-originated event should route a reply. Returns the origin
   * for a channel event that names a conversation (a Slack message or mention),
   * or `null` for a non-channel event (GitHub, Linear) or one with no
   * conversation. Wired from `channelHost.transportFor(...).threadKeyFromEvent`.
   */
  resolveChannelOrigin?: (service: string, eventKey: string, payload: unknown) => ChannelOrigin | null;
  /**
   * Resolve a channel message's sender display name and clean its text, so the
   * delivered signal names the person and drops raw ids / Slack markup. Wired
   * from `channelHost` (`channelMessageNormalizer`). Absent → the raw text and
   * id are used unchanged.
   */
  normalizeChannelMessage?: (
    service: string,
    msg: { userId?: string; text: string },
  ) => Promise<{ senderName?: string; text: string }>;
  /**
   * The loaded plugins, for the trigger catalog a `{{payload.<field>}}`
   * variable resolves through (`events/prompt-template.ts`). Only a rule
   * that configures a prompt template reads it; a dispatcher built without
   * plugins delivers every default body unchanged.
   */
  plugins?: ValetPlugin[];
}

/** The message text on a channel event payload (`text`), when present. */
function channelText(payload: unknown): string | undefined {
  if (typeof payload === "object" && payload !== null) {
    const t = (payload as Record<string, unknown>).text;
    if (typeof t === "string" && t.length > 0) return t;
  }
  return undefined;
}

/** The `target` jsonb column's shape — written only by the subscriptions CRUD validator. */
interface SubscriptionTarget {
  kind: "workflow" | "orchestrator" | "signal";
  workflowId?: string;
  /** When true, an orchestrator channel delivery follows the thread: later
   * messages route to the assistant without a re-mention. */
  follow?: boolean;
  pauseOnOverlap?: boolean;
  overlapPausedAt?: number;
  /** Standing instruction rendered above the event. Absent → no instruction. */
  systemPrompt?: string;
  /** The event message, in place of the default body. Absent → the default. */
  userPromptTemplate?: string;
}

export class EventDispatcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private draining = false;
  private stopped = false;

  constructor(private readonly deps: EventDispatcherDeps) {}

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => void this.pollOnce(), POLL_MS);
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    while (this.draining) await new Promise((r) => setTimeout(r, 25));
  }

  /** In-process nudge from the ingest path. Arrow property so callers can pass it unbound. */
  nudge = (): void => {
    if (this.stopped) return;
    void this.pollOnce().catch((err) => console.error("event dispatcher poll failed:", err));
  };

  async pollOnce(): Promise<void> {
    if (this.stopped || this.draining) return;
    this.draining = true;
    try {
      const now = Date.now();
      // Atomic claim (see file doc comment): lease the due rows by moving
      // next_attempt_at forward in the same statement that selects them.
      // The due conditions are repeated on the OUTER update — that's the
      // cross-process fence (a raced loser's EPQ recheck fails once the
      // winner bumps next_attempt_at); the subquery only orders and limits.
      const due = this.deps.db
        .select({ id: eventDeliveries.id })
        .from(eventDeliveries)
        .where(and(inArray(eventDeliveries.status, ["pending", "failed"]), lte(eventDeliveries.nextAttemptAt, now)))
        .orderBy(asc(eventDeliveries.nextAttemptAt))
        .limit(BATCH);
      const claimed = await this.deps.db
        .update(eventDeliveries)
        .set({ nextAttemptAt: now + CLAIM_LEASE_MS })
        .where(
          and(
            inArray(eventDeliveries.id, due),
            inArray(eventDeliveries.status, ["pending", "failed"]),
            lte(eventDeliveries.nextAttemptAt, now),
          ),
        )
        .returning({ id: eventDeliveries.id });

      for (const row of claimed) {
        await this.deliverOne(row.id).catch((err) => console.error(`event dispatch ${row.id}:`, err));
      }
    } finally {
      this.draining = false;
    }
  }

  private async deliverOne(deliveryId: string): Promise<void> {
    const { db } = this.deps;
    const [delivery] = await db.select().from(eventDeliveries).where(eq(eventDeliveries.id, deliveryId)).limit(1);
    if (!delivery || delivery.status === "delivered" || delivery.status === "dead" || delivery.status === "skipped") return;
    const [event] = await db.select().from(events).where(eq(events.id, delivery.eventId)).limit(1);
    const [sub] = await db
      .select()
      .from(eventSubscriptions)
      .where(eq(eventSubscriptions.id, delivery.subscriptionId))
      .limit(1);
    if (!event || !sub) {
      await db
        .update(eventDeliveries)
        .set({ status: "dead", lastError: "event or subscription vanished" })
        .where(eq(eventDeliveries.id, deliveryId));
      return;
    }

    try {
      // Both jsonb shapes are owned by their writers: `target` by the
      // subscriptions CRUD validator, `refs` by ingest (NormalizedEvent.refs
      // is Record<string, string>). Same narrowing convention as ingest.ts.
      const target = sub.target as SubscriptionTarget;
      const refs = event.refs as Record<string, string>;
      if (event.orgId !== sub.orgId) throw new Error("Event and subscription organizations differ.");
      const covered = sub.enabled && await hasTeamCoverage(db, sub, event, allCatalogEntries(this.deps.plugins ?? []));
      if (!sub.enabled || covered) {
        let paused = false;
        if (covered && target.pauseOnOverlap) {
          const changed = await db.update(eventSubscriptions)
            .set({ enabled: false, target: { ...target, overlapPausedAt: Date.now() }, updatedAt: Math.max(Date.now(), sub.updatedAt + 1) })
            .where(and(eq(eventSubscriptions.id, sub.id), eq(eventSubscriptions.orgId, event.orgId),
              eq(eventSubscriptions.updatedAt, sub.updatedAt), eq(eventSubscriptions.enabled, true)))
            .returning({ id: eventSubscriptions.id });
          paused = changed.length > 0;
        }
        await db.update(eventDeliveries).set({ status: "skipped", lastError: covered
          ? `Skipped — matching team subscription.${paused ? " Personal subscription paused until you re-enable it." : ""}`
          : "Skipped — subscription is disabled." }).where(and(eq(eventDeliveries.id, delivery.id), eq(eventDeliveries.eventId, event.id)));
        return;
      }

      if (target.kind === "workflow" && target.workflowId) {
        await this.startWorkflow(target.workflowId, sub.id, delivery.id, event, refs);
      } else if (target.kind === "orchestrator") {
        const teamMention = isTeamAssistantMention(sub, event.eventKey);
        const audience = mentionAudience(sub);
        const actorUserId = teamMention ? await teamMentionActor(db, sub, event.payload) : sub.createdBy;
        if (event.orgId !== sub.orgId || actorUserId === null) {
          // Name the membership this rule's audience actually requires, the
          // same split the drop log makes in `team-slack-gate.ts`.
          const lastError = teamMention && audience === "organization"
            ? "Team mention denied. Check the sender's Slack identity link and organization membership."
            : "Team mention denied. Check the sender's Slack identity link and team membership.";
          await db.update(eventDeliveries).set({ status: "dead", lastError })
            .where(eq(eventDeliveries.id, deliveryId));
          return;
        }
        // A channel event routes a reply back: stamp the origin, and render the
        // message as the agent should read it — the sender's name and the clean
        // text, not the machine summary or raw `<@U…>` markup and ids.
        // A non-channel event keeps the compact JSON excerpt it always had.
        const origin = this.deps.resolveChannelOrigin?.(event.service, event.eventKey, event.payload) ?? null;
        const attributes: Record<string, string> = { ...refs, eventId: event.id, service: event.service };
        let body: string;
        if (origin) {
          // `actor` is untyped jsonb, owned by ingest (NormalizedEvent.actor is
          // `{ externalId, login? }`) — same narrowing convention as `refs`.
          const actor = event.actor as { externalId?: string; login?: string } | null;
          const rawText = channelText(event.payload) ?? "";
          const normalized = (await this.deps.normalizeChannelMessage?.(event.service, {
            userId: actor?.externalId,
            text: rawText,
          })) ?? { text: rawText };
          // The clean text is the body; fall back to the summary only when the
          // message carries no text of its own (e.g. a file-only post).
          body = (normalized.text || event.summary).slice(0, MAX_BODY_EXCERPT_CHARS);
          const sender = normalized.senderName ?? actor?.login ?? actor?.externalId;
          if (sender) attributes.sender = sender;
        } else {
          body = `${event.summary}\n\n${JSON.stringify(event.payload).slice(0, MAX_BODY_EXCERPT_CHARS)}`;
        }
        // A rule that configures no template never reaches the renderer, so
        // the body above is the one every rule written before this feature
        // delivers. A configured rule renders deterministically over the
        // event's own fields (`events/prompt-template.ts`).
        if (hasPromptConfig(target)) {
          body = renderEventPrompt(
            target,
            buildPromptValues({
              eventKey: event.eventKey,
              summary: event.summary,
              body,
              refs,
              payload: event.payload,
              catalog: allCatalogEntries(this.deps.plugins ?? []),
            }),
            // The rule names a field this event does not carry, so the
            // template rendered to nothing. The default body goes out in its
            // place. Report it: a rule that selects several events, and a
            // field only some of them declare, is silent otherwise.
            () =>
              console.warn(
                `[events] subscription ${sub.id}: userPromptTemplate rendered empty for ${event.eventKey}. Delivered the default body.`,
              ),
          );
        }
        await this.deps.deliverToOrchestrator({
          orgId: event.orgId,
          ownerType: sub.ownerType,
          ownerId: sub.ownerId,
          actorUserId,
          signal: {
            kind: "signal",
            signalType: event.eventKey,
            body,
            attributes,
            origin: origin ?? undefined,
          },
          dispatchId: `event:${delivery.id}`,
        });
        // Bind the thread only AFTER the delivery lands, so a mention whose
        // delivery fails does not leave a followed thread with no listener. The
        // threadKey is `{channelType}:{channelId}:{threadTs}`.
        if (target.follow && origin) {
          const parts = origin.threadKey.split(":");
          if (parts.length === 3 && parts[1] !== "" && parts[2] !== "") {
            const key = {
              orgId: event.orgId,
              channelType: origin.channelType,
              channelId: parts[1],
              threadTs: parts[2],
            };
            // A team re-mention keeps the conversation's first binding, so a
            // second member's mention does not take the thread over. One
            // exception: a binding that authorizes NOBODY any more. Its rule
            // was disabled or deleted, or its actor lost the membership that
            // rule admitted them under, and the router drops every message in
            // the thread. This mention passed the gate, so it re-binds the
            // thread to its own actor and rule and the conversation resumes.
            let preserveBinding = teamMention;
            if (preserveBinding) {
              const bound = await findFollowedThread(db, key);
              if (bound && !(await followBindingAuthorized(db, bound))) preserveBinding = false;
            }
            await upsertFollowedThread(this.deps.db, {
              ...key,
              ownerType: sub.ownerType,
              ownerId: sub.ownerId,
              createdBy: actorUserId,
              // The follow router re-checks the actor's membership on every
              // later message, against this rule's CURRENT audience. So the
              // rule id is what it needs.
              ...(teamMention ? { subscriptionId: sub.id } : {}),
              preserveBinding,
              // The mention itself is the last message the assistant has seen,
              // so the follow-router's gap re-hydration starts right after it.
              lastSeenTs: origin.messageTs,
            });
          }
        }
      } else if (target.kind === "signal") {
        await this.signalParkedRuns(event, refs);
      } else {
        throw new Error(`unknown target kind: ${target.kind}`);
      }
      await db
        .update(eventDeliveries)
        .set({ status: "delivered", deliveredAt: Date.now(), attempts: delivery.attempts + 1 })
        .where(eq(eventDeliveries.id, deliveryId));
    } catch (err) {
      const attempts = delivery.attempts + 1;
      const backoff = BACKOFF_MS[attempts - 1];
      await db
        .update(eventDeliveries)
        .set({
          status: backoff === undefined ? "dead" : "failed",
          attempts,
          nextAttemptAt: backoff === undefined ? delivery.nextAttemptAt : Date.now() + backoff,
          lastError: String(err).slice(0, MAX_ERROR_CHARS),
        })
        .where(eq(eventDeliveries.id, deliveryId));
    }
  }

  private async startWorkflow(
    workflowId: string,
    subscriptionId: string,
    deliveryId: string,
    event: typeof events.$inferSelect,
    refs: Record<string, string>,
  ): Promise<void> {
    // Mirrors routes/workflows.ts POST /:id/runs: same run-id scheme, same
    // definitionVersionId, owner resolved from the definition row. The org
    // check is defensive — subscription validation (Task 7) enforces
    // ownership at write time; a cross-org drift dead-letters here.
    const rows = await this.deps.db
      .select()
      .from(workflowDefinitions)
      .where(and(eq(workflowDefinitions.id, workflowId), eq(workflowDefinitions.orgId, event.orgId)))
      .limit(1);
    const def = rows[0];
    if (!def) throw new Error(`workflow ${workflowId} not found in org ${event.orgId}`);

    const trigger: WorkflowTriggerPayload = {
      type: "event",
      triggerId: subscriptionId,
      timestamp: new Date(event.occurredAt).toISOString(),
      data: { key: event.eventKey, summary: event.summary, refs, payload: event.payload },
      metadata: { eventId: event.id, service: event.service },
    };
    const params: RunParams = {
      workflowId,
      definitionVersionId: definitionVersionId(def.definition),
      triggerId: subscriptionId,
      input: trigger,
    };
    // Idempotency across delivery retries: the runId is DERIVED from the
    // delivery row (not freshly minted), so a re-claim after a partially
    // failed attempt (run started, but the delivered-status UPDATE lost a
    // race with a DB blip and the claim lease lapsed) resolves to the same
    // run instead of starting a duplicate. If that run already exists, the
    // prior attempt got as far as starting it — nothing left to do.
    const runId = `wfrun_evt_${deliveryId}`;
    const existing = await this.deps.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, runId))
      .limit(1);
    if (existing.length > 0) return;
    await this.deps.workflowRunHost.start(runId, params, def.definition, {
      ownerType: def.ownerType,
      ownerId: def.ownerId,
    });
  }

  private async signalParkedRuns(event: typeof events.$inferSelect, refs: Record<string, string>): Promise<void> {
    const signalType = `event:${event.eventKey}`;
    // Parked runs in the event's org waiting on this signal type. Org
    // scoping goes through the run's parent definition; the jsonb
    // containment matches partial objects, so the stored condition's extra
    // fields (nodeId, timeoutAt) don't matter.
    const rows = await this.deps.db
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .innerJoin(workflowDefinitions, eq(workflowDefinitions.id, workflowRuns.workflowId))
      .where(
        and(
          eq(workflowDefinitions.orgId, event.orgId),
          eq(workflowRuns.status, "parked"),
          sql`${workflowRuns.waitingOn} @> ${JSON.stringify([{ kind: "signal", signalType }])}::jsonb`,
        ),
      );
    for (const row of rows) {
      await this.deps.workflowStore.insertSignal({
        runId: row.id,
        signalId: `event:${event.id}:${row.id}`,
        signalType,
        payload: { key: event.eventKey, summary: event.summary, refs, payload: event.payload },
        createdAt: Date.now(),
      });
      await this.deps.workflowRunHost.wake(row.id);
    }
  }
}
