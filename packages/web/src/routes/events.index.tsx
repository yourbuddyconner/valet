import { useEffect, useState } from "react";
import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router";
import { TabBar, tabPanelId } from "~/components/primitives";
import { WorkspaceClause } from "~/components/workspace-clause";
import { EventFeed, type FeedScope } from "~/components/events/feed";
import { SubscriptionsPanel } from "~/components/events/subscriptions-panel";
import { useMe } from "~/api/settings";
import { ReceiptsPanel } from "~/components/events/receipts-panel";
import { DropsPanel } from "~/components/events/drops-panel";
import { textParam } from "~/lib/search-params";

/**
 * `/events` — the UI over the event system (feed, catalog, subscriptions;
 * see the events router in packages/api). Tabs:
 *
 * - Activity: ingested events, filterable by service/key, each expandable
 *   into its payload and delivery attempts. The scope control starts at the
 *   active workspace's events and opens to the whole org on request.
 * - Subscriptions: the rules that turn a matching event into a workflow
 *   run or an orchestrator prompt, listed for the active workspace.
 * - Problems: reasons why an event did not become an activity row.
 * - Delivery log: admin-only receipt metadata and processing decisions.
 *
 * The selected tab and the feed scope live in search params. A shared
 * Problems search or cursor must also select Problems after reload. This
 * follows the workflows hub's `?tab=` pattern. One event has its own URL,
 * `/events/$eventId`, because a broken run needs a paste-able reference.
 */
type TabId = "activity" | "subscriptions" | "problems" | "receipts";

interface EventsSearch {
  tab?: TabId;
  scope?: FeedScope;
  problemsQ?: string;
  problemsCursor?: string;
  problemsDirection?: "previous";
}

/** Only non-default values are written to the URL. An absent or hand-edited
 * value reads as the default tab and workspace scope. */
export function readEventsSearch(raw: unknown): EventsSearch {
  const tabValue = textParam(raw, "tab");
  const tab = tabValue === "subscriptions" || tabValue === "problems" || tabValue === "receipts" ? tabValue : undefined;
  const scope = textParam(raw, "scope") === "all" ? "all" : undefined;
  const problemsQ = textParam(raw, "problemsQ");
  const problemsCursor = textParam(raw, "problemsCursor");
  const problemsDirection = textParam(raw, "problemsDirection") === "previous" ? "previous" as const : undefined;
  return { ...(tab ? { tab } : {}), ...(scope ? { scope } : {}), ...(problemsQ ? { problemsQ } : {}), ...(problemsCursor ? { problemsCursor } : {}), ...(problemsDirection ? { problemsDirection } : {}) };
}

export const Route = createFileRoute("/events/")({
  component: EventsPage,
  validateSearch: readEventsSearch,
});

const TABS_LABEL = "Events sections";
const TABS = [
  { id: "activity", label: "Activity" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "problems", label: "Problems" },
] as const;

export function EventsPage() {
  // The top-level hooks, not `Route.useSearch()`: the route suite mocks
  // this module and never builds a real router context.
  const search = readEventsSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const me = useMe();
  const isAdmin = !me.error && me.data?.orgRole === "admin";
  const [selectedTab, setTab] = useState<TabId>(search.tab ?? "activity");
  const tab = selectedTab === "receipts" && !isAdmin ? "activity" : selectedTab;
  const tabs = isAdmin ? [...TABS, { id: "receipts" as const, label: "Delivery log" }] : TABS;
  useEffect(() => setTab(search.tab ?? "activity"), [search.tab]);
  const scope: FeedScope = search.scope ?? "workspace";

  function selectTab(next: TabId) {
    setTab(next);
    void navigate({
      to: "/events",
      search: (previous) => {
        const current = readEventsSearch(previous);
        const { tab: _tab, ...rest } = current;
        return next === "activity" ? rest : { ...rest, tab: next };
      },
    });
  }

  return (
    <div className="min-w-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-10">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h1 className="font-display text-2xl text-ink">Events</h1>
          <WorkspaceClause />
        </div>
        <p className="mt-1 text-sm text-muted">
          What your connected integrations report, and what runs in response.
        </p>

        <div className="mt-6">
          <TabBar tabs={tabs} active={tab} onSelect={selectTab} label={TABS_LABEL} />
        </div>

        <div
          role="tabpanel"
          id={tabPanelId(TABS_LABEL, tab)}
          aria-labelledby={`${tabPanelId(TABS_LABEL, tab)}-tab`}
          className="mt-6"
        >
          {tab === "activity" && (
            <EventFeed
              scope={scope}
              onScopeChange={(next) =>
                void navigate({ to: "/events", search: { ...(tab === "activity" ? {} : { tab }), ...(next === "all" ? { scope: "all" as const } : {}), ...(search.problemsQ ? { problemsQ: search.problemsQ } : {}), ...(search.problemsCursor ? { problemsCursor: search.problemsCursor } : {}), ...(search.problemsDirection ? { problemsDirection: search.problemsDirection } : {}) } })
              }
            />
          )}
          {tab === "receipts" && isAdmin && <ReceiptsPanel key={me.data?.orgId} />}
          {tab === "subscriptions" && <SubscriptionsPanel />}
          {tab === "problems" && (
            <DropsPanel
              query={search.problemsQ}
              cursor={search.problemsCursor}
              direction={search.problemsDirection}
              onQueryChange={(problemsQ) => {
                problemsQ = problemsQ.trim() ? problemsQ : "";
                void navigate({ to: "/events", search: { tab: "problems", ...(scope === "all" ? { scope: "all" as const } : {}), ...(problemsQ ? { problemsQ } : {}) } });
              }}
              onPrevious={(problemsCursor) => void navigate({ to: "/events", search: { tab: "problems", ...(scope === "all" ? { scope: "all" as const } : {}), ...(search.problemsQ ? { problemsQ: search.problemsQ } : {}), ...(problemsCursor ? { problemsCursor, problemsDirection: "previous" as const } : {}) } })}
              onNext={(problemsCursor) => void navigate({ to: "/events", search: { tab: "problems", ...(scope === "all" ? { scope: "all" as const } : {}), ...(search.problemsQ ? { problemsQ: search.problemsQ } : {}), problemsCursor } })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
