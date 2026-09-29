import { useState } from "react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import type { WorkflowRunDetail } from "@valet/api/wire";
import { useCancelRun, useRetryRun, useRunDetail } from "~/api/workflows";
import { useAdoptWorkspaceScope } from "~/lib/workspace-scope";
import { ApprovalCard } from "~/components/workflows/approval-card";
import { CheckpointList } from "~/components/workflows/checkpoint-list";
import { PolicyGateCard } from "~/components/workflows/policy-gate-card";
import {
  deriveRunResult,
  findApprovalPrompt,
  findPendingApproval,
  formatRunDuration,
  runNeedsApproval,
  statusByNodeId,
} from "~/components/workflows/run-detail-helpers";
import { RunResultPanel } from "~/components/workflows/run-detail-result";
import { isWorkflowDefinitionShape } from "~/components/workflows/editor-model";
import { WorkflowPreview } from "~/components/workflows/preview";
import { Button, ConfirmDialog, Spinner } from "~/components/primitives";
import { RunStatusChip } from "~/components/workflows/run-status-chip";
import { formatWhen } from "~/lib/format-when";

/**
 * `/workflows/runs/$runId` — the settled run's result first, then the canvas,
 * pending-gate cards and the checkpoint list, with a status header and Cancel
 * button (plan decision 19). Polls every 5s via `useRunDetail` (stops once
 * `run.status === 'settled'`).
 */
export const Route = createFileRoute("/workflows/runs/$runId")({
  component: RunDetailPage,
});

function RunDetailPage() {
  const { runId } = Route.useParams();
  const { data, isLoading, error } = useRunDetail(runId);
  // Arriving from a run notification for a team's run: move the switcher to
  // the run's workspace so the nav matches the page instead of showing
  // Personal. `data` is undefined while loading; adoption waits for it.
  useAdoptWorkspaceScope(data?.owner);
  const cancelRun = useCancelRun(runId);
  const retryRun = useRetryRun(runId);
  const navigate = useNavigate();

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center gap-2 p-6 text-sm text-muted">
        <Spinner size={14} /> Loading run…
      </div>
    );
  }
  if (error || !data) {
    return <div className="flex-1 p-6 text-sm text-danger-500">Failed to load run.</div>;
  }

  return (
    <div className="min-w-0 flex-1 flex flex-col min-h-0">
      <div className="px-4 py-4 sm:px-6 border-b border-line">
        <Link to="/workflows" className="inline-flex min-h-11 items-center text-xs text-muted hover:text-ink sm:min-h-0">
          ← Workflows
        </Link>
      </div>
      <RunDetailBody
        runId={runId}
        data={data}
        onCancel={() => cancelRun.mutate()}
        cancelPending={cancelRun.isPending}
        onRetry={() =>
          retryRun.mutate(undefined, {
            onSuccess: ({ runId: newRunId }) =>
              navigate({ to: "/workflows/runs/$runId", params: { runId: newRunId } }),
          })
        }
        retryPending={retryRun.isPending}
      />
    </div>
  );
}

export interface RunDetailBodyProps {
  runId: string;
  data: WorkflowRunDetail;
  onCancel: () => void;
  cancelPending: boolean;
  onRetry: () => void;
  retryPending: boolean;
}

/**
 * Props-driven body (result panel + status bar + gate cards + checkpoint
 * list), split out from `RunDetailPage` so it's testable without router/query
 * wiring — the router `<Link>` above is the only thing that needs real router
 * context, and it's kept out of this component.
 */
export function RunDetailBody({
  runId,
  data,
  onCancel,
  cancelPending,
  onRetry,
  retryPending,
}: RunDetailBodyProps) {
  // Cancel stops a run part-way and cannot be undone, so it asks first.
  const [cancelOpen, setCancelOpen] = useState(false);
  const { run, checkpoints } = data;
  const pendingGates = data.pendingGates ?? [];
  const needsApproval = runNeedsApproval(run, pendingGates);
  const nonTerminal = run.status !== "settled";
  const retryable =
    run.status === "settled" && (run.outcome === "failed" || run.outcome === "cancelled");
  const nodeStatuses = statusByNodeId(run, checkpoints);
  // The answer the person came for. Present only once the run has settled.
  const result = deriveRunResult(run, checkpoints);
  const duration = formatRunDuration(run.createdAt, run.updatedAt);

  // Legacy signal-based approval: still resolve the prompt for approval-kind
  // gates that come via the old waitingOn path (fallback for older runs).
  const legacyPending =
    run.status === "parked" && pendingGates.length === 0
      ? findPendingApproval(run.waitingOn)
      : undefined;
  const legacyPrompt = legacyPending
    ? findApprovalPrompt(run.definition, legacyPending.nodeId)
    : undefined;

  return (
    <>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-4 sm:px-6 border-b border-line">
        {/* A run id has no length bound. A flex item defaults to
            `min-width: auto`, so without `min-w-0` the heading refuses to
            shrink and pushes the status chip and the run controls off the
            row. */}
        <h1 className="min-w-0 break-all text-lg sm:truncate font-semibold tracking-tight text-ink font-display">
          {run.runId}
        </h1>
        <div className="flex max-w-full flex-wrap items-center gap-2">
          <RunStatusChip
            status={run.status}
            outcome={run.outcome}
            needsApproval={needsApproval}
          />
          {nonTerminal && (
            <Button
              size="sm"
              variant="danger"
              onClick={() => setCancelOpen(true)}
              disabled={cancelPending}
            >
              {cancelPending ? "Cancelling…" : "Cancel run"}
            </Button>
          )}
          {retryable && (
            <Button size="sm" onClick={onRetry} disabled={retryPending}>
              {retryPending ? "Retrying…" : "Retry run"}
            </Button>
          )}
        </div>
      </div>

      {/* Tied to `nonTerminal` so a run that settles while the dialog is open
          takes the dialog with it — a confirm on a settled run does nothing. */}
      <ConfirmDialog
        open={cancelOpen && nonTerminal}
        onOpenChange={setCancelOpen}
        title="Cancel this run?"
        description="The run stops at the step it reached and cannot continue. To run the workflow again, select Retry run."
        confirmLabel="Cancel run"
        onConfirm={() => {
          setCancelOpen(false);
          onCancel();
        }}
      />

      <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6 space-y-4">
        {/* The settled answer comes first. Everything below it explains how
            the run reached that answer. */}
        {result && <RunResultPanel result={result} />}

        {/* Timings stay on one quiet line: they matter when a run is slow,
            and never more than the result itself. */}
        <p className="text-xs text-muted">
          Started {formatWhen(run.createdAt)}
          {/* `updatedAt` is the last write, not the current time. It gives a
              true duration only after the run stops writing. */}
          {run.status === "settled" && duration && ` · Ran for ${duration}`}
          {` · ${checkpoints.length} ${checkpoints.length === 1 ? "checkpoint" : "checkpoints"}`}
        </p>

        {isWorkflowDefinitionShape(run.definition) && (
          <WorkflowPreview
            definition={run.definition}
            statusByNodeId={nodeStatuses.status}
            badgeByNodeId={nodeStatuses.badges}
            height={320}
          />
        )}

        {/* Render ALL pending gates — approval gates first, then policy gates */}
        {pendingGates.map((gate) =>
          gate.kind === "approval" ? (
            <ApprovalCard
              key={gate.nodeId}
              runId={runId}
              nodeId={gate.nodeId}
              prompt={gate.prompt ?? findApprovalPrompt(run.definition, gate.nodeId)}
              summary={gate.summary}
              details={gate.details}
              iteration={gate.iteration}
            />
          ) : (
            <PolicyGateCard key={`${gate.nodeId}:${gate.iteration ?? 0}`} runId={runId} gate={gate} />
          ),
        )}

        {/* Legacy fallback for runs that predate pendingGates */}
        {legacyPending && (
          <ApprovalCard runId={runId} nodeId={legacyPending.nodeId} prompt={legacyPrompt} />
        )}

        <div>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted">
            Checkpoints
          </h2>
          <CheckpointList checkpoints={checkpoints} promotedNodeId={result?.nodeId} />
        </div>
      </div>
    </>
  );
}

