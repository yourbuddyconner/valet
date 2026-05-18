import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { PanelRightClose, PanelRightOpen } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  useWorkflow,
  useDeleteWorkflow,
  useUpdateWorkflow,
  useRunWorkflow,
} from '@/api/workflows';
import {
  useTriggers,
  useDeleteTrigger,
  useEnableTrigger,
  useDisableTrigger,
} from '@/api/triggers';
import { WorkflowDiagram } from '@/components/workflows/workflow-diagram';
import { WorkflowDetailHeader } from '@/components/workflows/workflow-detail-header';
import { TriggerCard } from '@/components/workflows/trigger-card';
import { RecentExecutionsSection } from '@/components/workflows/recent-executions-section';
import { RunWorkflowDialog } from '@/components/workflows/run-workflow-dialog';
import { WorkflowHistorySection } from '@/components/workflows/workflow-history-section';
import { Skeleton } from '@/components/ui/skeleton';

export const Route = createFileRoute('/automation/workflows/$workflowId')({
  component: WorkflowDetailPage,
});

function WorkflowDetailPage() {
  const { workflowId } = Route.useParams();
  const nav = useNavigate();
  const { data, isLoading, error } = useWorkflow(workflowId);
  const workflow = data?.workflow;
  const { data: triggersData } = useTriggers();
  const del = useDeleteWorkflow();
  const update = useUpdateWorkflow();
  const run = useRunWorkflow();
  const deleteTrigger = useDeleteTrigger();
  const enableTrigger = useEnableTrigger();
  const disableTrigger = useDisableTrigger();
  const [showRunDialog, setShowRunDialog] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-surface-0">
        <div className="px-4 py-2.5 bg-surface-0 border-b border-border">
          <div className="flex items-center gap-2.5 h-7">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-16" />
          </div>
          <div className="mt-1">
            <Skeleton className="h-3 w-64" />
          </div>
        </div>
        <div className="flex-1 p-4">
          <Skeleton className="h-full w-full" />
        </div>
      </div>
    );
  }
  if (error || !workflow) {
    return (
      <div className="p-6 bg-surface-0">
        <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / WORKFLOWS</div>
        <h1 className="text-xl font-semibold text-foreground">Workflow not found</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-2">
          This workflow may have been deleted, or the link may be incorrect.
        </p>
      </div>
    );
  }

  const triggers = (triggersData?.triggers ?? []).filter((t) => t.workflowId === workflow.id);

  return (
    <div className="flex flex-col h-full bg-surface-0">
      <WorkflowDetailHeader
        workflow={workflow}
        onRun={() => {
          const hasVars =
            workflow.data.variables && Object.keys(workflow.data.variables).length > 0;
          if (hasVars) {
            setShowRunDialog(true);
          } else {
            run.mutate({ workflowId: workflow.id });
          }
        }}
        onEdit={() => nav({ to: '/automation/workflows/new', search: { editId: workflow.id } })}
        onToggleEnabled={() =>
          update.mutate({ workflowId: workflow.id, enabled: !workflow.enabled })
        }
        onDelete={() => {
          if (confirm(`Delete workflow "${workflow.name}"?`)) {
            del.mutate(workflow.id, {
              onSuccess: () => nav({ to: '/automation/workflows' }),
            });
          }
        }}
      />
      <div className="flex-1 min-h-0 flex flex-col lg:flex-row overflow-auto lg:overflow-hidden">
        <div className="flex-1 min-w-0 p-4 lg:overflow-hidden lg:flex lg:flex-col min-h-0 relative">
          <div className="h-[640px] lg:h-auto lg:flex-1 lg:min-h-0">
            <WorkflowDiagram workflow={workflow.data} mode="view" />
          </div>
          {!sidebarOpen && (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => setSidebarOpen(true)}
              className="!absolute top-3 right-3 z-10 hidden lg:inline-flex"
              aria-label="Show details"
            >
              <PanelRightOpen className="w-3.5 h-3.5 mr-1" />
              Details
            </Button>
          )}
        </div>
        {sidebarOpen && (
        <div className="w-full lg:w-[380px] lg:border-l border-border p-4 lg:overflow-auto space-y-6 relative">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSidebarOpen(false)}
            className="!absolute top-2 right-2 !h-6 !w-6 !p-0 hidden lg:inline-flex"
            aria-label="Hide details"
          >
            <PanelRightClose className="w-3.5 h-3.5" />
          </Button>
          <Section title={`Triggers (${triggers.length})`}>
            {triggers.length === 0 ? (
              <div className="text-sm text-neutral-500">No triggers attached.</div>
            ) : (
              <div className="flex flex-col gap-3">
                {triggers.map((t) => (
                  <TriggerCard
                    key={t.id}
                    trigger={t}
                    workflowName={workflow.name}
                    onToggleEnabled={() =>
                      t.enabled ? disableTrigger.mutate(t.id) : enableTrigger.mutate(t.id)
                    }
                    onDelete={() =>
                      deleteTrigger.mutate({ triggerId: t.id, workflowId: workflow.id })
                    }
                  />
                ))}
              </div>
            )}
          </Section>

          <Section title="Recent executions">
            <RecentExecutionsSection workflowId={workflow.id} />
          </Section>

          <Section title="Version history">
            <WorkflowHistorySection workflowId={workflow.id} />
          </Section>
        </div>
        )}
      </div>
      {showRunDialog && (
        <RunWorkflowDialog
          name={workflow.name}
          variables={workflow.data.variables ?? {}}
          loading={run.isPending}
          onClose={() => setShowRunDialog(false)}
          onConfirm={(variables) => {
            run.mutate(
              { workflowId: workflow.id, variables },
              { onSuccess: () => setShowRunDialog(false) },
            );
          }}
        />
      )}
    </div>
  );
}

function Section({
  title,
  children,
  className,
}: {
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <h2 className="text-base font-semibold text-foreground mb-3">{title}</h2>
      {children}
    </section>
  );
}
