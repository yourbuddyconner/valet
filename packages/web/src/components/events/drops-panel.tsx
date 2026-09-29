/** Recorded event problems. Some classifier rejections are not recorded,
 * so an empty log does not establish that every provider event was handled. */
import { useEventDrops } from "~/api/events";
import { Button, EmptyRow, ErrorRow, LoadingRow } from "~/components/primitives";
import { SearchInput } from "~/components/search-input";
import { relativeTime } from "~/lib/relative-time";

/** Human labels for the reasons ingest and the webhook routes record. An
 * unknown reason falls back to its raw string rather than hiding. */
const REASON_LABEL: Record<string, string> = {
  slack_classifier_rejected: "Classification rejected",
  no_subscription_match: "No subscription",
  filter_excluded: "Filtered out",
  bad_signature: "Bad signature",
  foreign_workspace: "Wrong workspace",
  unknown_org: "Not connected",
  transport_unavailable: "Transport down",
  slack_retry: "Slow response",
  slack_interaction_unmatched: "Slack form did not start a workflow",
  unlinked_sender: "Unlinked sender",
};

function problemStage(reason: string): string {
  if (reason === "slack_classifier_rejected" || reason === "slack_interaction_unmatched") return "Classification";
  if (reason === "filter_excluded") return "Subscription filter";
  if (reason === "no_subscription_match") return "Subscription match";
  if (reason.startsWith("workflow_")) return "Workflow routing";
  if (["bad_signature", "foreign_workspace", "unknown_org", "slack_retry"].includes(reason)) return "Receipt and verification";
  return "Delivery and authorization";
}

export function DropsPanel({
  query = "",
  cursor,
  direction,
  onQueryChange,
  onPrevious,
  onNext,
}: {
  query?: string;
  cursor?: string;
  direction?: "previous";
  onQueryChange?: (query: string) => void;
  onPrevious?: (cursor: string) => void;
  onNext?: (cursor: string) => void;
}) {
  const searchTooLong = query.length > 200;
  const dropsQ = useEventDrops(
    { q: query, cursor, direction },
    { enabled: !searchTooLong },
  );

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        Why events were rejected, filtered out, or could not be delivered. Some failures happen before an incoming event is recorded.
      </p>

      {dropsQ.data && (
        <p className="text-xs text-muted">
          {dropsQ.data.lastEventAt !== null
            ? `Last recorded event or diagnostic ${relativeTime(dropsQ.data.lastEventAt)}.`
            : "No event receipt is recorded yet. Check the integration's delivery logs if a message is missing."}
        </p>
      )}

      <SearchInput
        value={query}
        onSettled={(next) => onQueryChange?.(next)}
        placeholder="Search rejections and failures"
        aria-label="Search rejections and failures"
        maxLength={200}
      />

      {searchTooLong && (
        <ErrorRow>Search is too long. Shorten the search to 200 characters or fewer.</ErrorRow>
      )}
      {!searchTooLong && dropsQ.isPending && <LoadingRow label="Loading rejections…" />}
      {dropsQ.error != null && !searchTooLong && (
        <ErrorRow>
          {cursor ? <><span>That page is no longer available. </span><button type="button" className="underline" onClick={() => onPrevious?.("")}>Return to the first page</button></> : "Failed to load. Reload the page and try again."}
        </ErrorRow>
      )}
      {dropsQ.data && dropsQ.data.drops.length === 0 && (
        <EmptyRow>
          {query ? "No rejections match this search." : "No recorded problems in this window. If a workflow did not run, check its subscription and the integration's delivery logs."}
        </EmptyRow>
      )}

      {dropsQ.data && dropsQ.data.drops.length > 0 && (
        <ul className="divide-y divide-line border-t border-line">
          {dropsQ.data.drops.map((drop) => <DropRow key={drop.id} drop={drop} />)}
        </ul>
      )}

      <nav className="flex gap-2" aria-label="Rejection pages">
        <Button type="button" variant="secondary" disabled={!dropsQ.data?.previousCursor} aria-busy={dropsQ.isPending} onClick={() => !dropsQ.isPending && dropsQ.data?.previousCursor && onPrevious?.(dropsQ.data.previousCursor)}>
          Previous
        </Button>
        <Button type="button" variant="secondary" disabled={!dropsQ.data?.nextCursor} aria-busy={dropsQ.isPending} onClick={() => !dropsQ.isPending && dropsQ.data?.nextCursor && onNext?.(dropsQ.data.nextCursor)}>
          Next
        </Button>
      </nav>
    </div>
  );
}

function DropRow({ drop }: { drop: { id: string; reason: string; detail: string; createdAt: number } }) {
  return <li className="flex flex-col items-start justify-between gap-2 py-4 sm:flex-row sm:gap-4">
    <div className="min-w-0 space-y-2">
      <div className="text-sm font-medium text-ink">{REASON_LABEL[drop.reason] ?? drop.reason}</div>
      <p className="break-words text-sm leading-relaxed text-muted">{drop.detail}</p>
      <span className="text-xs text-muted">{problemStage(drop.reason)} · Reference: {drop.id}</span>
    </div>
    <time dateTime={new Date(drop.createdAt).toISOString()} title={new Date(drop.createdAt).toLocaleString()} className="shrink-0 text-xs text-muted">
      {relativeTime(drop.createdAt)}
    </time>
  </li>;
}
