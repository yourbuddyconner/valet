/**
 * Wires the shared EventStream's producers into the attention router
 * (decision 19's "Wired producers"). Three subscriptions:
 *
 *  - `submission_stuck` → kind 'escalation', routed to the stuck session's
 *    own owner. Title names the session (its app-row title if one exists,
 *    otherwise the session id) and the thread.
 *  - `decision_gate` → kind 'approval', routed to the owner who can answer
 *    it. For a `purpose: 'child'` session that is the PARENT session's owner
 *    audience (decision 19 / orchestrator spec "Approval routing" — a
 *    child's gate surfaces to whoever spawned the work, because a child has
 *    no independent audience). Every other session — standalone, user
 *    orchestrator, team orchestrator — has its own audience, so the gate
 *    routes to that session's own owner.
 *  - `decision_gate_resolved` / `_expired` / `_withdrawn` → mark the gate's
 *    notifications read (`markGateNotificationsRead`). A terminal gate's
 *    call to action is void; leaving the rows unread keeps the web bell,
 *    title count, and rail dot asking for an answer nobody can give.
 *
 * The kind-per-producer mapping here has a client-side mirror: the web's
 * `GATE_BACKED` list (`packages/web/src/lib/use-attention-ping.ts`) names
 * the kinds that announce a decision gate so live sessions can trust the
 * stream store over the notifications poll. A new producer or a new kind
 * must update both, or the rail dot mishandles it.
 *
 * `href` points at the surface where the person can actually answer, which
 * is not the same route for both kinds of session — see `attentionHref`.
 *
 * Subscribe callbacks must never throw back into the EventStream's fan-out
 * — every handler is wrapped in try/catch that logs and swallows.
 */
import type { DeliveredBusEvent, EventStream, Principal, SessionStore } from "@valet/engine";
import { parseAssistantSessionId } from "@valet/engine";
import { eq } from "drizzle-orm";
import { digestGate } from "../channels/gate-digest.js";
import type { AppDb } from "../lib/drizzle.js";
import { agentSessions } from "../schema/index.js";
import {
  markGateNotificationsRead,
  routeAttention,
  type AttentionChannelDeliverer,
  type AttentionDeps,
} from "./attention.js";

export interface AttentionWiringDeps extends AttentionDeps {
  db: AppDb;
  engineStore: SessionStore;
  eventStream: EventStream;
  channels?: AttentionChannelDeliverer[];
}

async function sessionLabel(db: AppDb, sessionId: string): Promise<string> {
  const rows = await db
    .select({ title: agentSessions.title })
    .from(agentSessions)
    .where(eq(agentSessions.id, sessionId))
    .limit(1);
  const row = rows[0];
  return row?.title || sessionId;
}

/** Notifications address the workspace conversation or an execution detail. */
export function attentionHref(sessionId: string, threadId?: string, owner?: Principal): string {
  const isAssistant = parseAssistantSessionId(sessionId) !== null || sessionId.startsWith("orchestrator:");
  const workspace = owner?.type === "team" ? owner.id : "user";
  const href = isAssistant && owner
    ? `/chat?workspace=${encodeURIComponent(workspace)}`
    : `/sessions/${encodeURIComponent(sessionId)}`;
  return threadId ? `${href}${href.includes("?") ? "&" : "?"}thread=${encodeURIComponent(threadId)}` : href;
}

async function handleSubmissionStuck(deps: AttentionWiringDeps, delivered: DeliveredBusEvent): Promise<void> {
  if (delivered.event.type !== "submission_stuck") return;
  const { sessionId, threadId, queueItemId } = delivered.event;

  const sessionData = await deps.engineStore.getSession(sessionId);
  if (!sessionData) return;

  const label = await sessionLabel(deps.db, sessionId);
  await routeAttention(deps, {
    kind: "escalation",
    urgency: "high",
    owner: sessionData.owner,
    sessionId,
    title: `Stuck submission in "${label}" (thread ${threadId})`,
    body: `Queue item ${queueItemId} hasn't settled after ${delivered.event.attemptCount} attempt(s).`,
    href: attentionHref(sessionId, threadId, sessionData.owner),
    dedupeKey: queueItemId,
  });
}

async function handleDecisionGate(deps: AttentionWiringDeps, delivered: DeliveredBusEvent): Promise<void> {
  if (delivered.event.type !== "decision_gate") return;
  const sessionId = delivered.sessionId;
  const { gate } = delivered.event;

  const sessionData = await deps.engineStore.getSession(sessionId);
  if (!sessionData) return;

  // A gate blocks its session until somebody answers it, so every gate must
  // reach an audience. A child session has none of its own — the parent's
  // owner asked for the work, so the parent's owner decides. Every other
  // session is its own audience.
  let owner = sessionData.owner;
  if (sessionData.purpose === "child" && sessionData.parentSessionId) {
    const parentData = await deps.engineStore.getSession(sessionData.parentSessionId);
    // A missing parent row (deleted parent, or a partial spawn) falls back to
    // the child's own owner. That owner is a weaker audience than the parent's,
    // but the alternative is a blocked session that tells nobody.
    if (parentData) owner = parentData.owner;
  }

  // Digest the gate for delivery: a tool-approval gate's raw body is a
  // machine-oriented tool_id/args dump, and neither the notification row nor
  // a channel DM should show that. The digest keeps the one-line summary and
  // hands the key parameters over as labeled fields.
  const digest = digestGate(gate);
  await routeAttention(deps, {
    kind: "approval",
    urgency: "high",
    owner,
    sessionId,
    title: digest.title,
    body: digest.body,
    href: attentionHref(sessionId, gate.threadId, sessionData.owner),
    dedupeKey: gate.id,
    gate: { id: gate.id, actions: gate.actions, fields: digest.fields },
  });
}

/**
 * Subscribes the wired producers above onto `deps.eventStream`. Call once
 * at boot (main.ts). Returns the combined unsubscribe.
 */
export function wireAttentionRouter(deps: AttentionWiringDeps): () => void {
  const unsubStuck = deps.eventStream.subscribe(
    { eventTypes: ["submission_stuck"] },
    (delivered) => {
      handleSubmissionStuck(deps, delivered).catch((err) => {
        console.error("attention router: submission_stuck handler failed:", err);
      });
    },
  );

  const unsubGate = deps.eventStream.subscribe({ eventTypes: ["decision_gate"] }, (delivered) => {
    handleDecisionGate(deps, delivered).catch((err) => {
      console.error("attention router: decision_gate handler failed:", err);
    });
  });

  const unsubSettled = deps.eventStream.subscribe(
    { eventTypes: ["decision_gate_resolved", "decision_gate_expired", "decision_gate_withdrawn"] },
    (delivered) => {
      const e = delivered.event;
      if (
        e.type !== "decision_gate_resolved" &&
        e.type !== "decision_gate_expired" &&
        e.type !== "decision_gate_withdrawn"
      ) {
        return;
      }
      markGateNotificationsRead(deps.db, e.gateId).catch((err) => {
        console.error("attention router: gate-settled handler failed:", err);
      });
    },
  );

  return () => {
    unsubStuck();
    unsubGate();
    unsubSettled();
  };
}
