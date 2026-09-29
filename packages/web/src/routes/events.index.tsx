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

/** Activity, subscriptions, and recorded event diagnostics. Legacy tab URLs
 * remain readable so existing links keep their searches and cursors. */
type TabId = "activity" | "subscriptions" | "logs";

interface EventsSearch {
  tab?: TabId;
  review?: string;
  scope?: FeedScope;
  problemsQ?: string;
  problemsCursor?: string;
  problemsDirection?: "previous";
}

/** Only non-default values are written to the URL. An absent or hand-edited
 * value reads as the default tab and workspace scope. */
export function readEventsSearch(raw: unknown): EventsSearch {
  const tabValue = textParam(raw, "tab");
  const tab = tabValue === "subscriptions" ? tabValue : ["logs", "problems", "receipts"].includes(tabValue ?? "") ? "logs" : undefined;
  const scope = textParam(raw, "scope") === "all" ? "all" : undefined;
  const problemsQ = textParam(raw, "problemsQ");
  const problemsCursor = textParam(raw, "problemsCursor");
  const problemsDirection = textParam(raw, "problemsDirection") === "previous" ? "previous" as const : undefined;
  const review = textParam(raw, "review");
  return { ...(review ? { review } : {}), ...(tab ? { tab } : {}), ...(scope ? { scope } : {}), ...(problemsQ ? { problemsQ } : {}), ...(problemsCursor ? { problemsCursor } : {}), ...(problemsDirection ? { problemsDirection } : {}) };
}

export const Route = createFileRoute("/events/")({
  component: EventsPage,
  validateSearch: readEventsSearch,
});

const TABS_LABEL = "Events sections";
const TABS = [
  { id: "activity", label: "Activity" },
  { id: "subscriptions", label: "Subscriptions" },
  { id: "logs", label: "Event Logs" },
] as const;

export function EventsPage() {
  // The top-level hooks, not `Route.useSearch()`: the route suite mocks
  // this module and never builds a real router context.
  const search = readEventsSearch(useSearch({ strict: false }));
  const navigate = useNavigate();
  const me = useMe();
  const isAdmin = !me.error && me.data?.orgRole === "admin";
  const [selectedTab, setTab] = useState<TabId>(search.tab ?? "activity");
  const tab = selectedTab;
  const tabs = TABS;
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

          {tab === "subscriptions" && <SubscriptionsPanel reviewId={search.review} onReviewClose={() => void navigate({ to: "/events", search: { tab: "subscriptions" } })} />}
          {tab === "logs" && (
            <div className="space-y-8">
            <section aria-label="Rejections and failures">
            <h2 className="mb-2 text-base font-medium">Rejections and failures</h2>
            <DropsPanel
              query={search.problemsQ}
              cursor={search.problemsCursor}
              direction={search.problemsDirection}
              onQueryChange={(problemsQ) => {
                problemsQ = problemsQ.trim() ? problemsQ : "";
                void navigate({ to: "/events", search: { tab: "logs", ...(scope === "all" ? { scope: "all" as const } : {}), ...(problemsQ ? { problemsQ } : {}) } });
              }}
              onPrevious={(problemsCursor) => void navigate({ to: "/events", search: { tab: "logs", ...(scope === "all" ? { scope: "all" as const } : {}), ...(search.problemsQ ? { problemsQ: search.problemsQ } : {}), ...(problemsCursor ? { problemsCursor, problemsDirection: "previous" as const } : {}) } })}
              onNext={(problemsCursor) => void navigate({ to: "/events", search: { tab: "logs", ...(scope === "all" ? { scope: "all" as const } : {}), ...(search.problemsQ ? { problemsQ: search.problemsQ } : {}), problemsCursor } })}
            />
            </section>
            {isAdmin && <section aria-label="Incoming events"><h2 className="mb-2 text-base font-medium">Incoming events</h2><ReceiptsPanel key={me.data?.orgId} /></section>}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
