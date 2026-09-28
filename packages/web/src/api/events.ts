/**
 * Query/mutation hooks for the events system: the org activity feed,
 * per-event detail (payload + delivery attempts), the plugin trigger
 * catalog, and event-subscription CRUD. Thin wrappers over `api` client
 * methods, mirroring `settings.ts`/`workflows.ts` conventions.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  CreateEventSubscriptionRequest,
  CreateEventSubscriptionResponse,
  FilterOptionsResponse,
  GetEventCatalogResponse,
  GetEventResponse,
  ListEventDropsResponse,
  ListEventReceiptsResponse,
  ListEventsResponse,
  ListEventSubscriptionsResponse,
  PatchEventSubscriptionRequest,
  PatchEventSubscriptionResponse,
  RedeliverEventResponse,
} from "@valet/api/wire";
import { api, type OwnerFilter } from "./client";

/** Key marker for a scoped query whose owner has not resolved. Not a valid
 * `ownerType`, so it can never collide with a real owner pair. */
const UNRESOLVED_OWNER = "owner-unresolved";

/** The workspace, as TRAILING key elements, so the bare prefix still
 * invalidates every workspace at once. Same shape as `qkMemory`'s.
 *
 * A held query sends no owner but must not read the unscoped cache entry:
 * a warm org-wide answer would render under a "This workspace" label. Hence
 * the third state. */
function ownerKey(owner: OwnerFilter | undefined, held: boolean): readonly string[] {
  if (owner) return [owner.ownerType, owner.ownerId];
  return held ? [UNRESOLVED_OWNER] : [];
}

/** Stable key for a filter-options lookup. `deps` is stringified so its key
 * order does not split the cache; `q` is a trailing element so an empty query
 * shares a prefix with a typed one. */
function filterOptionsKey(source: string, q: string, deps: Record<string, string>): readonly string[] {
  return ["events", "filter-options", source, JSON.stringify(deps), q] as const;
}

export const qkEvents = {
  catalog: () => ["events", "catalog"] as const,
  filterOptions: (source: string, q: string, deps: Record<string, string>) =>
    filterOptionsKey(source, q, deps),
  feed: (service?: string, key?: string, owner?: OwnerFilter, held = false) =>
    ["events", "feed", service ?? "", key ?? "", ...ownerKey(owner, held)] as const,
  detail: (id: string) => ["events", "detail", id] as const,
  drops: (q = "", cursor = "", direction = "") => ["events", "drops", q, cursor, direction] as const,
  subscriptions: (owner?: OwnerFilter, held = false) =>
    ["events", "subscriptions", ...ownerKey(owner, held)] as const,
};

export function useEventCatalog(opts?: Partial<UseQueryOptions<GetEventCatalogResponse>>) {
  return useQuery<GetEventCatalogResponse>({
    queryKey: qkEvents.catalog(),
    queryFn: () => api.getEventCatalog(),
    // The catalog only changes on a plugin registry change (a deploy).
    staleTime: 5 * 60_000,
    ...opts,
  });
}

/**
 * Provider-populated choices for one filter field's `source` (a Slack user, a
 * repo). `q` narrows the list; `deps` names each dependsOn field's value. The
 * server returns `{ options: [], reason }` for an unknown source, an
 * unconnected integration, or a provider error, so the caller falls back to
 * free text. Pass `enabled: false` until every dependsOn value is present.
 */
export function useFilterOptions(
  { source, q = "", deps = {} }: { source: string; q?: string; deps?: Record<string, string> },
  opts?: Partial<UseQueryOptions<FilterOptionsResponse>>,
) {
  return useQuery<FilterOptionsResponse>({
    queryKey: qkEvents.filterOptions(source, q, deps),
    queryFn: () => api.getFilterOptions({ source, q, deps }),
    // The provider list is stable across keystrokes within a short window; a
    // fresh lookup only matters when the query or a dep changes (a new key).
    staleTime: 30_000,
    ...opts,
  });
}

/** `owner` narrows the feed to events delivered to that owner's
 * subscriptions. Undefined keeps the whole org's feed, unless the caller
 * also disabled the query, which means "one workspace, owner still
 * unknown". */
export function useEvents(
  params?: { service?: string; key?: string },
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<ListEventsResponse>>,
) {
  // Held for a missing owner, not unscoped on purpose — see `ownerKey`.
  const held = owner === undefined && opts?.enabled === false;
  return useQuery<ListEventsResponse>({
    queryKey: qkEvents.feed(params?.service, params?.key, owner, held),
    queryFn: () => api.listEvents(params, owner),
    // New events arrive from external webhooks at any time.
    refetchInterval: 30_000,
    ...opts,
  });
}

export function useEvent(id: string, opts?: Partial<UseQueryOptions<GetEventResponse>>) {
  return useQuery<GetEventResponse>({
    queryKey: qkEvents.detail(id),
    queryFn: () => api.getEvent(id),
    // Deliveries advance (pending -> delivered/failed) while a row stays
    // expanded; poll so the badge follows.
    refetchInterval: 15_000,
    ...opts,
  });
}

/** A substring search cannot use the paging index, so it loads once instead
 * of polling. Unfiltered drops poll like the feed. */
export function eventDropsRefetchInterval(q?: string): false | 30_000 {
  return q ? false : 30_000;
}

/** Recent reasons an event arrived but did not become a feed row, plus the
 * last time any event reached ingest. */
export function useEventDrops(
  params: { q?: string; cursor?: string; direction?: "previous" } = {},
  opts?: Partial<UseQueryOptions<ListEventDropsResponse>>,
) {
  return useQuery<ListEventDropsResponse>({
    queryKey: qkEvents.drops(params.q, params.cursor, params.direction),
    queryFn: () => api.listEventDrops(params),
    placeholderData: (previousData) => previousData,
    refetchInterval: eventDropsRefetchInterval(params.q),
    ...opts,
  });
}

/**
 * Replays one event through the subscriptions that match it now. The server
 * writes NEW delivery rows, so the detail query is refetched to show them.
 */
export function useRedeliverEvent(id: string) {
  const qc = useQueryClient();
  return useMutation<RedeliverEventResponse, Error, void>({
    mutationFn: () => api.redeliverEvent(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkEvents.detail(id) });
    },
  });
}

/** `owner` scopes the list to one workspace plus every org-owned
 * subscription. Undefined lists every subscription in the org; an undefined
 * owner on a DISABLED query is the held workspace list instead. */
export function useEventSubscriptions(
  owner?: OwnerFilter,
  opts?: Partial<UseQueryOptions<ListEventSubscriptionsResponse>>,
) {
  const held = owner === undefined && opts?.enabled === false;
  return useQuery<ListEventSubscriptionsResponse>({
    queryKey: qkEvents.subscriptions(owner, held),
    queryFn: () => api.listEventSubscriptions(owner),
    ...opts,
  });
}

/** A workflow-target subscription is the same row the workflow page lists as
 * an event trigger (`["workflows", "triggers", …]`), so every subscription
 * mutation invalidates that key too — else the trigger list serves a stale
 * snapshot after an edit here. Raw prefix, matching `api/workflows.ts`. */
function invalidateSubscriptionReaders(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: qkEvents.subscriptions() });
  void qc.invalidateQueries({ queryKey: ["workflows", "triggers"] });
}

export function useCreateEventSubscription() {
  const qc = useQueryClient();
  return useMutation<CreateEventSubscriptionResponse, Error, CreateEventSubscriptionRequest>({
    mutationFn: (body) => api.createEventSubscription(body),
    onSuccess: () => {
      invalidateSubscriptionReaders(qc);
    },
  });
}

export function usePatchEventSubscription() {
  const qc = useQueryClient();
  return useMutation<
    PatchEventSubscriptionResponse,
    Error,
    { id: string; body: PatchEventSubscriptionRequest }
  >({
    mutationFn: ({ id, body }) => api.patchEventSubscription(id, body),
    onSuccess: () => {
      invalidateSubscriptionReaders(qc);
    },
  });
}

export function useDeleteEventSubscription() {
  const qc = useQueryClient();
  return useMutation<void, Error, string>({
    mutationFn: (id) => api.deleteEventSubscription(id),
    onSuccess: () => {
      invalidateSubscriptionReaders(qc);
    },
  });
}

/** Receipt logs are org-wide and admin-only. No placeholder data crosses a search or page boundary. */
export function useEventReceipts(orgId: string | undefined, params: { q?: string; cursor?: string; limit?: number }, enabled: boolean) {
  return useQuery<ListEventReceiptsResponse>({
    queryKey: ["events", "receipts", orgId, params.q ?? "", params.cursor ?? "", params.limit ?? 25],
    queryFn: () => api.listEventReceipts(params),
    enabled: enabled && !!orgId,
    refetchInterval: params.q || params.cursor ? false : 30_000,
  });
}
