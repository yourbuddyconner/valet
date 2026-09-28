/**
 * Event ingest: NormalizedEvent -> events row + matched event_deliveries
 * rows, one transaction. Callers (generic webhook route, github-app
 * forwarder) handle org resolution and signature verification first.
 */
import { createEventReceipt, appendReceiptStage } from "./receipts.js";
import type { ReceiptSubscriptionDecision } from "../wire/types.js";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { EventCatalogEntry, NormalizedEvent, ValetPlugin } from "@valet/engine";
import type { AppDb } from "../lib/drizzle.js";
import { eventDeliveries, events, eventSubscriptions } from "../schema/index.js";
import { filtersMatch, type SubscriptionFilter, subscriptionNamesKey } from "./match.js";
import { authorizedSlackDiagnosticSubscription, isTeamAssistantRule, subscriptionMatchOutcome } from "./team-slack-gate.js";
import { writeDropLog } from "../orchestrator/signals.js";

export interface IngestDeps {
  db: AppDb;
  plugins: ValetPlugin[];
  /** In-process dispatcher nudge; wired in main.ts. */
  onIngest?: () => void;
}

export function catalogForService(plugins: ValetPlugin[], service: string): EventCatalogEntry[] {
  return plugins
    .flatMap((p) => p.triggers ?? [])
    .filter((t) => t.service === service)
    .flatMap((t) => t.catalog);
}

/** The merged catalog across every plugin and service. The one traversal the
 * subscription validator, the mention-scope gate, and the filter-options
 * lookup all share, so a catalog-shape change lands in one place. */
export function allCatalogEntries(plugins: ValetPlugin[]): EventCatalogEntry[] {
  return plugins.flatMap((p) => p.triggers ?? []).flatMap((t) => t.catalog);
}

export interface IngestResult {
  eventId: string;
  duplicate: boolean;
  deliveries: number;
  /** True when the event matched no enabled subscription and was not
   * persisted. Valet retains an event only when a subscription asked for it. */
  skipped?: boolean;
  /** True when an enabled subscription names the normalized key, regardless
   * of whether its filters admitted this occurrence. */
  namedSubscription?: boolean;
}

/**
 * Drop-logs the high-signal miss: a subscription NAMES this event key but its
 * filter excluded this occurrence — the "why didn't my trigger fire?" case.
 * Throttled per (org, event key): one row a minute is enough to diagnose a bad
 * filter without a busy key flooding the table. The row records the normalized
 * key and small diagnostic metadata, never the source payload or refs.
 *
 * An event no subscription names at all is NOT logged here — for a high-volume
 * key like slack.message that is every message, so logging it would re-flood
 * the drop-log the privacy design keeps small. The "last event received" signal
 * (`GET /api/events/drops`) answers "is anything arriving?" for that case.
 */
const FILTER_DROP_COOLDOWN_MS = 60_000;
const filterDropLoggedAt = new Map<string, number>();

/** Test-only: clears the per-process filter-drop throttle so a suite can assert
 * one row per key without the cooldown bleeding across cases. */
export function __resetIngestDropThrottle(): void {
  filterDropLoggedAt.clear();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function claimDropThrottle(orgId: string, suffix: string): boolean {
  const throttleKey = `${orgId}:${suffix}`;
  const now = Date.now();
  const last = filterDropLoggedAt.get(throttleKey);
  if (last !== undefined && now - last < FILTER_DROP_COOLDOWN_MS) return false;
  filterDropLoggedAt.set(throttleKey, now);
  return true;
}

function diagnosticMetadata(payload: unknown): Record<string, string> {
  if (!isRecord(payload)) return {};
  const pick = (key: string): string | undefined => typeof payload[key] === "string" ? payload[key] : undefined;
  const metadata: Record<string, string> = {};
  const channel = pick("channel") ?? pick("channel_id");
  const botId = pick("bot_id");
  const rawEventType = pick("type");
  const rawSubtype = pick("subtype");
  if (channel) metadata.channel = channel;
  if (botId) metadata.botId = botId;
  if (rawEventType) metadata.rawEventType = rawEventType;
  if (rawSubtype) metadata.rawSubtype = rawSubtype;
  return metadata;
}

async function logFilterExcludedDrop(
  db: AppDb,
  orgId: string,
  eventKey: string,
  payload: unknown,
  detail?: string,
  throttleKeySuffix = eventKey,
  throttleClaimed = false,
): Promise<void> {
  if (!throttleClaimed && !claimDropThrottle(orgId, throttleKeySuffix)) return;
  const message = detail ?? `A ${eventKey} event arrived, but every subscription for it excluded it by filter. Check the filters on your ${eventKey} subscription.`;
  try {
    await writeDropLog(db, {
      orgId,
      reason: "filter_excluded",
      eventKey,
      eventMetadata: diagnosticMetadata(payload),
      detail: message,
    });
  } catch (err) {
    console.error("[ingest] filter-excluded drop-log failed", err);
  }
}

/**
 * Records the specific Slack classifier near-miss where a bot message was
 * normalized as `slack.bot_message` while an enabled subscription explicitly
 * names `slack.message`. The raw event is not persisted; this is only the
 * same bounded, throttled diagnostic as a filter miss. Calling this only for
 * an enabled named key keeps ordinary bot traffic out of the drop log.
 */
export async function logSlackMessageBotNearMiss(
  db: AppDb,
  orgId: string,
  payload: unknown,
): Promise<void> {
  const subs = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.orgId, orgId), eq(eventSubscriptions.enabled, true)));
  const named = subs.filter((sub) => subscriptionNamesKey(sub, "slack.message"));
  if (named.length === 0) return;
  const detail = "A Slack bot message arrived, but `slack.message` accepts only human messages. Subscribe to `slack.bot_message` to receive bot form deliveries.";
  const throttleKey = "slack.message:bot_near_miss";
  const nonTeam = named.find((sub) => !isTeamAssistantRule(sub.ownerType, sub.target));
  if (nonTeam) {
    await logFilterExcludedDrop(db, orgId, "slack.message", payload, detail, throttleKey);
    return;
  }
  // Slack bot messages normally have no user. Do not treat an absent sender as
  // an unauthorized team member and do not create an authorization diagnostic.
  if (!isRecord(payload) || typeof payload.user !== "string") return;
  // Claim before membership lookups. A bot flood must not create one denial per
  // message, and only an all-team candidate set reaches this gate.
  if (!claimDropThrottle(orgId, throttleKey)) return;
  for (const sub of named) {
    if (await authorizedSlackDiagnosticSubscription(db, sub, payload, false)) {
      await logFilterExcludedDrop(db, orgId, "slack.message", payload, detail, throttleKey, true);
      return;
    }
  }
  // Every named team subscription rejected the sender. Record exactly one
  // metadata-free authorization diagnostic after the throttle claim.
  await authorizedSlackDiagnosticSubscription(db, named[0], payload);
}

function failedFilterFields(filters: unknown, key: string, payload: unknown, catalog: EventCatalogEntry[], teamMention: boolean) {
  if (!Array.isArray(filters)) return [];
  const valid = filters.filter((f): f is SubscriptionFilter => isRecord(f) && typeof f.field === "string" &&
    (f.op === "eq" || f.op === "in" || f.op === "prefix" || f.op === "contains" || f.op === "regex") &&
    (typeof f.value === "string" || Array.isArray(f.value) && f.value.every(v => typeof v === "string")));
  return valid.filter(f => !(teamMention && key === "slack.app_mention" && f.field === "user") &&
    !filtersMatch(payload, key, [f], catalog)).slice(0, 20).map(f => ({ field: f.field, op: f.op }));
}

export async function ingestEvent(
  deps: IngestDeps,
  args: { orgId: string; service: string; event: NormalizedEvent; receiptId?: string },
): Promise<IngestResult> {
  const { orgId, service, event } = args;
  const receiptId = args.receiptId ?? await createEventReceipt(deps.db, { orgId, service, externalId: event.dedupeKey });
  if (!args.receiptId) await appendReceiptStage(deps.db, receiptId, { stage: "receipt", outcome: "received", detail: "An event reached normalized ingestion. Verification is handled by the source adapter." });
  await appendReceiptStage(deps.db, receiptId, { stage: "classification", outcome: "accepted", detail: `Normalized as ${event.key}.` }, { eventKey: event.key });
  let phase = "subscription lookup";
  try {
    const now = Date.now();
    const eventId = randomUUID();
    const catalog = catalogForService(deps.plugins, service);
    // Number.isFinite (not `|| now`): epoch-0 timestamps parse to 0, which is
    // falsy but valid — only an unparseable occurredAt falls back to receipt time.
    const parsedOccurredAt = Date.parse(event.occurredAt);
    const occurredAt = Number.isFinite(parsedOccurredAt) ? parsedOccurredAt : now;

    // Match-gated persistence, for every event. The event is matched against
    // the org's enabled subscriptions in ONE read; one that matches nothing is
    // dropped and never touches the events table. This is a privacy rule: Valet
    // retains event data only when a subscription asked for it, so an org that
    // watches one repo does not accumulate every other event its webhook happens
    // to deliver. Subscribing is what turns persistence on.
    //
    // The match is the full key + filter test, so an event a subscription
    // excludes by filter is dropped like one no subscription names at all — the
    // filter is a privacy boundary, not only a delivery boundary.
    //
    // The same matched set gates persistence and seeds the deliveries, so the
    // "store it" and "deliver it" decisions can never disagree. A subscription
    // changed between this read and the insert costs one boundary event (a new
    // one misses this event; a deleted one gets a harmless orphan delivery, safe
    // because `event_deliveries` holds no foreign key to the subscription). The
    // next event sees the change.
    const configured = await deps.db.select().from(eventSubscriptions).where(eq(eventSubscriptions.orgId, orgId));
    const subs = configured.filter(sub => sub.enabled);
    const decisions: ReceiptSubscriptionDecision[] = [];
    const matched: typeof subs = [];
    let authorizationDenied = false;
    phase = "subscription filter and sender authorization checks";
    for (const sub of subs) {
      const outcome = await subscriptionMatchOutcome(deps.db, sub, event.key, event.payload, catalog);
      if (outcome === "matched") matched.push(sub);
      if (outcome === "authorization_denied") authorizationDenied = true;
      if (subscriptionNamesKey(sub, event.key)) decisions.push({
        id: sub.id, name: sub.name, ownerType: sub.ownerType, ownerId: sub.ownerId,
        target: isRecord(sub.target) && typeof sub.target.kind === "string" ? sub.target.kind : "unknown",
        outcome: outcome === "not_matched" ? "filter_excluded" : outcome,
        ...(outcome === "not_matched" ? { failedFilters: failedFilterFields(sub.filters, event.key, event.payload, catalog, isTeamAssistantRule(sub.ownerType, sub.target)) } : {}),
        ...(isRecord(sub.target) && sub.target.kind === "workflow" && typeof sub.target.workflowId === "string" ? { targetId: sub.target.workflowId } : {}),
      });
    }
    for (const sub of configured.filter(sub => !sub.enabled && subscriptionNamesKey(sub, event.key))) {
      decisions.push({ id: sub.id, name: sub.name, ownerType: sub.ownerType, ownerId: sub.ownerId,
        target: isRecord(sub.target) && typeof sub.target.kind === "string" ? sub.target.kind : "unknown", outcome: "disabled" });
    }
    await appendReceiptStage(deps.db, receiptId, { stage: "subscription_match",
      outcome: matched.length > 0 ? "matched" : authorizationDenied ? "authorization_denied" : decisions.some(d => d.outcome === "filter_excluded") ? "filtered" : "no_subscription",
      detail: `${subs.length} enabled subscriptions checked; ${decisions.filter(d => d.outcome !== "disabled").length} name this key; ${matched.length} matched; ${decisions.filter(d => d.outcome === "disabled").length} naming this key are disabled. Decisions show up to 50 matching-key subscriptions.`,
    }, { subscriptions: decisions });
    const namedSubscriptions = subs.filter((sub) => subscriptionNamesKey(sub, event.key));
    const namedSubscription = namedSubscriptions.length > 0;
    // A sender denial is an authorization diagnostic, not a filter miss. Never
    // retain the denied sender's payload as filter-excluded metadata.
    if (matched.length === 0 && namedSubscription && !authorizationDenied) {
      let diagnosticPayload: unknown = event.payload;
      const teamOnly = namedSubscriptions.every((sub) => isTeamAssistantRule(sub.ownerType, sub.target));
      if (teamOnly) {
        const authorized = await Promise.all(namedSubscriptions.map((sub) =>
          authorizedSlackDiagnosticSubscription(deps.db, sub, event.payload, false),
        ));
        // A team-only filter miss from an unauthorized sender can explain the
        // missed rule, but must not retain their event-derived metadata.
        if (!authorized.some(Boolean)) diagnosticPayload = undefined;
      }
      await logFilterExcludedDrop(deps.db, orgId, event.key, diagnosticPayload);
    }
    if (matched.length === 0) {
      await appendReceiptStage(deps.db, receiptId, { stage: "persistence", outcome: "skipped", detail: "No delivery was requested. Source payload was not stored. Review the subscription decisions." });
      return { eventId, duplicate: false, deliveries: 0, skipped: true, namedSubscription };
    }

    phase = "event and delivery persistence";
    const result = await deps.db.transaction(async (tx) => {
      const inserted = await tx
        .insert(events)
        .values({
          id: eventId,
          orgId,
          service,
          eventKey: event.key,
          dedupeKey: event.dedupeKey,
          actor: event.actor ?? null,
          refs: event.refs,
          summary: event.summary,
          payload: event.payload,
          occurredAt,
          receivedAt: now,
        })
        .onConflictDoNothing({ target: [events.service, events.dedupeKey] })
        .returning({ id: events.id });
      if (inserted.length === 0) {
        const [existing] = await tx.select({ id: events.id }).from(events)
          .where(and(eq(events.orgId, orgId), eq(events.service, service), eq(events.dedupeKey, event.dedupeKey))).limit(1);
        return { eventId: existing?.id ?? eventId, duplicate: true, deliveries: 0, linkedEventId: existing?.id };
      }

      if (matched.length > 0) {
        await tx.insert(eventDeliveries).values(
          matched.map((sub) => ({
            id: randomUUID(),
            eventId,
            subscriptionId: sub.id,
            status: "pending" as const,
            attempts: 0,
            nextAttemptAt: now,
            createdAt: now,
          })),
        );
      }
      return { eventId, duplicate: false, deliveries: matched.length, linkedEventId: eventId };
    });

    await appendReceiptStage(deps.db, receiptId, { stage: "persistence", outcome: result.duplicate ? "duplicate" : "stored",
      detail: result.duplicate ? "This provider event was already stored. No duplicate deliveries were created." : `Event stored with ${result.deliveries} pending deliveries. Open its activity entry for delivery attempts and workflow results.`,
    }, result.linkedEventId ? { eventId: result.linkedEventId } : undefined);
    if (!result.duplicate && result.deliveries > 0) {
      phase = "dispatcher wake after storing pending deliveries";
      deps.onIngest?.();
      await appendReceiptStage(deps.db, receiptId, { stage: "dispatch", outcome: "enqueued", detail: "Delivery records are pending. Enqueueing does not mean a workflow has completed." });
    }
    return { eventId: result.eventId, duplicate: result.duplicate, deliveries: result.deliveries };
  } catch (error) {
    await appendReceiptStage(deps.db, receiptId, { stage: "ingestion", outcome: "failed", detail: `Processing failed during ${phase}. Check server logs using this receipt reference; no exception payload is retained here.` });
    console.error(`[ingest] receipt ${receiptId ?? "unavailable"} failed`, error);
    throw error;
  }
}
