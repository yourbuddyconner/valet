import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import type {
  ListWorkflowActionRequiredResponse,
  WorkflowActionRequiredItem,
  WorkflowDefinitionSummary,
  WorkflowTriggerItem,
} from "@valet/api/wire";
import { triggerDataSchema, visibleTriggerFields } from "@valet/workflow";
import { Clock, ShieldAlert, Trash2, Zap } from "lucide-react";
import { useState } from "react";
import {
  useAllWorkflowRuns,
  useDeleteWorkflow,
  useStartRun,
  useWorkflowActionRequired,
  useWorkflowRuns,
  useWorkflows,
  useWorkflowTriggers,
} from "~/api/workflows";
import { OwnerBadge } from "~/components/owner-badge";
import { Pager } from "~/components/pager";
import { Button, ConfirmDialog, Spinner } from "~/components/primitives";
import { ApprovalCard } from "~/components/workflows/approval-card";
import { ImportWorkflowDialog } from "~/components/workflows/import-workflow-dialog";
import { NewWorkflowDialog } from "~/components/workflows/new-workflow-dialog";
import { PolicyGateCard } from "~/components/workflows/policy-gate-card";
import { RunStatusChip } from "~/components/workflows/run-status-chip";
import { RunWorkflowDialog } from "~/components/workflows/run-workflow-dialog";
import { TemplateGallery } from "~/components/workflows/template-gallery";
import { TriggerList } from "~/components/workflows/trigger-list";
import { WorkspaceClause } from "~/components/workspace-clause";
import { currentCursor, pageNumber, popCursor, pushCursor } from "~/lib/cursor-stack";
import { relativeTime } from "~/lib/relative-time";
import { runCountLabel } from "~/lib/run-count";
import { useListOwner } from "~/lib/use-list-owner";

/**
 * `/workflows` — tabbed hub (Workflows | Runs | Triggers | Templates). The
 * Workflows tab is the definitions list: each row's name links to
 * `/workflows/$workflowId` (the visual editor), and "New workflow" opens
 * `NewWorkflowDialog`, which POSTs the entered name plus a minimal
 * definition and navigates straight to the editor. Editing an existing
 * definition happens on its editor page, not here. Runs shows the global
 * runs feed; Triggers shows the unified `TriggerList`.
 *
 * Templates are the fourth tab — one click away, never between somebody and
 * the twenty workflows they came here to open. The gallery is mounted only
 * when its tab is shown, so the templates request is never made for a caller
 * who stays on the list. The Workflows tab shows the gallery inline when the
 * list is empty: an automation product with no starting points is the
 * hardest possible first run, so the zero state offers one instead of a
 * dead end.
 *
 * Tab state lives in the `?tab=` search param so each tab is linkable.
 */

type HubTab = "workflows" | "action-required" | "runs" | "triggers" | "templates";

export const Route = createFileRoute("/workflows/")({
  component: WorkflowsIndexPage,
  validateSearch: (search: Record<string, unknown>): { tab?: HubTab; run?: string; gate?: string } => ({
    tab:
      search.tab === "action-required" ||
      search.tab === "runs" ||
      search.tab === "triggers" ||
      search.tab === "templates"
        ? search.tab
        : undefined,
    run: typeof search.run === "string" ? search.run : undefined,
    gate: typeof search.gate === "string" ? search.gate : undefined,
  }),
});

const TABS: { id: HubTab; label: string }[] = [
  { id: "workflows", label: "Workflows" },
  { id: "action-required", label: "Needs your approval" },
  { id: "runs", label: "Runs" },
  { id: "triggers", label: "Triggers" },
  { id: "templates", label: "Templates" },
];

export function WorkflowsIndexPage() {
  // Use the top-level useSearch hook so the test mock works without
  // Route.useSearch() requiring a real router context.
  const search = useSearch({ strict: false }) as {
    tab?: HubTab;
    run?: string;
    gate?: string;
  };
  const navigate = useNavigate();
  const tab: HubTab = search.tab ?? "workflows";
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const actionRequired = useWorkflowActionRequired();

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div className="min-w-0 border-b border-line px-4 pt-4 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
            <h1 className="text-lg font-semibold tracking-tight text-ink font-display">
              Workflows
            </h1>
            <WorkspaceClause />
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Button size="sm" variant="ghost" onClick={() => setImportOpen(true)}>
              Import
            </Button>
            <Button size="sm" onClick={() => setNewOpen(true)}>
              New workflow
            </Button>
          </div>
        </div>
        <div role="tablist" className="mt-3 flex max-w-full gap-1 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={tab === t.id}
              onClick={() =>
                void navigate({
                  to: "/workflows",
                  search: t.id === "workflows" ? {} : { tab: t.id },
                })
              }
              className={`min-h-11 shrink-0 rounded-t px-2 py-1.5 sm:min-h-0 text-sm sm:px-3 border-b-2 ${
                tab === t.id
                  ? "border-ink font-medium text-ink"
                  : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {t.label}
              {t.id === "action-required" && (actionRequired.data?.count ?? 0) > 0 && (
                <span className="ml-1.5 rounded-full bg-warning-wash px-1.5 py-0.5 text-xs text-warning-fg">
                  {actionRequired.data!.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      <NewWorkflowDialog open={newOpen} onOpenChange={setNewOpen} />
      <ImportWorkflowDialog open={importOpen} onOpenChange={setImportOpen} />

      <div className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
        {tab === "workflows" && <WorkflowsTab onNew={() => setNewOpen(true)} onImport={() => setImportOpen(true)} />}
        {tab === "action-required" && (
          <ActionRequiredTab
            data={actionRequired.data}
            isLoading={actionRequired.isLoading}
            error={actionRequired.error}
            focusRun={search.run}
            focusGate={search.gate}
          />
        )}
        {tab === "runs" && <RunsTab />}
        {tab === "triggers" && <TriggersTab />}
        {tab === "templates" && <TemplateGallery />}
      </div>
    </div>
  );
}

function ActionRequiredTab({
  data,
  isLoading,
  error,
  focusRun,
  focusGate,
}: {
  data?: ListWorkflowActionRequiredResponse;
  isLoading: boolean;
  error: unknown;
  focusRun?: string;
  focusGate?: string;
}) {
  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner size={14} /> Loading approvals…
      </div>
    );
  }
  if (error) return <div className="text-sm text-danger-500">Failed to load approvals. Try again.</div>;
  if (!data || data.items.length === 0) {
    return (
      <div className="rounded border border-line bg-paper p-6 text-sm text-muted">
        No workflow runs need your approval.
      </div>
    );
  }
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">These runs are paused. The oldest request appears first.</p>
      <ul className="space-y-4">
        {data.items.map((item) => (
          <ActionRequiredRow
            key={item.id}
            item={item}
            focused={item.runId === focusRun && (!focusGate || item.gate.nodeId === focusGate)}
          />
        ))}
      </ul>
    </div>
  );
}

function ActionRequiredRow({
  item,
  focused,
}: {
  item: WorkflowActionRequiredItem;
  focused: boolean;
}) {
  const { gate } = item;
  const policy = gate.kind === "policy_gate";
  const action = policy && gate.service && gate.action ? `${gate.service}.${gate.action}` : gate.nodeId;
  const reason = policy
    ? gate.provenance === "resolver_error"
      ? "The policy check failed. Valet paused the action for a safe decision."
      : "Your tool policy requires permission before Valet can run this action."
    : (gate.prompt ?? "This workflow includes a human approval step.");
  const denyEffect = gate.onDeny === "skip" ? "skips this step" : "stops this run";
  return (
    <li
      data-testid="action-required-item"
      className={`min-w-0 rounded-lg border bg-paper p-3 sm:p-4 ${focused ? "border-warning-fg ring-2 ring-warning-fg/20" : "border-line"}`}
    >
      <div className="mb-3 flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="inline-flex items-center gap-1 rounded-full bg-warning-wash px-2 py-0.5 text-xs font-medium text-warning-fg">
              <ShieldAlert className="h-3 w-3" aria-hidden />
              {policy ? "Tool permission" : "Workflow approval"}
            </span>
            {/* The run's OWN snapshot names this assistant, so re-pinning
                the workflow while the run waits does not move the badge
                beside a permission decision. Absent means the snapshot pins
                none, and the owner's default assistant runs it. */}
            <OwnerBadge
              ownerType={item.owner.type}
              ownerId={item.owner.id}
            />
          </div>
          <Link
            to="/workflows/$workflowId"
            params={{ workflowId: item.workflowId }}
            className="block break-words text-sm font-semibold text-ink hover:underline"
          >
            {item.workflowName}
          </Link>
          <p className="break-all font-mono text-xs text-muted">Blocked step: {action}</p>
        </div>
        <div className="shrink-0 text-left text-xs text-muted sm:text-right">
          <div>Waiting {relativeTime(gate.waitingSince ?? item.runCreatedAt)}</div>
          <div>
            Started by {item.trigger.type}
            {item.trigger.triggerId ? ` (${item.trigger.triggerId})` : ""}
          </div>
          <Link
            to="/workflows/runs/$runId"
            params={{ runId: item.runId }}
            className="inline-flex min-h-11 items-center underline sm:min-h-0"
          >
            Open run
          </Link>
        </div>
      </div>
      <div className="mb-3 rounded bg-ink-wash px-3 py-2 text-xs text-ink">
        <p>{reason}</p>
        <p className="mt-1 text-muted">Approving continues the run and performs this step. Denying {denyEffect}.</p>
      </div>
      {policy ? (
        <PolicyGateCard runId={item.runId} gate={gate} confirmActions />
      ) : (
        <ApprovalCard
          runId={item.runId}
          nodeId={gate.nodeId}
          prompt={gate.prompt}
          iteration={gate.iteration}
          confirmActions
        />
      )}
    </li>
  );
}

function WorkflowsTab({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  // The nav's workspace switcher decides which workspace this list is FOR.
  // Without it the list answers with the caller's own workflows plus every
  // team's, which is a union that does not change when the switcher does —
  // so switching appeared to do nothing.
  const owner = useListOwner();
  const { data, isLoading, error } = useWorkflows(owner);
  // Scoped to the same workspace, so the per-row schedule/event badge counts
  // match the list they annotate rather than the caller's whole reach.
  const triggersQ = useWorkflowTriggers(undefined, owner);
  const workflows = data?.workflows ?? [];

  // Group triggers by workflowId for per-row badges.
  const triggersByWf = new Map<string, WorkflowTriggerItem[]>();
  for (const t of triggersQ.data?.triggers ?? []) {
    if (!t.workflowId) continue;
    const list = triggersByWf.get(t.workflowId) ?? [];
    list.push(t);
    triggersByWf.set(t.workflowId, list);
  }

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner size={14} /> Loading workflows…
      </div>
    );
  }
  if (error) {
    return <div className="text-sm text-danger-500">Failed to load workflows.</div>;
  }
  if (workflows.length === 0) {
    // The gallery is the zero state, not a pointer to another tab. A person
    // with nothing to list needs a starting point on the screen they landed
    // on.
    return (
      <div className="space-y-4">
        <p className="text-sm text-muted">
          No workflows yet. Start from a template, build one from scratch with{" "}
          <button
            type="button"
            onClick={onNew}
            className="text-ink underline underline-offset-2 hover:text-moss"
          >
            New workflow
          </button>
          , or{" "}
          <button
            type="button"
            onClick={onImport}
            className="text-ink underline underline-offset-2 hover:text-moss"
          >
            import one you already have
          </button>
          .
        </p>
        <TemplateGallery />
      </div>
    );
  }

  return (
    <ul className="space-y-2">
      {workflows.map((wf) => (
        <DefinitionRow key={wf.id} workflow={wf} triggers={triggersByWf.get(wf.id) ?? []} />
      ))}
    </ul>
  );
}

function DefinitionRow({
  workflow,
  triggers,
}: {
  workflow: WorkflowDefinitionSummary;
  triggers: WorkflowTriggerItem[];
}) {
  const startRun = useStartRun(workflow.id);
  const runsQ = useWorkflowRuns(workflow.id);
  const del = useDeleteWorkflow();
  const navigate = useNavigate();
  const runs = runsQ.data?.runs ?? [];
  const runCount = runsQ.data?.runs.length;
  const countLabel = runCountLabel(runsQ.data);
  const latestRun = runs[0];
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [runOpen, setRunOpen] = useState(false);

  // A trigger with declared, visible inputs routes through the run dialog;
  // without one — including a trigger whose only field is `hidden`, an
  // event maps that in, not a person — Run starts immediately as before
  // (no empty-dialog flash).
  const schema = visibleTriggerFields(triggerDataSchema(workflow.definition));
  const hasSchema = Object.keys(schema).length > 0;

  function goToRun(runId: string) {
    void navigate({ to: "/workflows/runs/$runId", params: { runId } });
  }

  const schedules = triggers.filter(
    (t): t is Extract<WorkflowTriggerItem, { kind: "schedule" }> => t.kind === "schedule",
  );
  const events = triggers.filter((t) => t.kind === "event");
  const scheduleCount = schedules.length;
  const eventCount = events.length;

  // Earliest next fire among enabled schedules.
  const nextFire = schedules
    .filter((t) => t.enabled)
    .map((t) => t.detail.nextFireAt)
    .reduce((min, v) => Math.min(min, v), Infinity);
  const nextFireAt = isFinite(nextFire) ? nextFire : undefined;

  async function handleRun() {
    if (hasSchema) {
      setRunOpen(true);
      return;
    }
    const result = await startRun.mutateAsync();
    goToRun(result.runId);
  }

  async function handleDelete() {
    setDeleteError(null);
    try {
      await del.mutateAsync(workflow.id);
      setDeleteOpen(false);
    } catch (err) {
      // 409 = active runs; surface the server's actionable message. The
      // dialog stays open so the message sits beside the button that
      // caused it, and a retry needs no second trip through the row.
      setDeleteError(err instanceof Error ? err.message : "Delete failed.");
    }
  }

  return (
    // `relative` anchors the name link's stretched hit area below. The whole
    // row opens the workflow, because a row that looks like one target should
    // be one: clicking the empty space beside the name did nothing before.
    <li className="group relative flex flex-wrap items-center justify-between gap-3 rounded border border-line bg-paper px-4 py-3 hover:border-ink-wash-strong">
      {/* The assistant badge is a link of its own, so it sits beside the name
          link, not inside it. Anything interactive here must sit ABOVE the
          stretched area — nesting it inside the anchor would be invalid and
          would swallow its own click. */}
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        <Link
          to="/workflows/$workflowId"
          params={{ workflowId: workflow.id }}
          className="min-w-0 truncate text-sm font-medium text-ink after:absolute after:inset-0 after:content-[''] group-hover:underline"
        >
          {workflow.name}
        </Link>
        <span className="relative z-10">
          <OwnerBadge
            ownerType={workflow.ownerType}
            ownerId={workflow.ownerId}
          />
        </span>
        {workflow.origin === "repo" && workflow.upstream && (
          <span
            title={`${workflow.upstream.repoFullName}:${workflow.upstream.path}`}
            className="relative z-10 max-w-full truncate rounded-full bg-ink-wash-strong px-2 py-0.5 font-mono text-xs text-muted"
          >
            {workflow.upstream.repoFullName}:{workflow.upstream.path}
          </span>
        )}
        {countLabel !== undefined && (
          <span className="shrink-0 text-xs font-normal text-muted">
            {countLabel} run{runCount === 1 && !runsQ.data?.nextCursor ? "" : "s"}
          </span>
        )}
      </div>
      {hasSchema && (
        <RunWorkflowDialog
          workflowId={workflow.id}
          workflowName={workflow.name}
          schema={schema}
          open={runOpen}
          onOpenChange={setRunOpen}
          onStarted={goToRun}
        />
      )}
      <div className="relative z-10 flex max-w-full flex-wrap items-center gap-2">
        {scheduleCount > 0 && (
          <span
            aria-label={`${scheduleCount} schedule${scheduleCount === 1 ? "" : "s"}`}
            title={nextFireAt ? `next fire ${new Date(nextFireAt).toLocaleString()}` : undefined}
            className="inline-flex items-center gap-1 rounded-full bg-ink-wash-strong px-2 py-0.5 text-xs text-muted"
          >
            <Clock className="h-3 w-3" /> {scheduleCount}
          </span>
        )}
        {eventCount > 0 && (
          <span
            aria-label={`${eventCount} event trigger${eventCount === 1 ? "" : "s"}`}
            className="inline-flex items-center gap-1 rounded-full bg-ink-wash-strong px-2 py-0.5 text-xs text-muted"
          >
            <Zap className="h-3 w-3" /> {eventCount}
          </span>
        )}
        {latestRun && (
          <RunStatusChip status={latestRun.status} outcome={latestRun.outcome} needsApproval={false} />
        )}
        <Button size="sm" onClick={() => void handleRun()} disabled={startRun.isPending}>
          {startRun.isPending ? "Starting…" : "Run"}
        </Button>
        {workflow.origin !== "repo" && (
          <>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setDeleteError(null);
                setDeleteOpen(true);
              }}
              disabled={del.isPending}
              aria-label={`Delete ${workflow.name}`}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
            <ConfirmDialog
              open={deleteOpen}
              onOpenChange={setDeleteOpen}
              title={`Delete "${workflow.name}"?`}
              description="The workflow, its saved versions, and its triggers are deleted. Settled run history is kept."
              confirmLabel="Delete workflow"
              pendingLabel="Deleting…"
              pending={del.isPending}
              error={deleteError}
              onConfirm={() => void handleDelete()}
            />
          </>
        )}
      </div>
    </li>
  );
}

/** Renders the hub's flat Triggers tab under the active workspace. A thin
 * wrapper so `TriggerList` (also used per-workflow) reads the switcher only
 * here, where there is no workflow id to scope it. */
function TriggersTab() {
  const owner = useListOwner();
  return <TriggerList owner={owner} />;
}

function RunsTab() {
  const owner = useListOwner();
  return <ScopedRunsTab key={`${owner?.ownerType}:${owner?.ownerId}`} />;
}

function ScopedRunsTab() {
  // The Runs tab is a workspace list like the others: without the switcher's
  // owner it shows the caller's runs plus every team's, ignoring the scope.
  const owner = useListOwner();
  const [cursors, setCursors] = useState<string[]>([]);
  const cursor = currentCursor(cursors);
  const { data, isLoading, error } = useAllWorkflowRuns(
    owner,
    cursor === undefined ? undefined : { cursor },
  );
  const runs = data?.runs ?? [];
  const hasNext = data?.nextCursor != null;
  const paged = !isLoading && !error && (cursors.length > 0 || hasNext);

  if (isLoading) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner size={14} /> Loading runs…
      </div>
    );
  }
  if (error) {
    return <div className="text-sm text-danger-500">Failed to load runs.</div>;
  }
  return (
    <div>
      {runs.length === 0 && (
        <div className="text-sm text-muted">
          No runs yet. Run a workflow from the Workflows tab.
        </div>
      )}
      <ul className="space-y-2">
        {runs.map((r) => (
          <li key={r.runId}>
            <Link
              to="/workflows/runs/$runId"
              params={{ runId: r.runId }}
              className="flex flex-col items-start justify-between gap-3 rounded border sm:flex-row sm:items-center border-line bg-paper px-4 py-3 hover:border-ink-wash-strong"
            >
              <div className="min-w-0 max-w-full">
                <div className="break-words text-sm font-medium text-ink sm:truncate">{r.workflowName}</div>
                <div className="break-all text-xs text-muted font-mono sm:truncate">{r.runId}</div>
              </div>
              <div className="flex max-w-full flex-wrap items-center gap-3">
                <span className="text-xs text-muted">{new Date(r.createdAt).toLocaleString()}</span>
                <RunStatusChip status={r.status} outcome={r.outcome} needsApproval={false} />
              </div>
            </Link>
          </li>
        ))}
      </ul>
      {paged && (
        <Pager
          label="runs"
          page={pageNumber(cursors)}
          hasPrevious={cursors.length > 0}
          hasNext={hasNext}
          onPrevious={() => setCursors(popCursor(cursors))}
          onNext={() => {
            if (data?.nextCursor != null) setCursors(pushCursor(cursors, data.nextCursor));
          }}
        />
      )}
    </div>
  );
}
