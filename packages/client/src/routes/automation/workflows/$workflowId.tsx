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

export const Route = createFileRoute('/automation/workflows/$workflowId')({
  component: WorkflowDetailPage,
});

function WorkflowDetailPage() {
  const { workflowId } = Route.useParams();
  const nav = useNavigate();
  const { data, isLoading } = useWorkflow(workflowId);
  const workflow = data?.workflow;
  const { data: triggersData } = useTriggers();
  const del = useDeleteWorkflow();
  const update = useUpdateWorkflow();
  const run = useRunWorkflow();
  const deleteTrigger = useDeleteTrigger();
  const enableTrigger = useEnableTrigger();
  const disableTrigger = useDisableTrigger();

  if (isLoading || !workflow) {
    return <div className="p-6 text-sm text-neutral-500">Loading…</div>;
  }

  const triggers = (triggersData?.triggers ?? []).filter((t) => t.workflowId === workflow.id);

  return (
    <div className="flex flex-col h-full">
      <WorkflowDetailHeader
        workflow={workflow}
        onRun={() => run.mutate({ workflowId: workflow.id })}
        // TODO: enable when /automation/workflows/new route is added (Task 6.6 / 6.10)
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
      <div className="flex-1 overflow-y-auto p-6 space-y-8">
        <Section title="Definition">
          <div className="h-[480px]">
            <WorkflowDiagram workflow={workflow.data} mode="view" />
          </div>
        </Section>

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
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-base font-semibold text-neutral-900 mb-3">{title}</h2>
      {children}
    </section>
  );
}
