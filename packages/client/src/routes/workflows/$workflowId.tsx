import { useEffect, useRef, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { PageContainer } from '@/components/layout/page-container';
import {
  useWorkflow,
  useWorkflowDraft,
  useSaveWorkflowDraft,
  usePublishWorkflow,
  useValidateWorkflowDraft,
  useTestRunWorkflow,
  useDeleteWorkflow,
  useUpdateWorkflow,
  useWorkflowVersions,
  useRestoreWorkflowVersion,
} from '@/api/workflows';
import { useExecution, useRetryExecution, useWorkflowExecutions } from '@/api/executions';
import { VisualWorkflowEditor } from '@/components/workflows/visual-workflow-editor';
import { WorkflowExecutionViewer } from '@/components/workflows/workflow-execution-viewer';
import {
  ManualWorkflowDialog,
  type ManualWorkflowPayload,
} from '@/components/workflows/manual-workflow-dialog';
import { WorkflowVersionsDialog } from '@/components/workflows/workflow-versions-dialog';
import {
  buildWorkflowEditorTabs,
  getPublishButtonState,
  getPublishedVersionLabel,
  getWorkflowEnabledLabel,
  type WorkflowEditorTab,
} from '@/components/workflows/workflow-detail-view-model';
import type { WorkflowDefinition } from '@valet/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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

export const Route = createFileRoute('/workflows/$workflowId')({
  component: WorkflowDetailPage,
});

function WorkflowDetailPage() {
  const { workflowId } = Route.useParams();
  const navigate = useNavigate();
  const { data, isLoading, error } = useWorkflow(workflowId);
  const { data: draftData, isLoading: draftLoading } = useWorkflowDraft(workflowId);
  const { data: executionsData } = useWorkflowExecutions(workflowId);
  const { data: versionsData, isLoading: versionsLoading } = useWorkflowVersions(workflowId);

  const saveDraft = useSaveWorkflowDraft();
  const publish = usePublishWorkflow();
  const validate = useValidateWorkflowDraft();
  const testRun = useTestRunWorkflow();
  const deleteWorkflow = useDeleteWorkflow();
  const updateWorkflow = useUpdateWorkflow();
  const restoreVersion = useRestoreWorkflowVersion();
  const retryExecution = useRetryExecution();

  const workflow = data?.workflow;
  const [editorDefinition, setEditorDefinition] = useState<WorkflowDefinition | null>(null);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [activeTab, setActiveTab] = useState<WorkflowEditorTab>('editor');
  const [selectedExecutionId, setSelectedExecutionId] = useState<string | null>(null);
  const [selectedExecutionNodeId, setSelectedExecutionNodeId] = useState<string | null>(null);
  const [manualDialogOpen, setManualDialogOpen] = useState(false);
  const [versionsDialogOpen, setVersionsDialogOpen] = useState(false);
  const [publishConfirming, setPublishConfirming] = useState(false);
  const [publishSubmitting, setPublishSubmitting] = useState(false);
  const publishConfirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectedExecution = useExecution(selectedExecutionId ?? '');

  useEffect(() => {
    setEditorDefinition(draftData?.draft ?? null);
  }, [draftData?.draft]);

  useEffect(() => {
    const executions = executionsData?.executions ?? [];
    if (selectedExecutionId || executions.length === 0) return;
    setSelectedExecutionId(executions[0]!.id);
    setSelectedExecutionNodeId(null);
  }, [executionsData?.executions, selectedExecutionId]);

  useEffect(() => {
    return () => {
      if (publishConfirmTimer.current) {
        clearTimeout(publishConfirmTimer.current);
      }
    };
  }, []);

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

  function resetPublishConfirmation() {
    if (publishConfirmTimer.current) {
      clearTimeout(publishConfirmTimer.current);
      publishConfirmTimer.current = null;
    }
    setPublishConfirming(false);
  }

  function requestPublishConfirmation() {
    if (publishConfirmTimer.current) {
      clearTimeout(publishConfirmTimer.current);
    }
    setPublishConfirming(true);
    publishConfirmTimer.current = setTimeout(() => {
      publishConfirmTimer.current = null;
      setPublishConfirming(false);
    }, 4000);
  }

  async function performPublish() {
    resetPublishConfirmation();
    setPublishSubmitting(true);
    try {
      await saveCurrentEditorDraft();
    } catch (err) {
      setPublishSubmitting(false);
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
            resetPublishConfirmation();
            setPublishSubmitting(false);
            toastError(`${errors.length} validation error(s): ${errors[0]!.message}`);
            return;
          }
          publish.mutate(
            { workflowId },
            {
              onSuccess: (res) => {
                resetPublishConfirmation();
                setPublishSubmitting(false);
                toastSuccess(`Published version ${res.version.version}`);
              },
              onError: (err) => {
                resetPublishConfirmation();
                setPublishSubmitting(false);
                toastError(err instanceof Error ? err.message : 'Failed to publish');
              },
            },
          );
        },
        onError: (err) => {
          resetPublishConfirmation();
          setPublishSubmitting(false);
          toastError(err instanceof Error ? err.message : 'Validation failed');
        },
      },
    );
  }

  function handlePublishClick() {
    if (!publishConfirming) {
      requestPublishConfirmation();
      return;
    }
    void performPublish();
  }

  async function startManualWorkflowRun(payload: ManualWorkflowPayload) {
    try {
      await saveCurrentEditorDraft();
      testRun.mutate(
        { workflowId, triggerData: payload.triggerData },
        {
          onSuccess: (res) => {
            setManualDialogOpen(false);
            setActiveTab('executions');
            setSelectedExecutionId(res.executionId);
            setSelectedExecutionNodeId(null);
            toastSuccess(`Test run started (${res.executionId})`);
          },
          onError: (err) =>
            toastError(err instanceof Error ? err.message : 'Failed to start test run'),
        },
      );
    } catch (err) {
      toastError(err instanceof Error ? err.message : 'Failed to save draft');
    }
  }

  function openManualWorkflowDialog() {
    resetPublishConfirmation();
    setManualDialogOpen(true);
  }

  function handleSaveClick() {
    resetPublishConfirmation();
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

  async function handleRestoreVersion(version: { id: string; version: number }) {
    try {
      const restored = await restoreVersion.mutateAsync({
        workflowId,
        versionId: version.id,
      });
      setEditorDefinition(restored.draft);
      setActiveTab('editor');
      setVersionsDialogOpen(false);
      resetPublishConfirmation();
      toastSuccess(
        `Restored version ${version.version} to draft`,
        'Publish the draft when you are ready to make it active.',
      );
    } catch (err) {
      toastError(
        'Failed to restore version',
        err instanceof Error ? err.message : 'Restore failed',
      );
    }
  }

  function handleToggleEnabled() {
    if (!workflow) return;
    resetPublishConfirmation();
    updateWorkflow.mutate(
      { workflowId: workflow.id, enabled: !workflow.enabled },
      {
        onError: (err) =>
          toastError(err instanceof Error ? err.message : 'Failed to update workflow'),
      },
    );
  }

  async function handleRetryExecution(executionId: string) {
    try {
      const result = await retryExecution.mutateAsync({ executionId });
      setActiveTab('executions');
      setSelectedExecutionId(result.executionId);
      setSelectedExecutionNodeId(null);
      toastSuccess(`Retry started (${result.executionId})`);
    } catch (err) {
      toastError('Retry failed', err instanceof Error ? err.message : 'Failed to retry execution');
    }
  }

  const executions = executionsData?.executions ?? [];
  const versions = versionsData?.versions ?? [];
  const publishedVersionId = draftData?.publishedVersionId ?? workflow.publishedVersionId;
  const publishedVersionLabel = getPublishedVersionLabel(publishedVersionId, versions);
  const editorTabs = buildWorkflowEditorTabs(executions.length);
  const publishButton = getPublishButtonState({
    isConfirming: publishConfirming,
    isPending: publishSubmitting || publish.isPending,
  });

  return (
    <div className="flex h-full min-h-[720px] flex-col overflow-hidden bg-neutral-50 text-neutral-950 dark:bg-neutral-950 dark:text-neutral-100">
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

      <ManualWorkflowDialog
        open={manualDialogOpen}
        onOpenChange={setManualDialogOpen}
        definition={editorDefinition ?? draftData?.draft ?? null}
        workflowName={workflow.name}
        isLoadingDefinition={draftLoading}
        isSubmitting={testRun.isPending || saveDraft.isPending}
        onSubmit={startManualWorkflowRun}
      />

      <WorkflowVersionsDialog
        open={versionsDialogOpen}
        onOpenChange={setVersionsDialogOpen}
        workflowName={workflow.name}
        versions={versions}
        publishedVersionId={publishedVersionId}
        isLoading={versionsLoading}
        isRestoring={restoreVersion.isPending}
        onRestore={handleRestoreVersion}
      />

      <header className="grid h-16 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-4 border-b border-neutral-200 bg-white px-5 shadow-sm dark:border-neutral-800 dark:bg-neutral-950 dark:shadow-none">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            to="/automation/workflows"
            className="rounded-md px-2 py-1 text-xs font-medium text-neutral-500 hover:bg-neutral-100 hover:text-neutral-950 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-neutral-100"
          >
            Back
          </Link>
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-sm font-semibold leading-tight text-neutral-950 dark:text-neutral-100 md:text-base">
              {workflow.name}
            </h1>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              {publishedVersionId ? (
                <Badge variant="success">{publishedVersionLabel}</Badge>
              ) : (
                <Badge variant="secondary">Draft</Badge>
              )}
              <button
                type="button"
                onClick={handleToggleEnabled}
                disabled={updateWorkflow.isPending}
                role="switch"
                aria-checked={workflow.enabled}
                className={`group inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium transition disabled:opacity-60 ${
                  workflow.enabled
                    ? 'border-emerald-300 bg-emerald-50 text-emerald-700 hover:border-emerald-400 hover:bg-emerald-100 dark:border-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300 dark:hover:bg-emerald-950/60'
                    : 'border-neutral-300 bg-neutral-50 text-neutral-500 hover:border-neutral-400 hover:bg-neutral-100 hover:text-neutral-700 dark:border-neutral-600 dark:bg-neutral-900 dark:text-neutral-400 dark:hover:bg-neutral-800 dark:hover:text-neutral-200'
                }`}
                title={workflow.enabled ? 'Click to disable triggers' : 'Click to enable triggers'}
              >
                {/* Inline mini-switch so the affordance reads as a toggle,
                    not a status pill. Thumb position + colour swap on
                    state. */}
                <span
                  className={`relative inline-block h-2.5 w-4 rounded-full transition ${
                    workflow.enabled
                      ? 'bg-emerald-400 group-hover:bg-emerald-500 dark:bg-emerald-500/60'
                      : 'bg-neutral-300 group-hover:bg-neutral-400 dark:bg-neutral-600'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 h-1.5 w-1.5 rounded-full bg-white shadow-sm transition-all dark:bg-neutral-100 ${
                      workflow.enabled ? 'left-2' : 'left-0.5'
                    }`}
                  />
                </span>
                {getWorkflowEnabledLabel(workflow.enabled)}
              </button>
              <span className="hidden shrink-0 font-mono text-[11px] text-neutral-500 sm:inline">
                dag/v1
              </span>
              {workflow.description && (
                <TooltipProvider delayDuration={250}>
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        tabIndex={0}
                        className="hidden min-w-0 cursor-default truncate rounded-sm text-xs text-neutral-500 outline-none focus-visible:ring-2 focus-visible:ring-violet-500/40 dark:text-neutral-400 xl:block"
                      >
                        {workflow.description}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent
                      side="bottom"
                      align="start"
                      sideOffset={8}
                      className="max-w-sm rounded-lg border border-neutral-200 bg-white px-3.5 py-3 text-sm leading-snug text-neutral-700 shadow-xl dark:border-neutral-800 dark:bg-neutral-950 dark:text-neutral-200"
                    >
                      {workflow.description}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
            </div>
          </div>
        </div>

        <div className="hidden rounded-lg border border-neutral-200 bg-neutral-100 p-1 shadow-inner dark:border-neutral-800 dark:bg-neutral-900 sm:flex">
          {editorTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                resetPublishConfirmation();
                setActiveTab(tab.id);
              }}
              className={`rounded-md px-4 py-2 text-sm transition ${
                activeTab === tab.id
                  ? 'bg-white text-neutral-950 shadow-sm dark:bg-neutral-800 dark:text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-950 dark:text-neutral-400 dark:hover:text-neutral-100'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        <div className="flex min-w-0 shrink-0 items-center justify-end gap-2">
          <Button
            variant="secondary"
            onClick={() => {
              resetPublishConfirmation();
              setVersionsDialogOpen(true);
            }}
            className="hidden border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800 xl:inline-flex"
          >
            Versions
          </Button>
          <Button
            variant="secondary"
            onClick={handleSaveClick}
            disabled={saveDraft.isPending || !editorDefinition}
            className="border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800"
          >
            {saveDraft.isPending ? 'Saving...' : 'Save draft'}
          </Button>
          <Button
            variant="secondary"
            onClick={openManualWorkflowDialog}
            disabled={testRun.isPending || saveDraft.isPending}
            className="hidden border border-neutral-200 bg-white text-neutral-800 hover:bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:hover:bg-neutral-800 sm:inline-flex"
          >
            {testRun.isPending || saveDraft.isPending ? 'Starting...' : 'Test'}
          </Button>
          <Button
            onClick={handlePublishClick}
            disabled={publishSubmitting || publish.isPending || saveDraft.isPending || validate.isPending}
            title={publishButton.title}
            className={
              publishButton.isConfirming
                ? 'bg-amber-500 text-white hover:bg-amber-600 dark:bg-amber-500 dark:hover:bg-amber-400'
                : undefined
            }
          >
            {publishButton.label}
          </Button>
          <Button
            variant="ghost"
            onClick={() => {
              resetPublishConfirmation();
              setDeleteDialogOpen(true);
            }}
            disabled={deleteWorkflow.isPending}
            className="text-neutral-500 hover:bg-neutral-100 hover:text-red-600 dark:text-neutral-400 dark:hover:bg-neutral-900 dark:hover:text-red-300"
            title="Delete workflow"
          >
            <MoreIcon />
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col">
        <div className="flex border-b border-neutral-200 bg-white p-1 dark:border-neutral-800 dark:bg-neutral-950 sm:hidden">
          {editorTabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => {
                resetPublishConfirmation();
                setActiveTab(tab.id);
              }}
              className={`flex-1 rounded-md px-2 py-1.5 text-sm ${
                activeTab === tab.id
                  ? 'bg-neutral-100 text-neutral-950 dark:bg-neutral-800 dark:text-neutral-100'
                  : 'text-neutral-500 dark:text-neutral-400'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {activeTab === 'editor' ? (
          draftLoading ? (
            <div className="p-4">
              <Skeleton className="h-[640px] w-full bg-neutral-200 dark:bg-neutral-800" />
            </div>
          ) : (
            <VisualWorkflowEditor
              definition={draftData?.draft ?? null}
              onDefinitionChange={setEditorDefinition}
              onTestRun={openManualWorkflowDialog}
              isTesting={testRun.isPending || saveDraft.isPending}
              className="min-h-0 flex-1 rounded-none border-0"
            />
          )
        ) : activeTab === 'executions' ? (
          <WorkflowExecutionViewer
            definition={draftData?.draft ?? null}
            execution={selectedExecution.data?.execution ?? null}
            executions={executions}
            isLoadingExecution={selectedExecution.isLoading}
            selectedExecutionId={selectedExecutionId}
            selectedNodeId={selectedExecutionNodeId}
            onSelectExecution={(executionId) => {
              setSelectedExecutionId(executionId);
              setSelectedExecutionNodeId(null);
            }}
            onSelectNode={setSelectedExecutionNodeId}
            onRetryExecution={handleRetryExecution}
            isRetryingExecution={retryExecution.isPending}
          />
        ) : (
          <div className="grid min-h-0 flex-1 place-items-center bg-neutral-50 p-5 dark:bg-neutral-950">
            <section className="w-full max-w-md rounded-lg border border-neutral-200 bg-white p-5 text-center dark:border-neutral-800 dark:bg-neutral-900/70">
              <h2 className="text-base font-medium text-neutral-950 dark:text-neutral-100">Test workflow</h2>
              <Button
                className="mt-5 bg-red-500 text-white hover:bg-red-600"
                onClick={openManualWorkflowDialog}
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
