import { useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { useTriggers, useDeleteTrigger, useEnableTrigger, useDisableTrigger, type Trigger } from '@/api/triggers';
import { useWorkflows } from '@/api/workflows';
import { TriggerCard } from '@/components/workflows/trigger-card';

export const Route = createFileRoute('/automation/schedules-and-hooks/')({
  component: SchedulesAndHooksPage,
});

type Filter = 'all' | 'schedule' | 'webhook' | 'manual';

function SchedulesAndHooksPage() {
  const { data: triggersData, isLoading } = useTriggers();
  const { data: workflowsData } = useWorkflows();
  const deleteTrigger = useDeleteTrigger();
  const enableTrigger = useEnableTrigger();
  const disableTrigger = useDisableTrigger();
  const [filter, setFilter] = useState<Filter>('all');

  const triggers = triggersData?.triggers ?? [];
  const workflows = workflowsData?.workflows ?? [];
  const workflowName = (id: string | null) =>
    id ? workflows.find(w => w.id === id)?.name : undefined;

  const filtered = filter === 'all' ? triggers : triggers.filter(t => t.type === filter);

  const counts = {
    all: triggers.length,
    schedule: triggers.filter(t => t.type === 'schedule').length,
    webhook: triggers.filter(t => t.type === 'webhook').length,
    manual: triggers.filter(t => t.type === 'manual').length,
  };

  return (
    <div className="px-6 py-5">
      <div className="mb-1 text-xs text-neutral-500 tracking-wider">AUTOMATION</div>
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-2xl font-semibold text-neutral-900">Schedules &amp; Hooks</h1>
        <Link
          to="/automation/workflows/new"
          search={{ editId: undefined }}
          className="px-4 py-1.5 rounded-lg bg-neutral-900 text-white text-sm font-medium hover:bg-neutral-800"
        >
          + New trigger
        </Link>
      </div>
      <p className="text-sm text-neutral-600 mb-5">
        Things that run on a schedule, fire from a webhook, or run on demand.
      </p>

      <FilterPills active={filter} counts={counts} onChange={setFilter} />

      {isLoading ? (
        <div className="text-sm text-neutral-500 mt-6">Loading…</div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-neutral-500 mt-6">No triggers yet.</div>
      ) : (
        <div className="flex flex-col gap-3 mt-4">
          {filtered.map((t: Trigger) => (
            <TriggerCard
              key={t.id}
              trigger={t}
              workflowName={workflowName(t.workflowId)}
              onToggleEnabled={() =>
                t.enabled
                  ? disableTrigger.mutate(t.id)
                  : enableTrigger.mutate(t.id)
              }
              onDelete={() => {
                if (confirm(`Delete trigger "${t.name}"?`)) {
                  deleteTrigger.mutate(t.id);
                }
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function FilterPills({
  active,
  counts,
  onChange,
}: {
  active: Filter;
  counts: Record<Filter, number>;
  onChange: (f: Filter) => void;
}) {
  const items: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'schedule', label: 'Schedules' },
    { id: 'webhook', label: 'Webhooks' },
    { id: 'manual', label: 'Manual' },
  ];
  return (
    <div className="flex gap-2">
      {items.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          aria-pressed={id === active}
          className={
            'text-xs px-3 py-1 rounded-full cursor-pointer ' +
            (id === active
              ? 'bg-neutral-900 text-white'
              : 'bg-neutral-100 text-neutral-600 hover:bg-neutral-200')
          }
        >
          {label} · {counts[id]}
        </button>
      ))}
    </div>
  );
}
