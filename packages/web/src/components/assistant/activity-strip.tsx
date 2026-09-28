import type { NotificationSummary, ChildWorkSummary } from "@valet/api/wire";
import { Spinner } from "~/components/primitives";
import { relativeTime } from "~/lib/relative-time";
import { cn } from "~/lib/cn";

const ACTIVITY_LIMIT = 8;

export interface ActivityEvent {
  id: string;
  kind: "notification" | "child.settled";
  title: string;
  href: string;
  createdAt: number;
}

/**
 * Merges notifications + settled children into one timeline, newest first,
 * top 8 (decision 16). Pure so the merge/sort/cap logic is testable
 * without mounting queries. Child rows deep-link to `/chat` — settled
 * children live in the assistant's thread tree there, not on a standalone
 * session route.
 *
 * Child `createdAt` is the watch's spawn time, not its settlement time —
 * `child_watches` carries no separate settled-at column (see decision 6's
 * note on `outcome`). Using it as the sort key is an approximation until
 * that's added; acceptable for this pass since children settle quickly
 * relative to dashboard polling.
 */
export function mergeActivity(
  notifications: NotificationSummary[],
  children: ChildWorkSummary[],
  limit = ACTIVITY_LIMIT,
): ActivityEvent[] {
  const fromNotifications: ActivityEvent[] = notifications.map((n) => ({
    id: `notification:${n.id}`,
    kind: "notification",
    title: n.title,
    href: n.href ?? "#",
    createdAt: n.createdAt,
  }));

  const fromChildren: ActivityEvent[] = children
    .filter((c) => c.status === "settled")
    .map((c) => ({
      id: `child:${c.sessionId}`,
      kind: "child.settled",
      title: `${c.title} settled`,
      href: "/chat",
      createdAt: c.createdAt,
    }));

  return [...fromNotifications, ...fromChildren]
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

export function ActivityStrip({
  events,
  loading,
  error,
  onRetry,
}: {
  events: ActivityEvent[];
  loading?: boolean;
  error?: boolean;
  onRetry?: () => void;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-paper">
      <header className="px-4 py-3 border-b border-line">
        <h2 className="font-display text-base text-ink">Activity</h2>
      </header>
      <div className="px-4 py-3">
        {loading && (
          <div className="flex items-center gap-2 text-xs text-muted">
            <Spinner size={14} /> Loading…
          </div>
        )}
        {error && (
          <div className="text-xs text-danger-500">
            Couldn't load activity.{" "}
            {onRetry && (
              <button type="button" className="min-h-11 px-2 underline sm:min-h-0" onClick={onRetry}>
                Retry
              </button>
            )}
          </div>
        )}
        {!loading && !error && events.length === 0 && (
          <p className="text-sm text-muted">Nothing yet — activity shows up here as it happens.</p>
        )}
        {events.length > 0 && (
          <ul className="divide-y divide-line">
            {events.map((e) => (
              <li key={e.id}>
                <a
                  href={e.href}
                  className="flex min-h-11 flex-wrap items-center justify-between gap-x-3 gap-y-1 sm:flex-nowrap py-2 text-sm hover:text-moss"
                >
                  <span className="flex min-w-0 max-w-full items-center gap-2">
                    <span
                      className={cn(
                        "h-1.5 w-1.5 shrink-0 rounded-full",
                        e.kind === "child.settled" ? "bg-moss" : "bg-amber",
                      )}
                      aria-hidden
                    />
                    <span className="min-w-0 break-words text-ink sm:truncate">{e.title}</span>
                  </span>
                  <span className="shrink-0 text-xs text-muted">{relativeTime(e.createdAt)}</span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
