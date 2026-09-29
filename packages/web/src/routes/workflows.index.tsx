import { useWorkspaceAssistant } from "~/components/layout/workspace-assistant";
import { createFileRoute, Link, useNavigate, useSearch } from "@tanstack/react-router";
import type {
  WorkflowDefinitionSummary,
  WorkflowTriggerItem,
} from "@valet/api/wire";
import { triggerDataSchema, visibleTriggerFields } from "@valet/workflow";
import { AlertCircle, Clock, Trash2, Zap, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import {
  useDeleteWorkflow,
  useStartRun,
  useWorkflows,
  useWorkflowTriggers,
} from "~/api/workflows";
import { WorkflowCreation } from "~/components/workflows/workflow-creation";
import { DropdownMenu, DropdownMenuTrigger, DropdownMenuContent, DropdownMenuItem } from "~/components/primitives/dropdown-menu";
import { OwnerBadge } from "~/components/owner-badge";
import { Button, ConfirmDialog, Spinner } from "~/components/primitives";
import { ImportWorkflowDialog } from "~/components/workflows/import-workflow-dialog";
import { NewWorkflowDialog } from "~/components/workflows/new-workflow-dialog";
import { RunWorkflowDialog } from "~/components/workflows/run-workflow-dialog";
import { TriggerList } from "~/components/workflows/trigger-list";
import { WorkspaceClause } from "~/components/workspace-clause";
import { relativeTime } from "~/lib/relative-time";
import { useListOwner } from "~/lib/use-list-owner";

/** Workflow definitions and schedules; failures link directly to run details. */
type HubTab = "workflows" | "scheduled";

export const Route = createFileRoute("/workflows/")({
  component: WorkflowsIndexPage,
  validateSearch: (search: Record<string, unknown>): { tab?: HubTab; run?: string; gate?: string } => ({
    tab:
      search.tab === "scheduled" || search.tab === "triggers"
        ? "scheduled"
        : undefined,
    run: typeof search.run === "string" ? search.run : undefined,
    gate: typeof search.gate === "string" ? search.gate : undefined,
  }),
});

const TABS: { id: HubTab; label: string }[] = [
  { id: "workflows", label: "Workflows" },
  { id: "scheduled", label: "Scheduled" },
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
  const assistant = useWorkspaceAssistant();
  const [creating, setCreating] = useState(false);
  const createWithValet = () => { assistant.close(); setCreating(true); void navigate({ to: "/workflows", search: {} }); };
  const [newOpen, setNewOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);

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
            <DropdownMenu>
              <DropdownMenuTrigger asChild><Button size="sm" variant="ghost" aria-label="Workflow options"><MoreHorizontal className="h-4 w-4" /></Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setImportOpen(true)}>Import workflow</DropdownMenuItem>
                <DropdownMenuItem onSelect={() => setNewOpen(true)}>Manual setup</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button size="sm" onClick={createWithValet}>Create with Valet</Button>
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

            </button>
          ))}
        </div>
      </div>

      <NewWorkflowDialog open={newOpen} onOpenChange={setNewOpen} />
      <ImportWorkflowDialog open={importOpen} onOpenChange={setImportOpen} />

      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-4 sm:p-6">
        {tab === "workflows" && <WorkflowsTab creating={creating} onBegin={() => setCreating(true)} onBack={() => setCreating(false)} />}
        {tab === "scheduled" && <ScheduledTab />}
      </div>
    </div>
  );
}


function WorkflowsTab({ creating, onBegin, onBack }: { creating: boolean; onBegin: () => void; onBack: () => void }) {
  // The nav's workspace switcher decides which workspace this list is FOR.
  // Without it the list answers with the caller's own workflows plus every
  // team's, which is a union that does not change when the switcher does —
  // so switching appeared to do nothing.
  const owner = useListOwner();
  const { data, isLoading, error } = useWorkflows(owner, { refetchInterval: 5_000, enabled: owner !== undefined });
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
  if (workflows.length === 0 || creating) {
    return <WorkflowCreation key={owner?.ownerId} onBegin={onBegin} onBack={workflows.length > 0 ? onBack : undefined} />;
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm text-muted">{workflows.length} workflow{workflows.length === 1 ? "" : "s"} in this workspace</p><p className="text-xs text-muted">Open a workflow to edit its steps and schedule.</p></div>
    <ul className="space-y-3">
      {workflows.map((wf) => (
        <DefinitionRow key={wf.id} workflow={wf} triggers={triggersByWf.get(wf.id) ?? []} />
      ))}
    </ul>
    </div>
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
  const del = useDeleteWorkflow();
  const navigate = useNavigate();
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
    <li className="group relative flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-paper px-4 py-4 hover:border-ink-wash-strong">
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

        <p className="basis-full text-xs leading-5 text-muted">Updated {relativeTime(workflow.updatedAt)}</p>
        <p className="basis-full text-xs text-muted">{nextFireAt ? `Next run ${new Date(nextFireAt).toLocaleString()}` : scheduleCount > 0 ? "Schedule paused" : eventCount > 0 ? "Runs when a matching event arrives" : "Run when needed"}{workflow.latestRun ? ` · Last run ${workflow.latestRun.outcome ?? workflow.latestRun.status}` : " · No runs yet"}</p>
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
        {workflow.latestFailedRun && (
          <Link
            to="/workflows/runs/$runId"
            params={{ runId: workflow.latestFailedRun.runId }}
            title={`Last failed ${relativeTime(workflow.latestFailedRun.failedAt)}`}
            className="inline-flex min-h-8 items-center gap-1.5 rounded border border-danger-500/30 px-2.5 py-1 text-xs font-medium text-danger-500 hover:bg-danger-500/10"
          >
            <AlertCircle className="h-3.5 w-3.5" /> View latest failed run
          </Link>
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

function ScheduledTab() {
  const owner = useListOwner();
  return <TriggerList owner={owner} schedulesOnly />;
}
