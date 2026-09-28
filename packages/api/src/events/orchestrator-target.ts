/**
 * The dispatcher's orchestrator delivery target: get-or-create the
 * subscription owner's DEFAULT assistant session and submit the event as a
 * `SignalContent` prompt on its "events" thread — same delivery path
 * `ChannelHost.handleMessage` uses for inbound channel messages.
 * `dispatchId` (`event:{deliveryId}`) makes the submit idempotent across
 * delivery retries.
 *
 * Why not `admitSignal`: its edge ACL authorizes SESSION -> session edges
 * (parent/child, orchestrator -> orchestrator) and requires a live sender
 * session — an event delivery has no sender session, so there is no edge
 * vocabulary for it (the channel ingress has the same shape and also
 * submits directly). The second-layer defense `admitSignal` would have
 * provided is replicated here: before submitting, the resolved session's
 * durable org is asserted against the event's org, and a mismatch is
 * drop-logged (`event_drop_log`, reason `event_target_mismatch`) and
 * thrown instead of delivered — a subscription-matching bug can't silently
 * deliver an event into another org's assistant.
 */
import type { ChannelOrigin, SignalContent } from "@valet/engine";
import type { EngineHost } from "../engine/host.js";
import type { AppDb } from "../lib/drizzle.js";
import { deliverToAssistantThread } from "./assistant-delivery.js";
import type { OrchestratorDeliverFn } from "./dispatcher.js";

/**
 * The thread a non-channel event delivery lands on — the owner's default
 * assistant "events" firehose. Named so the outbound reply path can recognise
 * it without a magic string (`ChannelHost.deliverAssistantMessage`).
 */
export const EVENTS_THREAD_KEY = "events";

/**
 * Which assistant thread an event signal lands on. A channel-originated signal
 * binds to a thread keyed by its Slack thread (`slack:{channel}:{threadTs}`),
 * so one Slack thread maps to one assistant thread: a top-level mention opens a
 * new thread, and a later message in the same Slack thread routes to the same
 * one. Everything else (GitHub, Linear, a timer) shares the "events" firehose.
 */
export function threadKeyForSignal(signal: SignalContent): string {
  return signal.origin?.threadKey ?? EVENTS_THREAD_KEY;
}

export function buildOrchestratorTarget(deps: {
  db: AppDb;
  engineHost: EngineHost;
  /** Seed a channel thread's earlier messages on the assistant's first turn. */
  fetchThreadContext?: (origin: ChannelOrigin) => Promise<string | null>;
}): OrchestratorDeliverFn {
  return async ({ orgId, ownerType, ownerId, actorUserId, signal, dispatchId }) => {
    // Every subscription resolves the singleton runtime of its owner.
    await deliverToAssistantThread(deps, {
      orgId,
      owner: { type: ownerType, id: ownerId },
      actorUserId,
      threadKey: threadKeyForSignal(signal),
      signal,
      dispatchId,
      mismatchReason: "event_target_mismatch",
    });
  };
}
