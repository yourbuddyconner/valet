/**
 * Event feed, catalog, and subscriptions CRUD (event-system plan, Task 7).
 *
 * One router carrying both `/events*` and `/event-subscriptions*` path
 * families — mounted at `/api` in app.ts, after every more-specific router.
 * Everything is org-scoped off `c.var.user.orgId`; cross-org rows 404, never
 * 403 (same "an owned row and a missing row are indistinguishable" rule as
 * `routes/workflows.ts`). Inside that org scope, the feed and the
 * subscriptions list both take an optional `?ownerType=&ownerId=` pair that
 * narrows to one workspace plus the org's own rows. Subscription bodies are
 * validated against the merged plugin trigger catalog before any row is
 * written — the ingest matcher (`events/ingest.ts`) trusts the
 * `event_keys`/`filters` jsonb shapes this file writes.
 */
import type { FilterOption, FilterOptionResolver, StoredCredential, ValetPlugin } from "@valet/engine";
import { and, desc, eq, exists, gt, gte, lt, ne, or, sql, type SQL } from "drizzle-orm";
import { Hono } from "hono";
import { randomUUID } from "node:crypto";
import type { AppEnv } from "../env.js";
import { computeCollisions, type CollisionReport } from "../events/collisions.js";
import { allCatalogEntries, catalogForService } from "../events/ingest.js";
import type { SubscriptionFilter } from "../events/match.js";
import { storedAnyChannelState } from "../events/mention-scope.js";
import { validateSubscriptionWrite } from "../events/subscription-write.js";
import { authorizedSubscriptionMatchesEvent, isTeamAssistantRule } from "../events/team-slack-gate.js";
import type { AppDb } from "../lib/drizzle.js";
import { decodePageCursor, encodePageCursor, readLimit } from "../lib/page-cursor.js";
import { eventDeliveries, eventDropLog, events, eventSubscriptions, workflowDefinitions } from "../schema/index.js";
import { resolveOrgCredentialRead } from "../services/credential-resolution.js";
import { OnePasswordAuthError } from "../services/onepassword.js";
import { isTeamMember, withAuthorizedTeamOwnership } from "../services/teams.js";
import type {
  CreateEventSubscriptionRequest,
  CreateEventSubscriptionResponse,
  EventSubscriptionCollisionErrorWire,
  EventSubscriptionCollisionsWire,
  EventSubscriptionFilterWire,
  EventSubscriptionTargetWire,
  EventSubscriptionWire,
  EventSummaryWire,
  FilterOptionsResponse,
  GetEventCatalogResponse,
  GetEventResponse,
  ListEventDropsResponse,
  ListEventsResponse,
  ListEventSubscriptionsResponse,
  PatchEventSubscriptionRequest,
  PatchEventSubscriptionResponse,
  RedeliverEventResponse,
} from "../wire/types.js";
import { armableDefinitionRow } from "../workflows/service.js";
import { isOrgAdminUser } from "./_org-admin.js";
import { readOwnerFilter } from "./_owner-filter.js";

export const eventsRouter = new Hono<AppEnv>();

/**
 * Who may change an existing subscription. The rule is "you can change what
 * you could have created": an org one is org-wide by construction, a team
 * one belongs to its members, and a personal one to its owner. A caller who
 * fails this gets the same 404 as a missing row, so a subscription id never
 * confirms a team the caller is not on.
 *
 * Mutation only. Visibility is a separate, wider rule — see the list route
 * below.
 */
async function canMutateSubscription(
  db: AppDb,
  row: { ownerType: "user" | "team" | "org"; ownerId: string },
  userId: string,
): Promise<boolean> {
  if (row.ownerType === "org") return true;
  if (row.ownerType === "team") return isTeamMember(db, row.ownerId, userId);
  return row.ownerId === userId;
}

const FEED_DEFAULT_LIMIT = 50;
const FEED_MAX_LIMIT = 100;

/**
 * How far back the OWNER-FILTERED feed looks. No index can pre-select the
 * owner, so without this bound a workspace that matched nothing walks the
 * org's whole event history for one empty page. A lower bound on
 * `received_at` joins the `(org_id, received_at)` index condition, so it is
 * the cheapest bound available. The unfiltered feed keeps no window.
 *
 * `components/events/feed.tsx` prints this window to the reader and must
 * hold the same number. `feed-window.test.ts` reads this declaration and
 * fails when only one of them moves.
 */
const OWNER_FEED_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** The jsonb columns come back `unknown`; their shapes are owned by
 * `validateSubscriptionWrite` (`events/subscription-write.ts`), the one gate
 * in front of every write to this table. */
function rowToSubscription(row: typeof eventSubscriptions.$inferSelect): EventSubscriptionWire {
  return {
    id: row.id,
    name: row.name,
    ownerType: row.ownerType,
    ownerId: row.ownerId,
    eventKeys: row.eventKeys as string[],
    filters: row.filters as EventSubscriptionFilterWire[],
    target: row.target as EventSubscriptionTargetWire,
    // Only a team assistant rule has an audience, so only those rows carry
    // one on the wire. Filling it everywhere would hand a read-modify-write
    // client a field the write path refuses on its own target. Null on such a
    // row reads as `team`: the resolved value goes out, so no reader has to
    // know the default.
    ...(isTeamAssistantRule(row.ownerType, row.target)
      ? { audience: row.audience ?? ("team" as const) }
      : {}),
    enabled: row.enabled,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** `refs`/`actor` jsonb shapes are owned by the ingest writer
 * (`events/ingest.ts`), which only stores `NormalizedEvent` fields. */
function rowToEventSummary(row: typeof events.$inferSelect): EventSummaryWire {
  return {
    id: row.id,
    service: row.service,
    eventKey: row.eventKey,
    summary: row.summary,
    refs: row.refs as Record<string, string>,
    actor: (row.actor as EventSummaryWire["actor"]) ?? null,
    occurredAt: row.occurredAt,
    receivedAt: row.receivedAt,
  };
}

/** A stored row with its jsonb columns narrowed to the shapes the one write
 * gate (`validateSubscriptionWrite`) persists — what `computeCollisions`
 * compares against. */
type NarrowedSubscriptionRow = Omit<
  typeof eventSubscriptions.$inferSelect,
  "eventKeys" | "filters" | "target"
> & {
  eventKeys: string[];
  filters: SubscriptionFilter[];
  target: EventSubscriptionTargetWire;
};

/**
 * The collision report for one candidate write (TKAI-294): the candidate
 * compared against every ENABLED subscription in the org, minus the row
 * being edited. Disabled rows do not fire, so they cannot collide; enabling
 * one later re-runs this check (see the PATCH route).
 */
async function collisionsForWrite(
  db: AppDb,
  plugins: ValetPlugin[],
  orgId: string,
  candidate: { ownerType?: string; eventKeys: string[]; filters: SubscriptionFilter[]; target: EventSubscriptionTargetWire },
  excludeId?: string,
): Promise<CollisionReport<NarrowedSubscriptionRow>> {
  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.orgId, orgId), eq(eventSubscriptions.enabled, true)));
  const existing: NarrowedSubscriptionRow[] = rows
    .filter((r) => r.id !== excludeId)
    .map((r) => ({
      ...r,
      eventKeys: r.eventKeys as string[],
      filters: r.filters as SubscriptionFilter[],
      target: r.target as EventSubscriptionTargetWire,
    }));
  return computeCollisions(candidate, existing, allCatalogEntries(plugins));
}

function collisionsToWire(report: CollisionReport<NarrowedSubscriptionRow>): EventSubscriptionCollisionsWire {
  const toWire = (c: CollisionReport<NarrowedSubscriptionRow>["blocking"][number]) => ({
    subscription: rowToSubscription(c.subscription),
    relation: c.relation,
    sharedKeys: c.sharedKeys,
  });
  return { blocking: report.blocking.map(toWire), overlapping: report.overlapping.map(toWire) };
}

/** The 409 headline for a blocked write. Names the rules it steps on and the
 * two ways out, since `errorText` may be all a caller renders. */
function collisionBlockMessage(report: CollisionReport<NarrowedSubscriptionRow>): string {
  const names = report.blocking.map((c) => `"${c.subscription.name}"`).join(", ");
  return (
    `This rule covers everything ${names} already ${report.blocking.length === 1 ? "handles" : "handle"} ` +
    `on the same events, so both would fire together. Narrow its filters, or save again with ` +
    `"create anyway" to take over.`
  );
}

// ── Catalog ─────────────────────────────────────────────────────────────────

eventsRouter.get("/events/catalog", (c) => {
  const { plugins } = c.var.providers;
  const services = [...new Set(plugins.flatMap((p) => p.triggers ?? []).map((t) => t.service))];
  const resp: GetEventCatalogResponse = {
    services: services.map((service) => ({ service, entries: catalogForService(plugins, service) })),
  };
  return c.json(resp);
});

// ── Filter options ────────────────────────────────────────────────────────

/** The plugin (its `name` is the credential service) and resolver for a source. */
function resolverForSource(
  plugins: ValetPlugin[],
  source: string,
): { plugin: ValetPlugin; resolver: FilterOptionResolver } | null {
  for (const plugin of plugins) {
    const resolver = plugin.filterOptionResolvers?.[source];
    if (resolver) return { plugin, resolver };
  }
  return null;
}

/** The `dependsOn` a catalog field declares for this source (`["repo"]`), or empty. */
function dependsOnForSource(plugins: ValetPlugin[], source: string): string[] {
  for (const entry of allCatalogEntries(plugins)) {
    for (const field of entry.filters) {
      if (field.options?.source === source) return field.options.dependsOn ?? [];
    }
  }
  return [];
}

/** Per-(org, source, deps, q) memo so a keystroke does not re-hit the provider. */
const FILTER_OPTIONS_TTL_MS = 60_000;
const FILTER_OPTIONS_CACHE_CAP = 500;
const filterOptionsCache = new Map<string, { options: FilterOption[]; expiresAt: number }>();

/**
 * Lists the options for one filter field's source, so a rule filters on a
 * looked-up name, not a raw id. Dispatches to the owning plugin's resolver,
 * scoped by the org's credential for that plugin's service, and memoized with a
 * short TTL. An unknown source, an unconnected integration, or a provider error
 * returns `{ options: [], reason }` (200) — never an error status — so the
 * picker degrades to free text instead of breaking the form.
 */
eventsRouter.get("/events/filter-options", async (c) => {
  const user = c.var.user;
  const { plugins, engineCredentials, onePassword } = c.var.providers;
  const source = c.req.query("source");
  if (!source) return c.json({ error: "source query parameter is required" }, 400);

  const found = resolverForSource(plugins, source);
  if (!found) {
    const resp: FilterOptionsResponse = { options: [], reason: `unknown option source: ${source}` };
    return c.json(resp);
  }

  const deps: Record<string, string> = {};
  for (const dep of dependsOnForSource(plugins, source)) {
    const value = c.req.query(dep);
    if (value) deps[dep] = value;
  }
  const q = c.req.query("q") || undefined;

  const cacheKey = `${user.orgId}:${source}:${JSON.stringify(deps)}:${q ?? ""}`;
  const cached = filterOptionsCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return c.json({ options: cached.options } satisfies FilterOptionsResponse);
  }

  // The plugin name is its credential service (slack/github/linear).
  // Through the resolver, not the raw row: an admin's 1Password reference
  // carries no secret until it is resolved, and a raw read handed the
  // resolver an empty credential and returned no options. A missing or
  // unresolvable credential is a normal outcome here (empty options), so a
  // typed 1Password failure reads as none.
  let credential: StoredCredential | null;
  try {
    credential = await resolveOrgCredentialRead(
      { credentials: engineCredentials, onePassword },
      { orgId: user.orgId, scopes: ["org"] },
      found.plugin.name,
    );
  } catch (err) {
    if (!(err instanceof OnePasswordAuthError)) throw err;
    credential = null;
  }

  let options: FilterOption[] = [];
  let reason: string | undefined;
  let failed = false;
  try {
    options = await found.resolver({ orgId: user.orgId, q, deps, credential });
  } catch (err) {
    console.error(`[events] filter-options resolver ${source} failed`, err);
    reason = "The provider could not list options right now. Type the value instead.";
    failed = true;
  }
  if (options.length === 0 && reason === undefined && credential === null) {
    reason = "Connect the integration in Settings to choose from a list. Type the value instead.";
  }

  // Never memoize a failed lookup. A provider that rate-limits one keystroke
  // would otherwise answer the next minute of retries from an empty cache
  // entry, so the user sees a stable "no options" for a transient fault and
  // cannot retry their way out of it.
  //
  // Deliberately NOT replaced by a short negative TTL. Rate-limit backpressure
  // belongs to the provider read, not here: the Slack resolvers hold their
  // directory in a single-flight cache, so a scan that is failing has exactly
  // one attempt in flight per workspace no matter how fast the reader types
  // (`plugin-slack/src/transport/directory-cache.ts`). Caching the failure
  // here would only re-introduce the sticky "no matches" without adding a
  // bound the provider layer does not already give.
  if (!failed) {
    // Evict the oldest single entry (Map preserves insertion order), not the
    // whole cache — one org's typeahead must not flush every other org's.
    if (filterOptionsCache.size >= FILTER_OPTIONS_CACHE_CAP) {
      const oldest = filterOptionsCache.keys().next().value;
      if (oldest !== undefined) filterOptionsCache.delete(oldest);
    }
    filterOptionsCache.set(cacheKey, { options, expiresAt: Date.now() + FILTER_OPTIONS_TTL_MS });
  }

  const resp: FilterOptionsResponse = reason === undefined ? { options } : { options, reason };
  return c.json(resp);
});

// ── Feed ────────────────────────────────────────────────────────────────────

/**
 * The org's feed, with an optional owner filter. The `events` table has no
 * owner column: ownership is read one join away, through the deliveries the
 * dispatcher wrote. An event with no deliveries matches no owner, because
 * no subscription acted on it.
 *
 * The owner predicate must stay the SAME union the subscriptions list uses
 * — the named owner's rows, or the org's own. Drop the org branch here and
 * a workspace lists an org-owned subscription whose events its feed hides.
 */
eventsRouter.get("/events", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const service = c.req.query("service");
  const key = c.req.query("key");
  const rawLimit = Number.parseInt(c.req.query("limit") ?? "", 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, FEED_MAX_LIMIT) : FEED_DEFAULT_LIMIT;

  const filter = readOwnerFilter(c.req.query("ownerType"), c.req.query("ownerId"));
  if (filter.error) return c.json({ error: filter.error }, 400);

  const conditions = [eq(events.orgId, user.orgId)];
  if (service) conditions.push(eq(events.service, service));
  if (key) conditions.push(eq(events.eventKey, key));
  if (filter.owner) {
    const owner = filter.owner;
    conditions.push(gte(events.receivedAt, Date.now() - OWNER_FEED_WINDOW_MS));
    conditions.push(
      exists(
        db
          .select({ present: sql<number>`1` })
          .from(eventDeliveries)
          .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, eventDeliveries.subscriptionId))
          .where(
            and(
              eq(eventDeliveries.eventId, events.id),
              // Repeats the outer scope, so the join cannot reach another
              // org's subscription even if a delivery ever crossed one.
              eq(eventSubscriptions.orgId, user.orgId),
              or(
                and(
                  eq(eventSubscriptions.ownerType, owner.type),
                  eq(eventSubscriptions.ownerId, owner.id),
                ),
                // Org-owned subscriptions belong to every workspace.
                eq(eventSubscriptions.ownerType, "org"),
              ),
            ),
          ),
      ),
    );
  }

  const rows = await db
    .select()
    .from(events)
    .where(and(...conditions))
    .orderBy(desc(events.receivedAt))
    .limit(limit);

  const resp: ListEventsResponse = { events: rows.map(rowToEventSummary) };
  return c.json(resp);
});

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * `GET /api/events/drops` — recent reasons an event arrived but did not become
 * a feed row: a bad signature, the wrong workspace, a missing credential, or
 * (the common one) it matched no subscription. Answers "my trigger didn't
 * fire" when the feed is empty. Registered before `/events/:id` so the literal
 * path wins over the id param. No payload is exposed — the drop-log holds none.
 */
eventsRouter.get("/events/drops", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const limit = readLimit(c.req.query("limit"), FEED_DEFAULT_LIMIT, FEED_MAX_LIMIT);
  if (limit === undefined) return c.json({ error: "limit must be a whole number of 1 or more" }, 400);
  const query = c.req.query("q")?.trim() ?? "";
  if (query.length > 200) return c.json({ error: "q must be 200 characters or fewer" }, 400);
  const rawDirection = c.req.query("direction");
  if (rawDirection !== undefined && rawDirection !== "previous") return c.json({ error: "direction must be previous" }, 400);
  const direction = rawDirection === "previous" ? "previous" : "next";
  const rawCursor = c.req.query("cursor");
  const decoded = rawCursor === undefined ? undefined : decodePageCursor(rawCursor);
  const cursor = decoded && typeof decoded.orgId === "string" && decoded.orgId === user.orgId &&
    typeof decoded.q === "string" && decoded.q === query &&
    typeof decoded.createdAt === "number" && Number.isFinite(decoded.createdAt) &&
    typeof decoded.id === "string"
    ? { createdAt: decoded.createdAt, id: decoded.id }
    : undefined;
  if (rawCursor !== undefined && !cursor) return c.json({ error: "cursor is invalid" }, 400);

  const admin = await isOrgAdminUser(c);
  const dropConditions: SQL[] = [eq(eventDropLog.orgId, user.orgId)];
  // Slack interaction diagnostics identify form activity. They are the one
  // new sensitive diagnostic class, so members keep the established drop feed
  // without seeing those rows.
  if (!admin) dropConditions.push(ne(eventDropLog.reason, "slack_interaction_unmatched"), ne(eventDropLog.reason, "slack_classifier_rejected"));
  const visibleDropConditions = [...dropConditions];
  if (query) {
    const escapedQuery = escapeLike(query);
    const search = or(
      sql`${eventDropLog.reason} ILIKE ${`%${escapedQuery}%`} ESCAPE '\\'`,
      sql`${eventDropLog.detail} ILIKE ${`%${escapedQuery}%`} ESCAPE '\\'`,
    );
    if (search) dropConditions.push(search);
  }
  if (cursor) {
    const boundary = direction === "previous"
      ? or(gt(eventDropLog.createdAt, cursor.createdAt), and(eq(eventDropLog.createdAt, cursor.createdAt), gt(eventDropLog.id, cursor.id)))
      : or(lt(eventDropLog.createdAt, cursor.createdAt), and(eq(eventDropLog.createdAt, cursor.createdAt), lt(eventDropLog.id, cursor.id)));
    if (boundary) dropConditions.push(boundary);
  }
  const rows = await db.select().from(eventDropLog).where(and(...dropConditions))
    .orderBy(...(direction === "previous" ? [eventDropLog.createdAt, eventDropLog.id] : [desc(eventDropLog.createdAt), desc(eventDropLog.id)])).limit(limit + 1);
  const page = direction === "previous" ? rows.slice(0, limit).reverse() : rows.slice(0, limit);
  const first = page[0];
  const last = page.at(-1);
  const makeCursor = (row: typeof eventDropLog.$inferSelect) => encodePageCursor({ orgId: user.orgId, q: query, createdAt: row.createdAt, id: row.id });
  const nextCursor = last && (direction === "previous" ? cursor !== undefined : rows.length > limit) ? makeCursor(last) : null;
  const previousCursor = first && (direction === "previous" ? rows.length > limit : cursor !== undefined) ? makeCursor(first) : null;

  // "Last event received" = the most recent time ANY event reached ingest,
  // matched (an events row) or not (a visible drop-log row). This remains
  // global to the org, not the current search or cursor page.
  const [lastDropRow] = await db
    .select({ at: eventDropLog.createdAt })
    .from(eventDropLog)
    .where(and(...visibleDropConditions))
    .orderBy(desc(eventDropLog.createdAt), desc(eventDropLog.id))
    .limit(1);
  const lastEventRow = await db
    .select({ at: events.receivedAt })
    .from(events)
    .where(eq(events.orgId, user.orgId))
    .orderBy(desc(events.receivedAt))
    .limit(1);
  const candidates = [lastDropRow?.at, lastEventRow[0]?.at].filter(
    (v): v is number => typeof v === "number",
  );
  const lastEventAt = candidates.length > 0 ? Math.max(...candidates) : null;

  const resp: ListEventDropsResponse = {
    drops: page.map((r) => ({ id: r.id, reason: r.reason, detail: r.detail, createdAt: r.createdAt })),
    nextCursor,
    previousCursor,
    lastEventAt,
  };
  return c.json(resp);
});

eventsRouter.get("/events/:id", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.orgId, user.orgId)))
    .limit(1);
  const row = rows[0];
  if (!row) return c.json({ error: "event not found" }, 404);
  // The join carries the subscription NAME onto each delivery, so a row can
  // say what it was trying to reach. It also does the org scoping the
  // previous `subscriptionId IN (org subscriptions)` subquery did, over the
  // same set: a delivery whose subscription row is deleted has no join
  // partner and stays hidden, exactly as before.
  const deliveryRows = await db
    .select({
      id: eventDeliveries.id,
      subscriptionId: eventDeliveries.subscriptionId,
      subscriptionName: eventSubscriptions.name,
      status: eventDeliveries.status,
      attempts: eventDeliveries.attempts,
      lastError: eventDeliveries.lastError,
      deliveredAt: eventDeliveries.deliveredAt,
      nextAttemptAt: eventDeliveries.nextAttemptAt,
    })
    .from(eventDeliveries)
    .innerJoin(eventSubscriptions, eq(eventSubscriptions.id, eventDeliveries.subscriptionId))
    .where(and(eq(eventDeliveries.eventId, id), eq(eventSubscriptions.orgId, user.orgId)))
    .orderBy(desc(eventDeliveries.createdAt));

  const resp: GetEventResponse = {
    event: { ...rowToEventSummary(row), payload: row.payload },
    deliveries: deliveryRows.map((d) => ({
      id: d.id,
      subscriptionId: d.subscriptionId,
      subscriptionName: d.subscriptionName,
      status: d.status,
      attempts: d.attempts,
      lastError: d.lastError,
      deliveredAt: d.deliveredAt,
      // `next_attempt_at` keeps its last value after a delivery settles: a
      // dead row holds the timestamp of the attempt that gave up, and a
      // delivered row holds its claim lease. Report it only while another
      // attempt is really coming, or the UI promises a retry that the
      // dispatcher will never make.
      nextAttemptAt: d.status === "pending" || d.status === "failed" ? d.nextAttemptAt : null,
    })),
  };
  return c.json(resp);
});

/**
 * `POST /api/events/:id/redeliver` — replay one event through the
 * subscriptions that match it NOW.
 *
 * Three decisions worth stating, because each one is load-bearing:
 *
 * 1. **New delivery rows, always.** The dispatcher derives a workflow run id
 *    from the delivery id (`wfrun_evt_${deliveryId}`) and returns early when
 *    that run exists, so a "retry" that reset an old row would report
 *    success and start nothing. Redelivery therefore INSERTs, and never
 *    revives, a delivery row. A dead row stays dead as the record of what
 *    happened.
 * 2. **The subscriptions that match now, not the ones that matched then.**
 *    Someone who repaired a broken subscription expects this event to reach
 *    it, so a subscription created or fixed after the event still gets a
 *    delivery. Someone who disabled a subscription does not, so
 *    `enabled = false` rows are skipped. The match itself is the ingest
 *    match (`eventKeyMatches` + `filtersMatch` over the service catalog),
 *    called here so the two paths cannot drift.
 * 3. **No de-duplication against deliveries still in flight.** A `pending`
 *    or `failed` row is still on the dispatcher's due list, so redelivering
 *    an event mid-backoff can start a second run. The caller decides that:
 *    the UI names the scheduled retries in its confirm step. Suppressing the
 *    new row instead would make an explicit press do nothing.
 *
 * Access follows the other event routes: org scope, and a cross-org event
 * answers 404 like a missing one. The fan-out is the same fan-out any
 * webhook for this event would cause, and every target is an enabled
 * subscription its owner chose to arm.
 */
eventsRouter.post("/events/:id/redeliver", async (c) => {
  const { db, plugins, eventDispatcher } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const rows = await db
    .select()
    .from(events)
    .where(and(eq(events.id, id), eq(events.orgId, user.orgId)))
    .limit(1);
  const event = rows[0];
  if (!event) return c.json({ error: "event not found" }, 404);
  const subs = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.orgId, user.orgId), eq(eventSubscriptions.enabled, true)));

  const catalog = catalogForService(plugins, event.service);
  const matched: typeof subs = [];
  for (const sub of subs) {
    if (await authorizedSubscriptionMatchesEvent(db, sub, event.eventKey, event.payload, catalog)) matched.push(sub);
  }

  if (matched.length > 0) {
    const now = Date.now();
    await db.insert(eventDeliveries).values(
      matched.map((sub) => ({
        id: randomUUID(),
        eventId: event.id,
        subscriptionId: sub.id,
        status: "pending" as const,
        attempts: 0,
        nextAttemptAt: now,
        createdAt: now,
      })),
    );
    // Same in-process nudge the ingest path uses, so redelivery does not
    // wait for the next 1s poll tick.
    eventDispatcher.nudge();
  }

  const resp: RedeliverEventResponse = { created: matched.length };
  return c.json(resp);
});

// ── Subscriptions CRUD ──────────────────────────────────────────────────────

eventsRouter.post("/event-subscriptions", async (c) => {
  const { db, plugins } = c.var.providers;
  const user = c.var.user;

  let body: CreateEventSubscriptionRequest;
  try {
    body = (await c.req.json()) as CreateEventSubscriptionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }

  const write = await validateSubscriptionWrite(
    db,
    plugins,
    { ...body, filters: body.filters ?? [] },
    { creatorUserId: user.id, anyChannel: body.anyChannel === true, matchChanged: true },
  );
  if (!write.ok) return c.json({ error: write.error }, 400);
  const filters = write.filters;
  // Absent stays null in the row, so an untouched rule keeps reading as
  // team-only however the default is spelled later.
  const audience = write.audience ?? null;

  // A workflow target must be OWNED by the caller, not only exist in their
  // org: org scope alone lets any member wire automation onto another's.
  // Foreign, unowned and missing ids fail alike, so the error never shows
  // whether the id exists. Team membership is the bar, as it is for team
  // workflows and team sessions.
  let ownerType: "user" | "team" | "org" = "user";
  let ownerId = user.id;
  if (body.target.kind === "workflow") {
    const owned = await armableDefinitionRow(db, { userId: user.id, orgId: user.orgId }, body.target.workflowId);
    if (!owned) {
      return c.json({ error: `unknown workflow: ${body.target.workflowId}` }, 400);
    }
    // The owner names the workspace; `created_by` names who armed it. Team
    // only: `canMutateSubscription` lets any org member mutate an org-owned
    // row, so copying `owned.ownerType` wholesale fails open.
    if (owned.ownerType === "team") {
      ownerType = "team";
      ownerId = owned.ownerId;
    }
  } else if (body.target.kind === "orchestrator") {
    const who = body.target.orchestrator ?? "user";
    if (who === "org") {
      ownerType = "org";
      ownerId = user.orgId;
    } else if (who === "team") {
      // `validateSubscription` already refused a team target with no teamId.
      const teamId = body.target.teamId as string;
      if (!(await isTeamMember(db, teamId, user.id))) {
        // 404, not 403: a team the caller is not on must be indistinguishable
        // from one that does not exist — same convention as the sessions,
        // workflows and teams routes.
        return c.json({ error: "team not found" }, 404);
      }
      ownerType = "team";
      ownerId = teamId;
    }
  }

  // Collision gate (TKAI-294). Checked over the FINAL filters (after the
  // mention gate's injected user filter), so two users' mention rules
  // compare as the disjoint rules they are. A disabled create skips the
  // check — the row cannot fire, and enabling it later re-runs it.
  const enabled = body.enabled ?? true;
  let collisions: EventSubscriptionCollisionsWire | undefined;
  if (enabled) {
    const report = await collisionsForWrite(db, plugins, user.orgId, {
      ownerType,
      eventKeys: body.eventKeys,
      filters,
      target: body.target,
    });
    if (report.blocking.length > 0 && body.allowCollision !== true) {
      const resp: EventSubscriptionCollisionErrorWire = {
        error: collisionBlockMessage(report),
        collisions: collisionsToWire(report),
      };
      return c.json(resp, 409);
    }
    if (report.blocking.length > 0) {
      // The audit trail for a knowing override — a doubled delivery later
      // should be traceable to who accepted it and over which rules.
      console.warn(
        `[events] collision override: user ${user.id} created a subscription over ` +
          report.blocking.map((b) => b.subscription.id).join(", "),
      );
    }
    if (report.blocking.length > 0 || report.overlapping.length > 0) {
      collisions = collisionsToWire(report);
    }
  }

  const now = Date.now();
  const values = {
    id: randomUUID(),
    orgId: user.orgId,
    ownerType,
    ownerId,
    name: body.name,
    eventKeys: body.eventKeys,
    filters,
    target: body.target,
    audience,
    enabled,
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  };

  let insertedRow: typeof eventSubscriptions.$inferSelect | undefined;
  if (ownerType === "team") {
    // `deleteTeam` deletes a team's own event_subscriptions rows, reaps its
    // workflows, and archives its assistants — all under this same lock
    // (services/teams.ts). Without it, a create that already passed the
    // ownership/membership/assistant checks above can still insert after
    // the team (or its target workflow/assistant) is gone, landing as a
    // permanent orphan — the race #709 closed for schedules.
    const rows = await withAuthorizedTeamOwnership(
      db,
      { teamId: ownerId, orgId: user.orgId, userId: user.id, principalTeamId: null, requireMembership: true },
      async (tx) => {
        if (body.target.kind === "workflow") {
          const [targetWorkflow] = await tx
            .select({ id: workflowDefinitions.id })
            .from(workflowDefinitions)
            .where(
              and(
                eq(workflowDefinitions.id, body.target.workflowId),
                eq(workflowDefinitions.orgId, user.orgId),
                eq(workflowDefinitions.ownerType, "team"),
                eq(workflowDefinitions.ownerId, ownerId),
              ),
            );
          if (!targetWorkflow) return [];
        }
        return tx.insert(eventSubscriptions).values(values).returning();
      },
    );
    if (!rows?.[0]) {
      return c.json(
        { error: "Team or subscription target is no longer available. Refresh and select an active target." },
        400,
      );
    }
    insertedRow = rows[0];
  } else {
    const inserted = await db.insert(eventSubscriptions).values(values).returning();
    insertedRow = inserted[0];
  }

  const resp: CreateEventSubscriptionResponse = {
    ...rowToSubscription(insertedRow!),
    ...(collisions !== undefined ? { collisions } : {}),
  };
  return c.json(resp, 201);
});

/**
 * Every subscription in the org, or one workspace's plus the org's own when
 * the caller names an owner. Visibility is wider than the mutation gate on
 * purpose: these rows were always org-visible, and the filter answers
 * "whose automations am I looking at", not "what may I see".
 */
eventsRouter.get("/event-subscriptions", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;

  const filter = readOwnerFilter(c.req.query("ownerType"), c.req.query("ownerId"));
  if (filter.error) return c.json({ error: filter.error }, 400);

  const conditions: (SQL | undefined)[] = [eq(eventSubscriptions.orgId, user.orgId)];
  if (filter.owner) {
    const owner = filter.owner;
    conditions.push(
      or(
        and(
          eq(eventSubscriptions.ownerType, owner.type),
          eq(eventSubscriptions.ownerId, owner.id),
        ),
        // Org-owned rows join every workspace's list, bounded to the
        // caller's org by the outer `orgId` predicate.
        eq(eventSubscriptions.ownerType, "org"),
      ),
    );
  }

  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(and(...conditions))
    .orderBy(desc(eventSubscriptions.createdAt));

  const resp: ListEventSubscriptionsResponse = { subscriptions: rows.map(rowToSubscription) };
  return c.json(resp);
});

eventsRouter.patch("/event-subscriptions/:id", async (c) => {
  const { db, plugins } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const rows = await db
    .select()
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.orgId, user.orgId)))
    .limit(1);
  const row = rows[0];
  // A personal subscription owned by someone else answers the same 404 as
  // a missing one — same "cross-owner access is indistinguishable from
  // not-found" convention as workflows/teams routes.
  if (!row || !(await canMutateSubscription(db, row, user.id))) {
    return c.json({ error: "subscription not found" }, 404);
  }

  let body: PatchEventSubscriptionRequest;
  try {
    body = (await c.req.json()) as PatchEventSubscriptionRequest;
  } catch {
    return c.json({ error: "invalid JSON body" }, 400);
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") {
    return c.json({ error: "enabled must be a boolean" }, 400);
  }

  if ("assistantId" in body) {
    return c.json({ error: "Assistant selection is not supported. Choose the subscription workspace instead." }, 400);
  }
  let patchedTarget = row.target as EventSubscriptionTargetWire;

  // The prompt templates are the other part of `target` a patch may rewrite,
  // and only on an orchestrator target. `null` clears the field, so the rule
  // delivers the default body again; the merged re-validation below checks a
  // new template against the rule's events. Shape only here: the template
  // language is `events/prompt-template.ts`'s to judge.
  for (const field of ["systemPrompt", "userPromptTemplate"] as const) {
    const patched = body[field];
    if (patched === undefined) continue;
    if (patchedTarget.kind !== "orchestrator") {
      return c.json({ error: `${field} is only valid on an orchestrator target` }, 400);
    }
    if (patched === null) {
      const { [field]: _cleared, ...rest } = patchedTarget;
      patchedTarget = rest;
    } else {
      patchedTarget = { ...patchedTarget, [field]: patched };
    }
  }

  // Re-validate the row as it would exist after the patch — provided fields
  // get full validation in the context of the untouched ones.
  const merged = {
    name: body.name ?? row.name,
    eventKeys: body.eventKeys ?? row.eventKeys,
    filters: body.filters ?? row.filters,
    target: patchedTarget,
    // An absent audience keeps the stored one, which must still be legal
    // against the patched target.
    audience: body.audience ?? row.audience ?? undefined,
  };
  // Mention scoping is keyed to the CREATOR and skipped for a patch that
  // does not change the match — so an enabled-only or name-only patch still
  // works after the creator unlinks Slack, and a colleague's patch of an
  // org-owned row cannot re-point the scope at themselves. The casts narrow
  // validated jsonb, same as `rowToSubscription`.
  const write = await validateSubscriptionWrite(db, plugins, merged, {
    creatorUserId: row.createdBy,
    ownerType: row.ownerType,
    anyChannel: body.anyChannel === true,
    matchChanged: body.filters !== undefined || body.eventKeys !== undefined,
    storedAnyChannel: storedAnyChannelState(
      row.eventKeys as string[],
      row.filters as SubscriptionFilter[],
    ),
    storedAudience: row.audience,
  });
  if (!write.ok) return c.json({ error: write.error }, 400);
  const filters = write.filters;
  const audience = write.audience ?? null;

  // Collision gate (TKAI-294), against the row as it would exist after the
  // patch, minus itself. Runs when the result can fire AND the patch changes
  // what it fires on — a match edit, or flipping enabled on (the create-time
  // check said nothing about a row born disabled). A rename of a live
  // colliding row stays unchecked: the collision predates the patch.
  const willBeEnabled = body.enabled ?? row.enabled;
  const matchChanged = body.filters !== undefined || body.eventKeys !== undefined;
  const arming = body.enabled === true && !row.enabled;
  let collisions: EventSubscriptionCollisionsWire | undefined;
  if (willBeEnabled && (matchChanged || arming)) {
    const report = await collisionsForWrite(
      db,
      plugins,
      user.orgId,
      {
        ownerType: row.ownerType,
        eventKeys: merged.eventKeys as string[],
        filters,
        // The PATCHED target: a patch that re-points the rule at a different
        // assistant changes who it collides with, and comparing the stored one
        // would answer for the rule as it was.
        target: patchedTarget,
      },
      id,
    );
    if (report.blocking.length > 0 && body.allowCollision !== true) {
      const resp: EventSubscriptionCollisionErrorWire = {
        error: collisionBlockMessage(report),
        collisions: collisionsToWire(report),
      };
      return c.json(resp, 409);
    }
    if (report.blocking.length > 0) {
      console.warn(
        `[events] collision override: user ${user.id} updated subscription ${id} over ` +
          report.blocking.map((b) => b.subscription.id).join(", "),
      );
    }
    if (report.blocking.length > 0 || report.overlapping.length > 0) {
      collisions = collisionsToWire(report);
    }
  }

  const updated = await db
    .update(eventSubscriptions)
    .set({
      name: merged.name,
      eventKeys: merged.eventKeys,
      filters,
      target: patchedTarget,
      audience,
      enabled: willBeEnabled,
      updatedAt: Date.now(),
    })
    .where(eq(eventSubscriptions.id, id))
    .returning();

  const resp: PatchEventSubscriptionResponse = {
    ...rowToSubscription(updated[0]),
    ...(collisions !== undefined ? { collisions } : {}),
  };
  return c.json(resp);
});

eventsRouter.delete("/event-subscriptions/:id", async (c) => {
  const { db } = c.var.providers;
  const user = c.var.user;
  const id = c.req.param("id");

  const rows = await db
    .select({ ownerType: eventSubscriptions.ownerType, ownerId: eventSubscriptions.ownerId })
    .from(eventSubscriptions)
    .where(and(eq(eventSubscriptions.id, id), eq(eventSubscriptions.orgId, user.orgId)))
    .limit(1);
  const row = rows[0];
  if (!row || !(await canMutateSubscription(db, row, user.id))) {
    return c.json({ error: "subscription not found" }, 404);
  }

  await db.delete(eventSubscriptions).where(eq(eventSubscriptions.id, id));
  return c.body(null, 204);
});
