import { useEffect, useState } from "react";
import { Link } from "@tanstack/react-router";
import type { ActionLogEntryWire, ApprovalModeWire } from "@valet/api/wire";
import { Badge, Button, Input } from "~/components/primitives";
import { Section } from "~/components/settings/section";
import { useActionLog } from "~/api/policies";

const MODE_BADGE: Record<ApprovalModeWire, "success" | "accent" | "danger"> = {
  allow: "success",
  require_approval: "accent",
  deny: "danger",
};

const RESOLVED_MODES: readonly ApprovalModeWire[] = ["allow", "require_approval", "deny"];
const STATUSES = ["pending", "allowed", "denied", "approved", "rejected", "error", "completed", "cancelled", "timeout"] as const;

type ActionLogStatus = (typeof STATUSES)[number];

/** The filter set the page keeps in its search params. */
export interface ActionLogSearch {
  service?: string;
  resolvedMode?: ApprovalModeWire;
  status?: ActionLogStatus;
}

/**
 * Reads the filters out of raw search params. An unknown mode or status
 * becomes `undefined`, so a hand-edited URL shows every row instead of an
 * empty page that gives no reason.
 */
export function parseActionLogSearch(search: Record<string, unknown>): ActionLogSearch {
  const service = typeof search.service === "string" ? search.service.trim() : "";
  const mode = typeof search.resolvedMode === "string" ? search.resolvedMode : undefined;
  const status = typeof search.status === "string" ? search.status : undefined;
  return {
    service: service || undefined,
    resolvedMode: RESOLVED_MODES.find((m) => m === mode),
    status: STATUSES.find((s) => s === status),
  };
}

/**
 * Organization · Action log (action-policies plan, Task 5). Keyset-paginated
 * read over `/api/org/action-log` — a forward-only Next/Previous pager over
 * a client-side cursor stack (no infinite-scroll accumulation, so filter
 * changes reset cleanly to page one). `resolvedMode` is the policy DECISION;
 * `status` is the execution outcome — both are shown, never conflated (see
 * `ActionLogEntryWire`'s doc comment).
 *
 * The applied filters come from the route's search params, so a filtered
 * view survives a reload and can be sent to another admin. The three
 * controls hold a draft until Apply, which reports the new filter set up to
 * the route to write into the URL.
 */
export function ActionLogSection({
  filters,
  onFiltersChange,
}: {
  filters: ActionLogSearch;
  onFiltersChange: (next: ActionLogSearch) => void;
}) {
  const [draftService, setDraftService] = useState<string>(filters.service ?? "");
  const [draftResolvedMode, setDraftResolvedMode] = useState<string>(filters.resolvedMode ?? "");
  const [draftStatus, setDraftStatus] = useState<string>(filters.status ?? "");
  const [cursorHistory, setCursorHistory] = useState<Array<string | undefined>>([undefined]);
  const [expanded, setExpanded] = useState<string | null>(null);

  const { service, resolvedMode, status } = filters;

  // The URL owns the applied filters. If it changes from outside — Back,
  // Forward, or a pasted link — the controls and the pager must follow it.
  // The dependencies are the filter values, not the object, so a new object
  // with the same filters does not re-run this.
  useEffect(() => {
    setDraftService(service ?? "");
    setDraftResolvedMode(resolvedMode ?? "");
    setDraftStatus(status ?? "");
    setCursorHistory([undefined]);
  }, [service, resolvedMode, status]);

  const cursor = cursorHistory[cursorHistory.length - 1];
  const logQ = useActionLog(filters, cursor);
  const entries = logQ.data?.entries ?? [];

  function applyFilters() {
    // Apply also resets the pager here, not only in the effect above: the
    // same filters re-applied leave the URL unchanged.
    setCursorHistory([undefined]);
    onFiltersChange({
      service: draftService.trim() || undefined,
      resolvedMode: RESOLVED_MODES.find((m) => m === draftResolvedMode),
      status: STATUSES.find((s) => s === draftStatus),
    });
  }

  function nextPage() {
    if (logQ.data?.nextCursor) {
      setCursorHistory([...cursorHistory, logQ.data.nextCursor]);
    }
  }

  function prevPage() {
    if (cursorHistory.length > 1) {
      setCursorHistory(cursorHistory.slice(0, -1));
    }
  }

  return (
    <Section title="Action log" description="Every action invocation, with the policy decision that gated it.">
      <div className="flex flex-col items-stretch gap-3 py-4 sm:flex-row sm:flex-wrap sm:items-end">
        <div>
          <label className="block text-xs font-medium text-muted" htmlFor="log-filter-service">
            Service
          </label>
          <Input
            id="log-filter-service"
            value={draftService}
            onChange={(e) => setDraftService(e.target.value)}
            className="mt-1 w-full sm:w-40"
          />
        </div>
        <div>
          <label className="block text-xs font-medium text-muted" htmlFor="log-filter-mode">
            Resolved mode
          </label>
          <select
            id="log-filter-mode"
            value={draftResolvedMode}
            onChange={(e) => setDraftResolvedMode(e.target.value)}
            className="mt-1 h-12 w-full rounded border border-[--border] bg-[--bg] px-2 text-base sm:h-9 sm:w-auto sm:text-sm text-[--fg]"
          >
            <option value="">Any</option>
            {RESOLVED_MODES.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-xs font-medium text-muted" htmlFor="log-filter-status">
            Status
          </label>
          <select
            id="log-filter-status"
            value={draftStatus}
            onChange={(e) => setDraftStatus(e.target.value)}
            className="mt-1 h-12 w-full rounded border border-[--border] bg-[--bg] px-2 text-base sm:h-9 sm:w-auto sm:text-sm text-[--fg]"
          >
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <Button type="button" variant="secondary" onClick={applyFilters}>
          Apply filters
        </Button>
      </div>

      {logQ.isLoading && <p className="py-4 text-sm text-muted">Loading…</p>}
      {logQ.error && <p className="py-4 text-sm text-danger-500">Failed to load the action log.</p>}
      {!logQ.isLoading && entries.length === 0 && (
        <p className="py-4 text-sm text-muted">No invocations match these filters.</p>
      )}

      {entries.map((entry) => (
        <LogRow
          key={entry.invocationId}
          entry={entry}
          expanded={expanded === entry.invocationId}
          onToggle={() =>
            setExpanded(expanded === entry.invocationId ? null : entry.invocationId)
          }
        />
      ))}

      <div className="flex items-center justify-between py-3">
        <Button type="button" variant="ghost" size="sm" disabled={cursorHistory.length <= 1} onClick={prevPage}>
          Previous
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={!logQ.data?.nextCursor}
          onClick={nextPage}
        >
          Next
        </Button>
      </div>
    </Section>
  );
}

function LogRow({
  entry,
  expanded,
  onToggle,
}: {
  entry: ActionLogEntryWire;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="py-3">
      {/* The provenance links are siblings of the toggle, not children of
          it. A link inside a button is invalid HTML. Nested, one click both
          navigates and expands the row, and assistive technology reports the
          two controls as one. */}
      <div className="flex w-full flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          aria-label={`Toggle details for ${entry.invocationId}`}
          className="flex min-h-11 min-w-0 flex-wrap items-center gap-2 text-left sm:min-h-0"
        >
          <span className="text-xs text-muted">{new Date(entry.createdAt).toLocaleString()}</span>
          <span className="min-w-0 break-all text-sm font-medium text-[--fg]">
            {entry.service ?? "—"}
            {entry.actionId ? ` / ${entry.actionId}` : ""}
          </span>
          {entry.riskLevel && <Badge variant="neutral">{entry.riskLevel}</Badge>}
          {entry.resolvedMode && (
            <Badge variant={MODE_BADGE[entry.resolvedMode]}>{entry.resolvedMode}</Badge>
          )}
          {entry.status && <span className="text-xs text-muted">status: {entry.status}</span>}
        </button>
        {entry.sessionId && (
          <Link
            to="/sessions/$sessionId"
            params={{ sessionId: entry.sessionId }}
            className="inline-flex min-h-11 items-center text-xs text-accent-600 underline sm:min-h-0"
          >
            runtime
          </Link>
        )}
        {entry.workflowExecutionId && (
          <Link
            to="/workflows/runs/$runId"
            params={{ runId: entry.workflowExecutionId }}
            className="inline-flex min-h-11 items-center text-xs text-accent-600 underline sm:min-h-0"
          >
            workflow run
          </Link>
        )}
      </div>
      {expanded && (
        <div className="mt-2 space-y-2 rounded bg-neutral-50 p-3 text-xs dark:bg-neutral-900">
          <div>
            <span className="font-medium text-muted">Params</span>
            <pre className="mt-1 whitespace-pre-wrap break-words">
              {JSON.stringify(entry.params, null, 2)}
              {entry.paramsTruncated ? "\n…truncated" : ""}
            </pre>
          </div>
          <div>
            <span className="font-medium text-muted">Result</span>
            <pre className="mt-1 whitespace-pre-wrap break-words">
              {JSON.stringify(entry.result, null, 2)}
              {entry.resultTruncated ? "\n…truncated" : ""}
            </pre>
          </div>
          {entry.error && (
            <div>
              <span className="font-medium text-muted">Error</span>
              <p className="mt-1 whitespace-pre-wrap break-words">{entry.error}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
