import { useState } from "react";
import { RefreshCw } from "lucide-react";
import {
  Button,
  EmptyRow,
  ErrorRow,
  LoadingRow,
  SelectMenu,
} from "~/components/primitives";
import { useEventCatalog, useEvents } from "~/api/events";
import { useListOwner } from "~/lib/use-list-owner";
import { useMe } from "~/api/settings";
import { EventRow } from "./event-row";

/** Sentinel for "no filter applied". */
const ALL = "";

/** The feed API's own page size; the UI has no pagination yet, so a feed
 * at exactly this count may be hiding older events. */
const FEED_PAGE_SIZE = 50;

/** How far back the workspace-scoped feed reaches. Must match
 * `OWNER_FEED_WINDOW_MS` in `packages/api/src/routes/events.ts`; "All" has
 * no window. Exported for the case that holds the two together
 * (`feed-window.test.ts`). */
export const WORKSPACE_WINDOW_DAYS = 30;

/** Which events the feed asks for: those delivered to the active
 * workspace's subscriptions, or every event the org ingested. The route
 * owns the value, in `?scope=`. */
export type FeedScope = "workspace" | "all";

const SCOPE_OPTIONS = [
  { value: "workspace", label: "This workspace" },
  { value: "all", label: "All" },
] as const;

/**
 * The event feed: normalized events ingested from integration webhooks,
 * newest first, filterable by service and event key (both drawn from the
 * plugin trigger catalog). A row expands into the raw payload and the
 * delivery attempts made for it, so "my subscription never fired" is
 * answerable from this page alone.
 *
 * The scope control starts at "This workspace". "All" must stay available:
 * an event that matched nothing you own is precisely the row you open when
 * your subscription never fired.
 *
 * `scope` is a prop, not local state, because the Activity and
 * Subscriptions tabs unmount each other and the round trip that needs "All"
 * crosses them.
 */
export function EventFeed({
  scope,
  onScopeChange,
}: {
  scope: FeedScope;
  onScopeChange: (next: FeedScope) => void;
}) {
  const [service, setService] = useState(ALL);
  const [key, setKey] = useState(ALL);
  const owner = useListOwner();
  const me = useMe();
  const catalogQ = useEventCatalog();
  // An owner-less request IS the org-wide feed, so a control reading "This
  // workspace" must not fetch until the owner resolves.
  const canFetch = scope === "all" || owner !== undefined;
  // `useListOwner` answers undefined both while identity loads AND when it
  // fails. A hold that failure caused never ends, so report it instead.
  const ownerFailed = !canFetch && me.isError;
  const eventsQ = useEvents(
    { service: service || undefined, key: key || undefined },
    scope === "workspace" ? owner : undefined,
    { enabled: canFetch },
  );
  const [expanded, setExpanded] = useState<string | null>(null);

  const services = catalogQ.data?.services ?? [];
  const keysForService = service
    ? (services.find((s) => s.service === service)?.entries ?? []).map((e) => e.key)
    : [];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SelectMenu
          value={scope}
          triggerClassName="max-w-full whitespace-normal text-left"
          onChange={onScopeChange}
          triggerLabel={`Scope: ${scope === "all" ? "All" : "This workspace"}`}
          options={SCOPE_OPTIONS}
        />

        <SelectMenu
          value={service}
          triggerClassName="max-w-full whitespace-normal text-left"
          onChange={(next) => {
            setService(next);
            setKey(ALL);
          }}
          options={[
            { value: ALL, label: "All services" },
            ...services.map((s) => ({ value: s.service, label: s.service })),
          ]}
        />

        {service && keysForService.length > 0 && (
          <SelectMenu
            value={key}
            onChange={setKey}
            triggerClassName="max-w-full break-all whitespace-normal text-left font-mono text-xs"
            options={[
              { value: ALL, label: "All events" },
              ...keysForService.map((k) => ({ value: k, label: <span className="font-mono text-xs">{k}</span> })),
            ]}
          />
        )}

        <div className="flex-1" />
        {/* `refetch()` ignores `enabled`, so a press during the hold would
            fetch the org-wide feed under a "This workspace" control. */}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          aria-label="Refresh events"
          disabled={!canFetch || eventsQ.isFetching}
          onClick={() => void eventsQ.refetch()}
        >
          <RefreshCw className={`h-3.5 w-3.5 ${eventsQ.isFetching ? "animate-spin" : ""}`} aria-hidden />
        </Button>
      </div>

      {/* `isPending`, not `isLoading`: a held query is not fetching, but
          it still counts as loading. */}
      {eventsQ.isPending && !ownerFailed && <LoadingRow label="Loading events…" />}
      {eventsQ.error != null && (
        <ErrorRow>Failed to load events. Press refresh to try again.</ErrorRow>
      )}
      {ownerFailed && (
        <ErrorRow>
          Could not load your workspace, so this feed cannot narrow to it. Select All to see every
          event a subscription in the organization matched.
        </ErrorRow>
      )}

      {eventsQ.data && eventsQ.data.events.length === 0 && (
        <EmptyRow>
          {scope === "workspace"
            ? `No events reached this workspace's subscriptions in the last ${WORKSPACE_WINDOW_DAYS} days. Select All to see every event a subscription in the organization matched, or open the Event Logs tab for events that arrived but matched nothing.`
            : "No events yet. An event appears here when a webhook matches a subscription. If you expected one, open the Event Logs tab to see what arrived and why it was dropped."}
        </EmptyRow>
      )}

      {eventsQ.data && eventsQ.data.events.length > 0 && (
        <div className="divide-y divide-line border-t border-line">
          {eventsQ.data.events.map((event) => (
            <EventRow
              key={event.id}
              event={event}
              open={expanded === event.id}
              onToggle={() => setExpanded((cur) => (cur === event.id ? null : event.id))}
            />
          ))}
        </div>
      )}

      {eventsQ.data && scope === "workspace" && eventsQ.data.events.length > 0 && (
        <p className="pt-1 text-xs text-muted">
          This workspace's feed covers the last {WORKSPACE_WINDOW_DAYS} days. Select All for
          every event the organization received.
        </p>
      )}

      {eventsQ.data && eventsQ.data.events.length >= FEED_PAGE_SIZE && (
        <p className="pt-1 text-xs text-muted">
          Showing the most recent {FEED_PAGE_SIZE} events. Narrow with a service or event filter to
          see more of this type.
        </p>
      )}
    </div>
  );
}
