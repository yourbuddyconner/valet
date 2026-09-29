import { useState } from "react";
import { Clock, Pencil, Play, Trash2, Zap } from "lucide-react";
import type { WorkflowTriggerItem } from "@valet/api/wire";
import {
  useDeleteEventTrigger,
  useDeleteSchedule,
  useRunScheduleNow,
  useUpdateEventTrigger,
  useUpdateSchedule,
  useWorkflowTriggers,
  useWorkflows,
} from "~/api/workflows";
import type { OwnerFilter } from "~/api/client";
import { Button, ConfirmDialog, Spinner, Switch } from "~/components/primitives";
import { TriggerDialog } from "./trigger-dialog";

/** Relative "in 2h" formatting for next fire times. */
function relativeTime(ms: number): string {
  const delta = ms - Date.now();
  if (delta <= 0) return "due now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `in ${hours}h`;
  return `in ${Math.round(hours / 24)}d`;
}

function triggerSummary(t: WorkflowTriggerItem): string {
  if (t.kind === "schedule") {
    const next = t.enabled ? ` · next ${relativeTime(t.detail.nextFireAt)}` : "";
    const target = t.detail.targetKind === "orchestrator" ? " · orchestrator" : "";
    return `${t.detail.cron} (${t.detail.timezone})${target}${next}`;
  }
  return t.detail.eventKeys.join(", ");
}

export function TriggerList({
  workflowId,
  owner,
  schedulesOnly = false,
}: {
  workflowId?: string;
  /** Scopes the flat hub list to one workspace. Unset per-workflow, where
   * `workflowId` already narrows the list. */
  owner?: OwnerFilter;
  schedulesOnly?: boolean;
}) {
  const { data, isLoading, error } = useWorkflowTriggers(workflowId, owner);
  const workflowsQ = useWorkflows(owner);
  const updateSchedule = useUpdateSchedule();
  const updateEvent = useUpdateEventTrigger();
  const deleteSchedule = useDeleteSchedule();
  const deleteEvent = useDeleteEventTrigger();
  const runNow = useRunScheduleNow();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<WorkflowTriggerItem | undefined>(undefined);
  const [actionError, setActionError] = useState<string | null>(null);
  // Delete asks first, and keeps its own error: the shared `actionError`
  // line renders behind the dialog, where the person who pressed Delete
  // cannot read it.
  const [removing, setRemoving] = useState<WorkflowTriggerItem | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const nameById = new Map(
    (workflowsQ.data?.workflows ?? []).map((w) => [w.id, w.name]),
  );
  const triggers = (data?.triggers ?? []).filter((trigger) => !schedulesOnly || trigger.kind === "schedule");

  async function guarded(fn: () => Promise<unknown>) {
    setActionError(null);
    try {
      await fn();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : "Request failed.");
    }
  }

  function toggle(t: WorkflowTriggerItem) {
    const body = { enabled: !t.enabled };
    void guarded(() =>
      t.kind === "schedule"
        ? updateSchedule.mutateAsync({ id: t.id, body })
        : updateEvent.mutateAsync({ id: t.id, body }),
    );
  }

  async function confirmRemove() {
    if (!removing) return;
    setRemoveError(null);
    try {
      await (removing.kind === "schedule"
        ? deleteSchedule.mutateAsync(removing.id)
        : deleteEvent.mutateAsync(removing.id));
      setRemoving(null);
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-ink">{schedulesOnly ? "Scheduled" : "Triggers"}</span>
        <Button
          size="sm"
          onClick={() => {
            setEditing(undefined);
            setDialogOpen(true);
          }}
        >
          {schedulesOnly ? "New schedule" : "New trigger"}
        </Button>
      </div>

      {actionError && <div className="text-xs text-danger-500">{actionError}</div>}
      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted">
          <Spinner size={14} /> Loading {schedulesOnly ? "schedules" : "triggers"}…
        </div>
      )}
      {!isLoading && error && (
        <div className="text-sm text-danger-500">Failed to load {schedulesOnly ? "schedules" : "triggers"}.</div>
      )}
      {!isLoading && !error && triggers.length === 0 && (
        <div className="text-sm text-muted">
          {schedulesOnly ? "No schedules yet. Create one to run a workflow on a schedule." : workflowId
            ? "No triggers yet. Create one to run this on a schedule or on an event."
            : "No triggers yet. Create one to run a workflow on a schedule or on an event."}
        </div>
      )}

      <ul className="space-y-2">
        {triggers.map((t) => (
          <li
            key={`${t.kind}:${t.id}`}
            className="flex flex-wrap items-center gap-3 rounded sm:flex-nowrap border border-line bg-paper px-4 py-3"
          >
            {t.kind === "schedule" ? (
              <Clock className="h-4 w-4 shrink-0 text-muted" aria-label="schedule trigger" />
            ) : (
              <Zap className="h-4 w-4 shrink-0 text-muted" aria-label="event trigger" />
            )}
            <div className="min-w-0 basis-4/5 grow sm:basis-auto">
              <div className="break-words text-sm sm:truncate font-medium text-ink">{t.name}</div>
              <div className="break-words text-xs sm:truncate text-muted">
                {triggerSummary(t)}
                {!workflowId && t.workflowId && ` · ${nameById.get(t.workflowId) ?? t.workflowId}`}
              </div>
            </div>
            <div className="flex max-w-full flex-wrap items-center gap-2">
              {t.kind === "schedule" && (
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label={`Run now: ${t.name}`}
                  onClick={() => void guarded(() => runNow.mutateAsync(t.id))}
                  disabled={runNow.isPending}
                >
                  <Play className="h-4 w-4" />
                </Button>
              )}
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Edit ${t.name}`}
                onClick={() => {
                  setEditing(t);
                  setDialogOpen(true);
                }}
              >
                <Pencil className="h-4 w-4" />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Delete ${t.name}`}
                onClick={() => {
                  setRemoveError(null);
                  setRemoving(t);
                }}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
              <Switch
                checked={t.enabled}
                onCheckedChange={() => toggle(t)}
                aria-label={`${t.enabled ? "Disable" : "Enable"} ${t.name}`}
              />
            </div>
          </li>
        ))}
      </ul>

      {removing && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setRemoving(null);
          }}
          title={`Delete trigger "${removing.name}"?`}
          description={
            removing.kind === "schedule"
              ? "The schedule stops firing. Runs it already started are kept."
              : "These events no longer start a run. Runs already started are kept."
          }
          confirmLabel="Delete trigger"
          pendingLabel="Deleting…"
          pending={deleteSchedule.isPending || deleteEvent.isPending}
          error={removeError}
          onConfirm={() => void confirmRemove()}
        />
      )}

      <TriggerDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        workflowId={workflowId}
        editing={editing}
        schedulesOnly={schedulesOnly}
      />
    </div>
  );
}
