import { useState } from "react";
import { Bell, X } from "lucide-react";
import type { NotificationSummary } from "@valet/api/wire";
import { useMarkAllNotificationsRead, useMarkNotificationRead, useNotifications, useNotificationDecisions } from "~/api/queries";
import { useWorkflowActionRequired } from "~/api/workflows";
import { Badge, Button, Popover, PopoverContent, PopoverTrigger } from "~/components/primitives";
import { WorkflowApprovalItem } from "~/components/workflows/workflow-approval-item";
import { DecisionGateCard } from "~/components/session/decision-gate-card";
import { attentionSessionIds, isActionable } from "~/lib/use-attention-ping";
import { relativeTime } from "~/lib/relative-time";

export interface BellState {
  unreadCount: number;
  needsAttention: boolean;
}

/** Derive bell state from the poll and the live gate store. */
export function deriveBellState(
  notifications: NotificationSummary[] | undefined,
  livePendingGates: Readonly<Record<string, boolean>>,
): BellState {
  const items = notifications ?? [];
  const hasUnscopedAction = items.some((n) => isActionable(n) && n.sessionId === undefined);
  return {
    unreadCount: items.filter((n) => n.readAt === undefined).length,
    needsAttention: hasUnscopedAction || attentionSessionIds(items, livePendingGates).size > 0,
  };
}

/** Keep actionable notifications above general updates without changing recency within either group. */
export function sortNotifications(notifications: readonly NotificationSummary[]): NotificationSummary[] {
  return [...notifications].sort((a, b) => Number(isActionable(b)) - Number(isActionable(a)));
}

/**
 * Pure `onOpenChange` handler, extracted so the open-refetch behavior is
 * unit-testable without rendering the Radix dropdown.
 */
export function makeOpenChangeHandler(refetch: () => void): (open: boolean) => void {
  return (open) => {
    if (open) refetch();
  };
}

export function NotificationsBell() {
  const [open, setOpen] = useState(false);
  const notifications = useNotifications();
  const workflows = useWorkflowActionRequired();
  const decisions = useNotificationDecisions();
  const markRead = useMarkNotificationRead();
  const markAllRead = useMarkAllNotificationsRead();
  const pendingCount = (workflows.data?.count ?? 0) + (decisions.data?.items.length ?? 0);
  // Approval state comes from gates. Historical notification copies do not create another inbox item.
  const updates = (notifications.data?.notifications ?? []).filter(n => n.kind !== "approval");
  const unread = updates.filter(n => n.readAt === undefined).length;
  const loading = workflows.isLoading || decisions.isLoading;
  const failed = workflows.isError || decisions.isError;
  function changeOpen(value: boolean) {
    setOpen(value);
    if (value) { void notifications.refetch(); void workflows.refetch(); void decisions.refetch(); }
  }
  async function openUpdate(n: NotificationSummary) {
    try { if (!n.readAt) await markRead.mutateAsync(n.id); }
    finally { if (n.href) window.location.assign(n.href); }
  }
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="sm" className="relative px-2" aria-label={pendingCount ? `Notifications: ${pendingCount} pending approvals` : "Notifications"}>
          <Bell className={`h-4 w-4 ${pendingCount ? "text-warning-fg" : ""}`} aria-hidden />
          {pendingCount > 0 ? <Badge variant="warning" className="absolute -right-1 -top-1 px-1 py-0 text-[10px]">{pendingCount}</Badge>
            : unread > 0 && <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-accent-500" />}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Notifications" className="w-[520px] max-h-[min(720px,calc(100dvh-6rem))] bg-paper p-0">
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-paper px-4 py-3">
          <h2 className="font-semibold">Notifications</h2>
          <Button variant="ghost" size="sm" aria-label="Close notifications" onClick={() => setOpen(false)}><X className="h-4 w-4" /></Button>
        </div>
        <section aria-label="Needs action" className="space-y-3 p-4">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Needs action</h3><Badge variant={pendingCount ? "warning" : "neutral"}>{pendingCount}</Badge></div>
          {loading && <p className="text-sm text-muted">Loading approvals…</p>}
          {failed && <div role="alert" className="text-sm text-danger-500">Could not load all approvals. <button className="underline" onClick={() => { void workflows.refetch(); void decisions.refetch(); }}>Retry</button></div>}
          {!loading && !failed && pendingCount === 0 && <p className="text-sm text-muted">You're all caught up. No decisions are waiting.</p>}
          <ul className="space-y-3">{workflows.data?.items.map(item => <WorkflowApprovalItem key={item.id} item={item} />)}</ul>
          {decisions.data?.items.map(item => <div key={item.gate.id} className="rounded-lg border border-line pb-3">
            <div className="px-3 pt-3 text-sm font-medium">{item.title}</div>
            <DecisionGateCard sessionId={item.sessionId} gate={item.gate} />
            <a className="ml-3 mt-2 inline-block text-xs text-muted underline" href={`/sessions/${encodeURIComponent(item.sessionId)}?thread=${encodeURIComponent(item.gate.threadId)}`}>Open thread</a>
          </div>)}
        </section>
        <section aria-label="Updates" className="border-t border-line p-4 space-y-3">
          <div className="flex items-center justify-between"><h3 className="text-xs font-semibold uppercase tracking-wide text-muted">Updates</h3>
            {unread > 0 && <button className="text-xs text-muted underline" onClick={() => markAllRead.mutate()}>Mark all read</button>}
          </div>
          {notifications.isError && <p role="alert" className="text-sm text-danger-500">Could not load updates. <button className="underline" onClick={() => void notifications.refetch()}>Retry</button></p>}
          {updates.length === 0 && <p className="text-sm text-muted">No updates yet.</p>}
          {updates.map(n => <button key={n.id} onClick={() => void openUpdate(n)} className="block w-full rounded-md p-2 text-left hover:bg-ink-wash">
            <span className="flex items-center gap-2">{!n.readAt && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent-500" />}<span className="text-sm font-medium">{n.title}</span></span>
            <span className="text-xs text-muted">{relativeTime(n.createdAt)}</span>
          </button>)}
        </section>
      </PopoverContent>
    </Popover>
  );
}
