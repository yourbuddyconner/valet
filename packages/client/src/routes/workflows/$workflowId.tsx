import { useEffect, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { PageContainer } from '@/components/layout/page-container';
import {
  useWorkflow,
  useWorkflowDraft,
  useSaveWorkflowDraft,
  usePublishWorkflow,
  useValidateWorkflowDraft,
  useTestRunWorkflow,
  useWorkflowVersions,
  useRestoreWorkflowVersion,
  useDeleteWorkflow,
  useUpdateWorkflow,
} from '@/api/workflows';
import { useWorkflowExecutions } from '@/api/executions';
import { ExecutionApprovalPanel } from '@/components/workflows/execution-approval-panel';
import { VisualWorkflowEditor } from '@/components/workflows/visual-workflow-editor';
import {
  buildWorkflowEditorTabs,
  getWorkflowEnabledLabel,
  type WorkflowEditorTab,
} from '@/components/workflows/workflow-detail-view-model';
import type { WorkflowDefinition } from '@valet/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import { formatRelativeTime } from '@/lib/format';

export const Route = createFileRoute('/workflows/$workflowId')({
  component: WorkflowDetailPage,
});

function WorkflowDetailPage() {
  const { workflowId } = Route.useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useWorkflow(workflowId);
  const { data: draftData, isLoading: draftLoading } = useWorkflowDraft(workflowId);
  const { data: versionsData } = useWorkflowVersions(workflowId);
  const { data: executionsData } = useWorkflowExecutions(workflowId);

  const saveDraft = useSaveWorkflowDraft();
  const publish = usePublishWorkflow();
  const validate = useValidateWorkflowDraft();
  const testRun = useTestRunWorkflow();
  const restoreVersion = useRestoreWorkflowVersion();
  const deleteWorkflow = useDeleteWorkflow();
  const updateWorkflow = useUpdateWorkflow();

  const workflow = data?.workflow;
  const [editorDefinition, setEditorDefinition] = useState<WorkflowDefinition | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkflowEditorTab>('editor');

  useEffect(() => {
    setEditorDefinition(draftData?.draft ?? null);
  }, [draftData?.draft]);

  if (isLoading) {
    return (
      <PageContainer>
        <Skeleton className="h-8 w-64" />
        <Skeleton className="mt-4 h-4 w-96" />
        <Skeleton className="mt-8 h-64 w-full" />
      </PageContainer>
    );
  }

  if (error || !workflow) {
    return (
      <PageContainer>
        <div className="rounded-lg border border-red-200 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
          <p className="text-sm text-pretty text-red-600 dark:text-red-400">
            Failed to load workflow.
          </p>
        </div>
      </PageContainer>
    );
  }

  async function saveCurrentEditorDraft() {
    if (!editorDefinition) return;
    await saveDraft.mutateAsync({
      workflowId,
      draft: editorDefinition,
    });
  }

  async function handlePublish() {
    try {
      await saveCurrentEditorDraft();
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Failed to save draft');
      return;
    }

    // Validate first so the user sees a structured error list before
    // we attempt the publish (which itself runs the same validators
    // server-side, but the toast UX is cleaner with the pre-check).
    validate.mutate(
      { workflowId },
      {
        onSuccess: (vRes) => {
          const errors = vRes.errors ?? [];
          if (errors.length > 0) {
            toastError(`${errors.length} validation error(s): ${errors[0]!.message}`);
            return;
          }
          publish.mutate(
            { workflowId },
            {
              onSuccess: (res) => toastSuccess(`Published version ${res.version.version}`),
              onError: (err) =>
                toastError(err instanceof Error ? err.message : 'Failed to publish'),
            },
          );
        },
        onError: (err) =>
          toastError(err instanceof Error ? err.message : 'Validation failed'),
      },
    );
  }

  async function handleTestRun() {
    try {
      await saveCurrentEditorDraft();
      testRun.mutate(
        { workflowId, inputs: {} },
        {
          onSuccess: (res) => toastSuccess(`Test run started (${res.executionId})`),
          onError: (err) =>
            toastError(err instanceof Error ? err.message : 'Failed to start test run'),
        },
      );
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Failed to save draft');
    }
  }

  function handleSaveClick() {
    if (!editorDefinition) return;
    saveDraft.mutate(
      { workflowId, draft: editorDefinition },
      {
        onSuccess: () => toastSuccess('Draft saved'),
        onError: (err) =>
          toastError(err instanceof Error ? err.message : 'Failed to save draft'),
      },
    );
  }

  function handleRestore(versionId: string) {
    restoreVersion.mutate(
      { workflowId, versionId },
      {
        onSuccess: () => toastSuccess('Restored draft from version'),
        onError: (err) =>
          toastError(err instanceof Error ? err.message : 'Failed to restore version'),
      },
    );
  }

  async function handleDeleteWorkflow() {
    if (!workflow) return;

    try {
      await deleteWorkflow.mutateAsync(workflow.id);
      toastSuccess('Workflow deleted', `${workflow.name} was removed.`);
      setDeleteDialogOpen(false);
      navigate({ to: '/automation/workflows' });
    } catch (err) {
      toastError('Failed to delete workflow', err instanceof Error ? err.message : 'Delete failed');
    }
  }

  function handleToggleEnabled() {
    if (!workflow) return;
    updateWorkflow.mutate(
      { workflowId: workflow.id, enabled: !workflow.enabled },
      {
        onError: (err) =>
          toastError(err instanceof Error ? err.message : 'Failed to update workflow'),
      },
    );
  }

  const versions = versionsData?.versions ?? [];
  const executions = executionsData?.executions ?? [];
  const editorTabs = buildWorkflowEditorTabs(executions.length);

  return (
    <div className="flex h-full min-h-[720px] flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      <AlertDialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Workflow</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{workflow.name}"? This removes the workflow and its triggers.
              This action cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleteWorkflow.isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDeleteWorkflow}
              disabled={deleteWorkflow.isPending}
              className="bg-red-600 text-white hover:bg-red-700"
            >
              {deleteWorkflow.isPending ? 'Deleting...' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <header className="flex h-16 shrink-0 items-center justify-between gap-4 border-b border-neutral-800 bg-neutral-950 px-5">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/automation/workflows"
            className="rounded-md px-2 py-1 text-xs text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100"
          >
            Back
          </Link>
          <div className="min-w-0">
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-base font-semibold text-neutral-100">
                {workflow.name}
              </h1>
              {workflow.description && (
                <span className="hidden truncate text-xs text-neutral-500 md:inline">
                  {workflow.description}
                </span>
              )}
            </div>
            <div className="mt-0.5 flex items-center gap-2">
              {draftData?.publishedVersionId ? (
                <Badge variant="success">Published</Badge>
              ) : (
                <Badge variant="secondary">Draft</Badge>
              )}
              <span className="font-mono text-[11px] text-neutral-500">
                dag/v1
              </span>
            </div>
          </div>
        </div>

        <div className="hidden rounded-lg border border-neutral-800 bg-neutral-900 p-1 sm:flex">
          {editorTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-md px-3 py-1.5 text-sm transition ${
                activeTab === tab.id
                  ? 'bg-neutral-800 text-neutral-100 shadow-sm'
                  : 'text-neutral-400 hover:text-neutral-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <button
            type="button"
            onClick={handleToggleEnabled}
            disabled={updateWorkflow.isPending}
            className="hidden items-center gap-2 rounded-md px-2 py-1.5 text-sm text-neutral-400 hover:bg-neutral-900 hover:text-neutral-100 md:flex"
          >
            <span className={workflow.enabled ? 'text-emerald-400' : 'text-neutral-400'}>
              {getWorkflowEnabledLabel(workflow.enabled)}
            </span>
            <span className={`relative h-6 w-11 rounded-full border transition ${
              workflow.enabled
                ? 'border-emerald-500/40 bg-emerald-500/25'
                : 'border-neutral-700 bg-neutral-800'
            }`}>
              <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-neutral-300 transition ${
                workflow.enabled ? 'left-5 bg-emerald-400' : 'left-0.5'
              }`} />
            </span>
          </button>
          <Button
            variant="secondary"
            onClick={handleSaveClick}
            disabled={saveDraft.isPending || !editorDefinition}
            className="border border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
          >
            {saveDraft.isPending ? 'Saving...' : 'Save'}
          </Button>
          <Button
            variant="secondary"
            onClick={handleTestRun}
            disabled={testRun.isPending || saveDraft.isPending}
            className="hidden border border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800 sm:inline-flex"
          >
            {testRun.isPending || saveDraft.isPending ? 'Starting...' : 'Test'}
          </Button>
          <Button onClick={handlePublish} disabled={publish.isPending || saveDraft.isPending}>
            {publish.isPending || saveDraft.isPending ? 'Publishing...' : 'Publish'}
          </Button>
          <Button
            variant="ghost"
            onClick={() => setDeleteDialogOpen(true)}
            disabled={deleteWorkflow.isPending}
            className="text-neutral-400 hover:bg-neutral-900 hover:text-red-300"
            title="Delete workflow"
          >
            <MoreIcon />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex border-b border-neutral-800 bg-neutral-950 p-1 sm:hidden">
          {editorTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 rounded-md px-2 py-1.5 text-sm ${
                activeTab === tab.id ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'editor' ? (
          draftLoading ? (
            <div className="p-4">
              <Skeleton className="h-[640px] w-full bg-neutral-800" />
            </div>
          ) : (
            <VisualWorkflowEditor
              definition={draftData?.draft ?? null}
              onDefinitionChange={setEditorDefinition}
              onTestRun={handleTestRun}
              isTesting={testRun.isPending || saveDraft.isPending}
              className="min-h-0 flex-1 rounded-none border-0"
            />
          )
        ) : activeTab === 'executions' ? (
          <div className="min-h-0 flex-1 overflow-auto bg-neutral-950 p-5">
            <div className="grid gap-5 xl:grid-cols-[minmax(0,1.5fr)_minmax(320px,0.8fr)]">
              <section className="rounded-lg border border-neutral-800 bg-neutral-900/60">
                <div className="border-b border-neutral-800 px-4 py-3">
                  <h2 className="text-sm font-medium text-neutral-100">Executions</h2>
                </div>
                {executions.length === 0 ? (
                  <p className="p-4 text-sm text-neutral-500">No executions yet.</p>
                ) : (
                  <ul className="divide-y divide-neutral-800">
                    {executions.slice(0, 20).map((exec) => (
                      <li key={exec.id} className="space-y-2 p-4 text-xs">
                        <div className="flex items-center justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center gap-2">
                              <Badge variant={executionBadgeVariant(exec.status)}>
                                {exec.status}
                              </Badge>
                              <Link
                                to="/automation/executions/$executionId"
                                params={{ executionId: exec.id }}
                                className="truncate font-mono text-neutral-400 underline-offset-2 hover:text-neutral-100 hover:underline"
                              >
                                {exec.id.slice(0, 8)}
                              </Link>
                            </div>
                            <div className="mt-1 tabular-nums text-neutral-500">
                              {formatRelativeTime(exec.startedAt)}
                            </div>
                          </div>
                          {exec.error && (
                            <span
                              className="line-clamp-2 max-w-[40%] text-pretty text-red-400"
                              title={exec.error}
                            >
                              {exec.error}
                            </span>
                          )}
                        </div>
                        {isActiveExecutionStatus(exec.status) && (
                          <ExecutionApprovalPanel executionId={exec.id} variant="inline" />
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="rounded-lg border border-neutral-800 bg-neutral-900/60">
                <div className="border-b border-neutral-800 px-4 py-3">
                  <h2 className="text-sm font-medium text-neutral-100">Versions</h2>
                </div>
                {versions.length === 0 ? (
                  <p className="p-4 text-sm text-neutral-500">No published versions yet.</p>
                ) : (
                  <ul className="divide-y divide-neutral-800">
                    {versions.map((v) => (
                      <li key={v.id} className="flex items-center justify-between gap-3 p-4 text-xs">
                        <div className="min-w-0 flex-1">
                          <div className="font-medium text-neutral-100">v{v.version}</div>
                          {v.publishNote && (
                            <div className="text-pretty text-neutral-400">{v.publishNote}</div>
                          )}
                          <div className="tabular-nums text-neutral-500">
                            {formatRelativeTime(v.createdAt)}
                          </div>
                        </div>
                        <Button
                          variant="secondary"
                          onClick={() => handleRestore(v.id)}
                          disabled={restoreVersion.isPending}
                          className="border border-neutral-700 bg-neutral-900 text-neutral-100 hover:bg-neutral-800"
                        >
                          Restore
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center bg-neutral-950 p-5">
            <section className="w-full max-w-md rounded-lg border border-neutral-800 bg-neutral-900/70 p-5 text-center">
              <h2 className="text-base font-medium text-neutral-100">Test workflow</h2>
              <Button
                className="mt-5 bg-red-500 text-white hover:bg-red-600"
                onClick={handleTestRun}
                disabled={testRun.isPending || saveDraft.isPending}
              >
                {testRun.isPending || saveDraft.isPending ? 'Starting...' : 'Test workflow'}
              </Button>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}

function MoreIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-4 w-4"
    >
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
      <circle cx="5" cy="12" r="1" />
    </svg>
  );
}

function executionBadgeVariant(
  status: string,
): 'success' | 'error' | 'secondary' | 'default' {
  switch (status) {
    case 'completed':
      return 'success';
    case 'failed':
      return 'error';
    case 'cancelled':
      return 'secondary';
    case 'running':
    case 'pending':
    case 'waiting_approval':
      return 'default';
    default:
      return 'secondary';
  }
}

// Active = not yet terminal. Parallel waiting siblings can leave the
// aggregate status at 'running' or 'waiting_time' while approvals are
// still pending on individual nodes.
function isActiveExecutionStatus(status: string): boolean {
  return status === 'pending' || status === 'running' || status === 'waiting_approval' || status === 'waiting_time';
}
