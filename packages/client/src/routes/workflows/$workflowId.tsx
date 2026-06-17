import { useEffect, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { PageContainer, PageHeader } from '@/components/layout/page-container';
import {
  useWorkflow,
  useWorkflowDraft,
  useSaveWorkflowDraft,
  usePublishWorkflow,
  useValidateWorkflowDraft,
  useTestRunWorkflow,
  useWorkflowVersions,
  useRestoreWorkflowVersion,
} from '@/api/workflows';
import { useWorkflowExecutions } from '@/api/executions';
import { ExecutionApprovalPanel } from '@/components/workflows/execution-approval-panel';
import { VisualWorkflowEditor } from '@/components/workflows/visual-workflow-editor';
import type { WorkflowDefinition } from '@valet/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { toastError, toastSuccess } from '@/hooks/use-toast';
import { formatRelativeTime } from '@/lib/format';

export const Route = createFileRoute('/workflows/$workflowId')({
  component: WorkflowDetailPage,
});

function WorkflowDetailPage() {
  const { workflowId } = Route.useParams();
  const { data, isLoading, error } = useWorkflow(workflowId);
  const { data: draftData, isLoading: draftLoading } = useWorkflowDraft(workflowId);
  const { data: versionsData } = useWorkflowVersions(workflowId);
  const { data: executionsData } = useWorkflowExecutions(workflowId);

  const saveDraft = useSaveWorkflowDraft();
  const publish = usePublishWorkflow();
  const validate = useValidateWorkflowDraft();
  const testRun = useTestRunWorkflow();
  const restoreVersion = useRestoreWorkflowVersion();

  const workflow = data?.workflow;
  const [editorDefinition, setEditorDefinition] = useState<WorkflowDefinition | null>(null);

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

  function handleSave(draft: WorkflowDefinition) {
    saveDraft.mutate(
      { workflowId, draft: draft as unknown as Record<string, unknown> },
      {
        onSuccess: () => toastSuccess('Draft saved'),
        onError: (err) =>
          toastError(err instanceof Error ? err.message : 'Failed to save draft'),
      },
    );
  }

  async function saveCurrentEditorDraft() {
    if (!editorDefinition) return;
    await saveDraft.mutateAsync({
      workflowId,
      draft: editorDefinition as unknown as Record<string, unknown>,
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

  const versions = versionsData?.versions ?? [];
  const executions = executionsData?.executions ?? [];

  return (
    <PageContainer>
      <PageHeader
        title={workflow.name}
        description={workflow.description ?? undefined}
        actions={
          <>
            <Button
              variant="secondary"
              onClick={handleTestRun}
              disabled={testRun.isPending || saveDraft.isPending}
            >
              {testRun.isPending || saveDraft.isPending ? 'Starting...' : 'Test run'}
            </Button>
            <Button onClick={handlePublish} disabled={publish.isPending || saveDraft.isPending}>
              {publish.isPending || saveDraft.isPending ? 'Publishing...' : 'Publish'}
            </Button>
          </>
        }
      />

      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              Draft (dag/v1)
            </h2>
            {draftData?.publishedVersionId ? (
              <Badge variant="success">Has published version</Badge>
            ) : (
              <Badge variant="secondary">Unpublished</Badge>
            )}
          </div>
        </div>
        {draftLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : (
          <VisualWorkflowEditor
            definition={draftData?.draft ?? null}
            isSaving={saveDraft.isPending}
            onDefinitionChange={setEditorDefinition}
            onSave={handleSave}
          />
        )}
      </section>

      <section className="mt-8 grid gap-6 md:grid-cols-2">
        <div>
          <h2 className="mb-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
            Versions
          </h2>
          {versions.length === 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              No published versions yet.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-700 dark:border-neutral-700">
              {versions.map((v) => (
                <li
                  key={v.id}
                  className="flex items-center justify-between gap-2 p-3 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="font-medium text-neutral-900 dark:text-neutral-100">
                      v{v.version}
                    </div>
                    {v.publishNote && (
                      <div className="text-pretty text-neutral-500 dark:text-neutral-400">
                        {v.publishNote}
                      </div>
                    )}
                    <div className="tabular-nums text-neutral-400">
                      {formatRelativeTime(v.createdAt)}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => handleRestore(v.id)}
                    disabled={restoreVersion.isPending}
                  >
                    Restore
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div>
          <h2 className="mb-2 text-sm font-medium text-neutral-900 dark:text-neutral-100">
            Recent executions
          </h2>
          {executions.length === 0 ? (
            <p className="text-xs text-neutral-500 dark:text-neutral-400">
              No executions yet.
            </p>
          ) : (
            <ul className="divide-y divide-neutral-200 rounded-md border border-neutral-200 dark:divide-neutral-700 dark:border-neutral-700">
              {executions.slice(0, 10).map((exec) => (
                <li key={exec.id} className="space-y-2 p-3 text-xs">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <Badge variant={executionBadgeVariant(exec.status)}>
                          {exec.status}
                        </Badge>
                        <span className="truncate font-mono text-neutral-500">
                          {exec.id.slice(0, 8)}
                        </span>
                      </div>
                      <div className="mt-1 tabular-nums text-neutral-400">
                        {formatRelativeTime(exec.startedAt)}
                      </div>
                    </div>
                    {exec.error && (
                      <span
                        className="line-clamp-2 max-w-[40%] text-pretty text-red-500"
                        title={exec.error}
                      >
                        {exec.error}
                      </span>
                    )}
                  </div>
                  {isActiveExecutionStatus(exec.status) && (
                    // Mount on any active status, not just waiting_approval:
                    // parallel approval / tool-policy nodes can leave the
                    // aggregate status at 'running' while individual nodes
                    // are pending. The panel polls
                    // /api/executions/:id/approvals and auto-hides when
                    // there's no pending row.
                    <ExecutionApprovalPanel executionId={exec.id} variant="inline" />
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <div className="mt-8 text-xs text-neutral-500 dark:text-neutral-400">
        <Link to="/automation/workflows" className="underline">
          Back to workflows
        </Link>
      </div>
    </PageContainer>
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
