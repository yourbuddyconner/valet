import { useState } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
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

  if (isLoading) {
    return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  }
  if (error || !workflow) {
    return (
      <div className="p-6">
        <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / WORKFLOWS</div>
        <h1 className="text-xl font-semibold text-neutral-900">Workflow not found</h1>
        <p className="text-sm text-neutral-600 mt-2">
          This workflow may have been deleted, or the link may be incorrect.
        </p>
      </div>
    );
  }

  const triggers = (triggersData?.triggers ?? []).filter((t) => t.workflowId === workflow.id);

  return (
    <div className="flex flex-col h-full">
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
        <div className="flex-1 min-w-0 p-6 lg:overflow-auto lg:flex lg:flex-col">
          <Section title="Definition" className="lg:flex-1 lg:min-h-0 lg:flex lg:flex-col">
            <div className="h-[640px] lg:h-auto lg:flex-1 lg:min-h-[480px]">
              <WorkflowDiagram workflow={workflow.data} mode="view" />
            </div>
          </Section>
        </div>
        <div className="w-full lg:w-[380px] lg:border-l border-neutral-200 p-6 lg:overflow-auto space-y-8">
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
                    onDelete={() => deleteTrigger.mutate(t.id)}
                  />
                ))}
              </div>
            )}
          </Section>

          <Section title="Recent executions">
            <RecentExecutionsSection workflowId={workflow.id} />
          </Section>
        </div>
      </div>
      {showRunDialog && (
        <RunWorkflowDialog
          workflow={workflow}
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
      <h2 className="text-base font-semibold text-neutral-900 mb-3">{title}</h2>
      {children}
    </section>
  );
}
