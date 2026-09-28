import { createFileRoute, Link, useBlocker, useNavigate } from "@tanstack/react-router";
import type {
  GetWorkflowPermissionsResponse,
  ListWorkflowRunsResponse, WorkflowDefinitionSummary, WorkflowNodePermissionWire
} from "@valet/api/wire";
import { triggerDataSchema, visibleTriggerFields, type WorkflowDefinition } from "@valet/workflow";
import { MoreHorizontal, ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import {
  downloadWorkflowFile,
  useAllowWorkflowPermissions,
  useCopyWorkflow,
  useStartRun,
  useUpdateWorkflow,
  useWorkflow,
  useWorkflowPermissions,
  useWorkflowRuns,
  useWorkflowVersion,
  useWorkflowVersions,
  type UpdateWorkflowMutation,
} from "~/api/workflows";
import {
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Spinner,
} from "~/components/primitives";
import { isWorkflowDefinitionShape } from "~/components/workflows/editor-model";
import { WorkflowAssistantPanel } from "~/components/workflows/editor/assistant-panel";
import { Editor } from "~/components/workflows/editor/editor";
import { WorkflowPreview } from "~/components/workflows/preview";
import { RiskBadge } from "~/components/workflows/risk-badge";
import { RunWorkflowDialog } from "~/components/workflows/run-workflow-dialog";
import { TriggersPanel } from "~/components/workflows/triggers-drawer";
import { useWorkflowAssistant } from "~/hooks/use-workflow-assistant";
import { useWorkflowPatchWatch } from "~/hooks/use-workflow-patch-watch";
import { blobUrl } from "~/lib/blob-url";
import { cn } from "~/lib/cn";
import { errorText, validationMessages } from "~/lib/error-text";
import { relativeTime } from "~/lib/relative-time";
import { runCountLabel } from "~/lib/run-count";
import { useAdoptWorkspaceScope, useWorkspaceScope } from "~/lib/workspace-scope";

/**
 * `/workflows/$workflowId` — the visual editor page (plan decision 11):
 * canvas + inspector + Save (Task 8-10's `Editor`) plus a Run button and a
 * collapsible runs section. Replaces the old index-page JSON create/edit
 * form as the place definitions are actually edited; `workflows.index.tsx`
 * now only links here.
 */
export const Route = createFileRoute("/workflows/$workflowId")({
  component: WorkflowEditorRoute,
});

function WorkflowEditorRoute() {
  const { workflowId } = Route.useParams();
  return <WorkflowEditorPage workflowId={workflowId} />;
}

export function WorkflowEditorPage({ workflowId }: { workflowId: string }) {
  const { data, isLoading, error } = useWorkflow(workflowId);
  useAdoptWorkspaceScope(data ? { type: data.ownerType, id: data.ownerId } : undefined);
  const update = useUpdateWorkflow(workflowId);
  const startRun = useStartRun(workflowId);
  const runsQ = useWorkflowRuns(workflowId);
  const permissionsQ = useWorkflowPermissions(workflowId);
  const allowPermissions = useAllowWorkflowPermissions(workflowId);
  const navigate = useNavigate();

  const definition = useMemo<WorkflowDefinition | null>(() => {
    if (!data) return null;
    return isWorkflowDefinitionShape(data.definition) ? data.definition : null;
  }, [data]);

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center gap-2 p-6 text-sm text-muted">
        <Spinner size={14} /> Loading workflow…
      </div>
    );
  }
  if (error || !data || !definition) {
    return <div className="flex-1 p-6 text-sm text-danger-500">Failed to load workflow.</div>;
  }

  return (
    <WorkflowEditorPane
      // Force a full remount on wf→wf navigation (review fix 4): without
      // this, `WorkflowEditorPane`'s `name`/`committedName` state — seeded
      // once from `initialName` at mount — would carry over from the
      // previous workflow while `Editor`'s own `initialDefinition` prop
      // silently changed underneath it, showing stale name/definition
      // state until the next edit.
      key={workflowId}
      workflowId={workflowId}
      ownerType={data.ownerType}
      ownerId={data.ownerId}
      initialName={data.name}
      initialDefinition={definition}
      origin={data.origin}
      upstream={data.upstream}
      update={update}
      startRun={startRun}
      runsQuery={runsQ}
      permissions={permissionsQ.data}
      allowPermissions={allowPermissions}
      navigate={navigate}
    />
  );
}

/** Module scope so the blocker's effect does not re-register on each render.
 * `disabled` decides whether the blocker runs at all; when it runs, every
 * departure is blocked. */
const alwaysBlock = () => true;

function WorkflowEditorPane({
  ownerType,
  ownerId,
  workflowId,
  initialName,
  initialDefinition,
  origin,
  upstream,
  update,
  startRun,
  runsQuery,
  permissions,
  allowPermissions,
  navigate,
}: {
  workflowId: string;
  initialName: string;
  initialDefinition: WorkflowDefinition;
  ownerType: string;
  ownerId: string;
  origin?: "local" | "repo";
  upstream?: WorkflowDefinitionSummary["upstream"];
  update: UpdateWorkflowMutation;
  startRun: ReturnType<typeof useStartRun>;
  runsQuery: {
    data?: ListWorkflowRunsResponse;
    isLoading: boolean;
    error: unknown;
  };
  permissions?: GetWorkflowPermissionsResponse;
  allowPermissions: ReturnType<typeof useAllowWorkflowPermissions>;
  navigate: ReturnType<typeof useNavigate>;
}) {
  // Right-side drawer: runs list / version history / triggers. Header
  // buttons toggle it — the old bottom collapsible was invisible under a
  // full-height canvas ("no way to view the list of runs").
  const [drawer, setDrawer] = useState<"runs" | "history" | "triggers" | null>(null);
  // The assistant is the editor's right-hand column, not one of the overlay
  // drawers — see `WorkflowAssistantPanel`. It has no open/closed state of
  // its own: describing a change is the primary way to edit a workflow, so
  // the conversation is on screen from the moment the editor is.
  const scope = useWorkspaceScope();
  const copy = useCopyWorkflow();
  const mirrored = origin === "repo";
  const assistant = useWorkflowAssistant(workflowId, initialName, { ownerType, ownerId });
  // The one thing that makes a live edit visible: a completed patch in the
  // panel's conversation refetches the workflow, and `Editor` adopts it.
  useWorkflowPatchWatch(assistant.sessionId, assistant.threadId, workflowId);

  // The rename control (review fix 1): name state lives here, at the page
  // level, rather than in `Editor` — `Editor` only needs to know whether
  // the name is dirty (`externalDirty`) so a rename rides the same
  // Save/Cancel actions as a definition edit. `committedName` tracks the
  // last-saved value locally instead of comparing against the query's
  // live `data.name`, so there's no race with the invalidate-then-refetch
  // that follows a successful save.
  const [name, setName] = useState(initialName);
  const [committedName, setCommittedName] = useState(initialName);
  const nameDirty = name !== committedName;
  const [runOpen, setRunOpen] = useState(false);
  const [preapproveOpen, setPreapproveOpen] = useState(false);
  // The last pre-approval's leftovers: gating actions an org policy keeps
  // gated, which only an org admin can change. Shown until the next attempt.
  const [blockedActions, setBlockedActions] = useState<{ actionId: string; reason: string }[]>([]);

  // Per-node badge input for the canvas: only the two states a card marks.
  const gateByNodeId = useMemo(() => {
    const map = new Map<string, "require_approval" | "deny">();
    for (const node of permissions?.nodes ?? []) {
      if (node.mode === "require_approval" || node.mode === "deny") map.set(node.nodeId, node.mode);
    }
    return map;
  }, [permissions]);

  // The header badge counts ACTIONS, not nodes — pre-approving writes one
  // override per action, and two nodes calling the same action are one
  // approval. First node wins as the display row for an action.
  const gatingActions = useMemo(() => {
    const seen = new Map<string, WorkflowNodePermissionWire>();
    for (const node of permissions?.nodes ?? []) {
      if (node.mode === "require_approval" && node.actionId !== null && !seen.has(node.actionId)) {
        seen.set(node.actionId, node);
      }
    }
    return [...seen.values()];
  }, [permissions]);

  // Unsaved work is only in memory: the rename lives here and the definition
  // draft lives in `Editor`, so any navigation away drops both. `useBlocker`
  // catches every route change — the back link, the nav, a run link in the
  // drawer — and `enableBeforeUnload` (its default) catches a tab close or a
  // reload. `disabled` keeps the blocker off a clean page, where a
  // beforeunload prompt would be noise.
  const [definitionDirty, setDefinitionDirty] = useState(false);
  const unsaved = nameDirty || definitionDirty;
  const leaveBlocker = useBlocker({
    shouldBlockFn: alwaysBlock,
    disabled: !unsaved,
    withResolver: true,
  });

  // Run executes the SAVED definition (the api snapshots the stored row),
  // so the run dialog's schema comes from `initialDefinition`, not the
  // editor's in-progress draft. Filtered to the fields a person actually
  // answers — a `hidden` field is one an event trigger maps in, and asking
  // for it here is the same mistake the install dialog already avoids.
  const schema = visibleTriggerFields(triggerDataSchema(initialDefinition));
  const hasSchema = Object.keys(schema).length > 0;

  async function handleSave(next: WorkflowDefinition) {
    await update.mutateAsync({ name, definition: next });
    setCommittedName(name);
  }

  function handleCancelName() {
    setName(committedName);
  }

  function goToRun(runId: string) {
    void navigate({ to: "/workflows/runs/$runId", params: { runId } });
  }

  async function handleRun() {
    if (hasSchema) {
      setRunOpen(true);
      return;
    }
    const result = await startRun.mutateAsync();
    goToRun(result.runId);
  }

  function setPreapproveDialog(open: boolean) {
    setPreapproveOpen(open);
    // A closed dialog must not reopen showing the previous attempt's error.
    if (!open) allowPermissions.reset();
    // Reopening starts a fresh attempt: drop the previous attempt's blocked
    // notice, or it reads as this attempt's result. Clearing on CLOSE would
    // never show the notice at all — a confirm sets it and then closes.
    if (open) setBlockedActions([]);
  }

  async function handlePreapprove() {
    let result;
    try {
      result = await allowPermissions.mutateAsync();
    } catch {
      // `allowPermissions.error` renders the message inside the dialog.
      return;
    }
    setBlockedActions(result.blocked);
    setPreapproveDialog(false);
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div className="flex shrink-0 flex-col gap-2 border-b border-line px-3 py-3 lg:flex-row lg:items-center lg:justify-between lg:px-6 lg:py-4">
        <div className="flex min-w-0 flex-1 flex-col gap-1 lg:flex-row lg:items-center lg:gap-3">
          <Link to="/workflows" className="inline-flex min-h-11 shrink-0 items-center text-xs text-muted hover:text-ink sm:min-h-0">
            ← Workflows
          </Link>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label="Workflow name"
            placeholder="Untitled workflow"
            readOnly={mirrored}
            className="min-h-11 sm:min-h-0 w-full min-w-0 flex-1 rounded border border-transparent bg-transparent px-1 -mx-1 text-lg font-semibold tracking-tight text-ink font-display hover:border-line focus:border-line focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 read-only:hover:border-transparent"
          />
        </div>
        <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={drawer === "runs" ? "secondary" : "ghost"}
            onClick={() => setDrawer((d) => (d === "runs" ? null : "runs"))}
          >
            Runs{runsQuery.data ? ` (${runCountLabel(runsQuery.data)})` : ""}
          </Button>
          <Button
            size="sm"
            variant={drawer === "triggers" ? "secondary" : "ghost"}
            onClick={() => setDrawer((d) => (d === "triggers" ? null : "triggers"))}
          >
            Triggers
          </Button>
          {gatingActions.length > 0 && (ownerType === "team" ? (
            <Link to="/settings/policies" onClick={() => scope.setKey(ownerId)} className="text-xs underline" title="A team admin can change approval rules in Team Policies.">Team Policies · {gatingActions.length} actions need approval (team admin manages rules)</Link>
          ) : (
            <button
              type="button"
              data-testid="workflow-gate-badge"
              onClick={() => setPreapproveDialog(true)}
              title="Some actions pause a run for approval. Pre-approve them to run this workflow unattended."
              className="inline-flex min-h-11 shrink-0 items-center gap-1 rounded-full sm:min-h-0 bg-warning-wash px-2.5 py-1 text-xs font-medium text-warning-fg hover:opacity-80 focus-visible:ring-2 focus-visible:ring-accent-500/40"
            >
              <ShieldAlert className="h-3.5 w-3.5" aria-hidden />
              {gatingActions.length === 1
                ? "1 action needs approval"
                : `${gatingActions.length} actions need approval`}
            </button>
          ))}
          {mirrored && (
            <Button
              size="sm"
              variant="secondary"
              disabled={copy.isPending}
              onClick={() => {
                void copy.mutateAsync(workflowId).then((copied) => {
                  void navigate({ to: "/workflows/$workflowId", params: { workflowId: copied.id } });
                });
              }}
            >
              {copy.isPending ? "Copying…" : "Copy"}
            </Button>
          )}
          <Button size="sm" onClick={() => void handleRun()} disabled={startRun.isPending}>
            {startRun.isPending ? "Starting…" : "Run"}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant={drawer === "history" ? "secondary" : "ghost"}
                aria-label="More"
              >
                <MoreHorizontal className="h-4 w-4" aria-hidden />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setDrawer((d) => (d === "history" ? null : "history"))}>
                Version history
              </DropdownMenuItem>
              <DropdownMenuItem
                onSelect={() => {
                  void downloadWorkflowFile(workflowId).catch((err) => {
                    console.error(err);
                  });
                }}
              >
                Download
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {mirrored && (
        <div
          data-testid="mirrored-banner"
          className="border-b border-line bg-ink-wash px-6 py-2 text-xs text-muted"
        >
          This workflow is mirrored from{" "}
          {upstream ? (
            <a
              href={blobUrl({ repoFullName: upstream.repoFullName, repoRef: upstream.ref || "HEAD" }, upstream.path, null) ?? undefined}
              target="_blank"
              rel="noreferrer"
              className="font-mono underline underline-offset-2"
            >
              {upstream.repoFullName}:{upstream.path}
            </a>
          ) : (
            "a repository file"
          )}
          . Edit the file and push. Copy makes a local workflow you can save.
        </div>
      )}

      {blockedActions.length > 0 && (
        <div
          data-testid="preapprove-blocked"
          className="border-b border-line bg-warning-wash px-6 py-2 text-xs text-warning-fg"
        >
          {ownerType === "team" ? "A team or organization policy keeps " : "An org policy keeps "}{blockedActions.length === 1 ? "this action" : "these actions"} gated:{" "}
          {blockedActions.map((b) => b.actionId).join(", ")}. Ask {ownerType === "team" ? "a team admin to review Team Policies, or an org admin to allow" : "an org admin to allow"}{" "}
          {blockedActions.length === 1 ? "it" : "them"} in the organization policy settings.
        </div>
      )}

      {hasSchema && (
        <RunWorkflowDialog
          workflowId={workflowId}
          workflowName={committedName}
          schema={schema}
          open={runOpen}
          onOpenChange={setRunOpen}
          onStarted={goToRun}
        />
      )}

      <Dialog open={ownerType !== "team" && preapproveOpen} onOpenChange={setPreapproveDialog}>
        <DialogContent
          title="Pre-approve actions"
          description={
            "Each action below pauses a run until someone approves it. " +
            "Pre-approving writes an allow override for your user. The override applies to " +
            "every workflow and session you run, not only this workflow. Remove it any time " +
            "under Settings → Policy overrides."
          }
        >
          <ul className="flex flex-col gap-1.5 py-1" data-testid="preapprove-actions">
            {gatingActions.map((action) => (
              <li key={action.actionId} className="flex items-center gap-2 text-sm text-ink">
                <span className="truncate font-mono text-xs">{action.actionId}</span>
                {action.riskLevel && <RiskBadge level={action.riskLevel} />}
              </li>
            ))}
          </ul>
          <DialogFooter>
            <Button type="button" variant="secondary" onClick={() => setPreapproveDialog(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="preapprove-confirm"
              disabled={allowPermissions.isPending}
              onClick={() => void handlePreapprove()}
            >
              {allowPermissions.isPending
                ? "Pre-approving…"
                : gatingActions.length === 1
                  ? "Pre-approve 1 action"
                  : `Pre-approve ${gatingActions.length} actions`}
            </Button>
          </DialogFooter>
          {allowPermissions.error != null && (
            <p className="text-xs text-danger-500">{allowPermissions.error.message}</p>
          )}
        </DialogContent>
      </Dialog>

      {/* The assistant is the editor's own right-hand column, so a
          conversation about changing the diagram never covers the diagram.
          The three drawers stay overlays, and they dock beside that column
          (`right-[--editor-aside]`) rather than over it — a runs list is a
          lookup, and the conversation has to survive one. */}
      <div className="relative flex min-h-0 min-w-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <Editor
            initialDefinition={initialDefinition}
            onSave={handleSave}
            saving={update.isPending}
            readOnly={mirrored}
            gateByNodeId={gateByNodeId}
            assistant={
              <WorkflowAssistantPanel
                assistant={assistant}
                definition={initialDefinition}
                workflowId={workflowId}
              />
            }
            externalDirty={nameDirty}
            onCancelExternal={handleCancelName}
            onDirtyChange={setDefinitionDirty}
          />
        </div>
        {drawer === "runs" && <RunsDrawer runsQuery={runsQuery} onClose={() => setDrawer(null)} />}
        {drawer === "triggers" && (
          <DrawerShell title="Triggers" onClose={() => setDrawer(null)}>
            <TriggersPanel workflowId={workflowId} />
          </DrawerShell>
        )}
        {drawer === "history" && (
          <HistoryDrawer
            workflowId={workflowId}
            currentName={committedName}
            update={update}
            onClose={() => setDrawer(null)}
          />
        )}
      </div>

      {leaveBlocker.status === "blocked" && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) leaveBlocker.reset();
          }}
          title="Leave without saving?"
          description="This workflow has changes that are not saved. If you leave now, the changes are lost. To keep them, stay on this page and select Save."
          confirmLabel="Leave without saving"
          onConfirm={leaveBlocker.proceed}
        />
      )}
    </div>
  );
}

function DrawerShell({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="absolute inset-y-0 right-0 z-10 flex w-full lg:right-[--editor-aside] lg:w-96 max-w-full flex-col border-l border-line bg-paper shadow-xl">
      <div className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <span className="text-sm font-medium text-ink">{title}</span>
        <button type="button" onClick={onClose} aria-label={`Close ${title.toLowerCase()}`} className="min-h-11 min-w-11 text-muted hover:text-ink sm:min-h-0 sm:min-w-0">
          ✕
        </button>
      </div>
      {/* `overscroll-contain` keeps a scroll that reaches the end of the drawer
          from continuing into the canvas behind it. */}
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">{children}</div>
    </div>
  );
}

function RunsDrawer({
  runsQuery,
  onClose,
}: {
  runsQuery: { data?: ListWorkflowRunsResponse; isLoading: boolean; error: unknown };
  onClose: () => void;
}) {
  const runs = runsQuery.data?.runs ?? [];
  return (
    <DrawerShell
      title={`Runs${runsQuery.data ? ` (${runCountLabel(runsQuery.data)})` : ""}`}
      onClose={onClose}
    >
      {runsQuery.isLoading && (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted">
          <Spinner size={12} /> Loading runs…
        </div>
      )}
      {!runsQuery.isLoading && runsQuery.error != null && (
        <div className="px-4 py-3 text-xs text-danger-500">Failed to load runs.</div>
      )}
      {!runsQuery.isLoading && runsQuery.error == null && runs.length === 0 && (
        <div className="px-4 py-3 text-xs text-muted">No runs yet — press Run to start one.</div>
      )}
      <ul className="divide-y divide-line/60">
        {runs.map((r) => (
          <li key={r.runId}>
            <Link
              to="/workflows/runs/$runId"
              params={{ runId: r.runId }}
              className="flex items-center gap-2 px-4 py-2 hover:bg-ink-wash/60 transition-colors"
            >
              <span
                className={cn(
                  "inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-[10px] font-medium",
                  r.needsApproval
                    ? "bg-amber-500/15 text-amber-700 dark:text-amber-300"
                    : r.outcome === "completed"
                      ? "bg-moss-wash text-moss"
                      : r.outcome === "failed"
                        ? "bg-rose-50 text-danger-500 dark:bg-rose-950/40"
                        : "bg-neutral-500/10 text-muted",
                )}
              >
                {r.needsApproval ? "needs approval" : (r.outcome ?? r.status)}
              </span>
              <span className="min-w-0 flex-1 truncate font-mono text-xs text-ink">{r.runId}</span>
              <span className="shrink-0 text-[10px] text-muted">{relativeTime(r.createdAt)}</span>
            </Link>
          </li>
        ))}
      </ul>
      {/* The list is one page. Say so — a silent cut reads as "these are all
          the runs". A paging control belongs with the run-list rebuild. */}
      {runsQuery.data?.nextCursor && (
        <div className="px-4 py-3 text-xs text-muted">
          Newest {runs.length} runs shown. Older runs stay reachable by run id.
        </div>
      )}
    </DrawerShell>
  );
}

/**
 * A restore re-saves an old definition, so the save-time validator judges it
 * again. A version snapshotted before a rule existed does not pass that rule,
 * and the request 400s. `ApiError.message` is only "PUT /workflows/x → 400",
 * which names neither the fault nor the fix — the `errors` list does, so it
 * is what the drawer must show.
 */
export function restoreErrorMessage(err: unknown): string {
  const invalid = validationMessages(err);
  if (!invalid) return errorText(err, "The restore failed. Try again.");
  return (
    "This version was not restored — it does not pass the current validation rules. " +
    `Correct these in the editor, then save: ${invalid.join("; ")}`
  );
}

function HistoryDrawer({
  workflowId,
  currentName,
  update,
  onClose,
}: {
  workflowId: string;
  currentName: string;
  update: UpdateWorkflowMutation;
  onClose: () => void;
}) {
  const versionsQ = useWorkflowVersions(workflowId);
  const [selected, setSelected] = useState<number | null>(null);
  // Restore overwrites the live definition and has no undo, so it asks
  // first. `confirming` holds the version being restored, which is also
  // what the dialog names.
  const [confirming, setConfirming] = useState<number | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const versionQ = useWorkflowVersion(workflowId, selected);
  const versions = versionsQ.data?.versions ?? [];
  const latest = versions[0]?.version;

  async function restore() {
    if (!versionQ.data) return;
    setRestoreError(null);
    try {
      await update.mutateAsync({ name: currentName, definition: versionQ.data.definition });
    } catch (err) {
      setRestoreError(restoreErrorMessage(err));
      return;
    }
    setConfirming(null);
    setSelected(null);
  }

  return (
    <DrawerShell title="History" onClose={onClose}>
      {versionsQ.isLoading && (
        <div className="flex items-center gap-2 px-4 py-3 text-xs text-muted">
          <Spinner size={12} /> Loading versions…
        </div>
      )}
      {!versionsQ.isLoading && versions.length === 0 && (
        <div className="px-4 py-3 text-xs text-muted">
          No versions yet — saved before version history existed. The next save creates v1.
        </div>
      )}
      <ul className="divide-y divide-line/60">
        {versions.map((v) => (
          <li key={v.version}>
            <button
              type="button"
              onClick={() => setSelected((cur) => (cur === v.version ? null : v.version))}
              className={cn(
                "flex w-full items-center gap-2 px-4 py-2 text-left transition-colors hover:bg-ink-wash/60",
                selected === v.version && "bg-moss-wash",
              )}
            >
              <span className="font-mono text-xs text-ink">v{v.version}</span>
              {v.version === latest && (
                <span className="rounded-full bg-moss-wash px-1.5 py-px text-[9px] font-medium text-moss">
                  current
                </span>
              )}
              <span className="min-w-0 flex-1 truncate text-xs text-muted">{v.name}</span>
              <span className="shrink-0 text-[10px] text-muted">{relativeTime(v.createdAt)}</span>
            </button>
            {selected === v.version && (
              <div className="space-y-2 border-t border-line/60 bg-paper px-3 py-2">
                {versionQ.isLoading && (
                  <div className="flex items-center gap-2 text-xs text-muted">
                    <Spinner size={12} /> Loading definition…
                  </div>
                )}
                {versionQ.data && isWorkflowDefinitionShape(versionQ.data.definition) && (
                  <WorkflowPreview definition={versionQ.data.definition} />
                )}
                {versionQ.data && !isWorkflowDefinitionShape(versionQ.data.definition) && (
                  <div className="text-xs text-muted">Stored definition is not a dag/v1 workflow.</div>
                )}
                {v.version !== latest && versionQ.data && (
                  <Button
                    size="sm"
                    variant="secondary"
                    onClick={() => {
                      setRestoreError(null);
                      setConfirming(v.version);
                    }}
                    disabled={update.isPending}
                  >
                    {update.isPending ? "Restoring…" : `Restore v${v.version}`}
                  </Button>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>

      {confirming !== null && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) setConfirming(null);
          }}
          title={`Restore v${confirming}?`}
          description={`The live definition is replaced by v${confirming}. The version it replaces stays in this list, so you can restore it again.`}
          confirmLabel={`Restore v${confirming}`}
          pendingLabel="Restoring…"
          pending={update.isPending}
          error={restoreError}
          onConfirm={() => void restore()}
        />
      )}
    </DrawerShell>
  );
}
