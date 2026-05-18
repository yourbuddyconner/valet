import { useState } from 'react';
import { createFileRoute } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { useTriggers, useDeleteTrigger, useEnableTrigger, useDisableTrigger, type Trigger } from '@/api/triggers';
import { useWorkflows } from '@/api/workflows';
import { TriggerCard } from '@/components/workflows/trigger-card';
import { CreateTriggerDialog } from '@/components/workflows/create-trigger-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/cn';

export const Route = createFileRoute('/automation/schedules-and-hooks/')({
  component: SchedulesAndHooksPage,
});

type Filter = 'all' | 'schedule' | 'webhook' | 'github' | 'manual';

function SchedulesAndHooksPage() {
  const { data: triggersData, isLoading } = useTriggers();
  const { data: workflowsData } = useWorkflows();
  const deleteTrigger = useDeleteTrigger();
  const enableTrigger = useEnableTrigger();
  const disableTrigger = useDisableTrigger();
  const [filter, setFilter] = useState<Filter>('all');
  const [createOpen, setCreateOpen] = useState(false);
  const [editingTrigger, setEditingTrigger] = useState<Trigger | null>(null);

  const triggers = triggersData?.triggers ?? [];
  const workflows = workflowsData?.workflows ?? [];
  const workflowName = (id: string | null) =>
    id ? workflows.find(w => w.id === id)?.name : undefined;

  const filtered = filter === 'all' ? triggers : triggers.filter(t => t.type === filter);

  const counts = {
    all: triggers.length,
    schedule: triggers.filter(t => t.type === 'schedule').length,
    webhook: triggers.filter(t => t.type === 'webhook').length,
    github: triggers.filter(t => t.type === 'github').length,
    manual: triggers.filter(t => t.type === 'manual').length,
  };

  return (
    <div className="px-6 py-5 bg-surface-0">
      <div className="mb-1 text-xs text-neutral-500 tracking-wider">AUTOMATION</div>
      <div className="flex items-baseline justify-between mb-1">
        <h1 className="text-2xl font-semibold text-foreground">Schedules &amp; Hooks</h1>
        <Button variant="primary" size="sm" onClick={() => setCreateOpen(true)}>
          <Plus className="w-3.5 h-3.5 mr-1" />
          New trigger
        </Button>
      </div>
      <p className="text-sm text-neutral-500 dark:text-neutral-400 mb-5">
        Schedules, webhooks, GitHub events, and manual triggers.
      </p>

      <FilterPills active={filter} counts={counts} onChange={setFilter} />

      {isLoading ? (
        <div className="flex flex-col gap-3 mt-4">
          {Array.from({ length: 3 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-sm text-neutral-500 mt-6">No triggers yet.</div>
      ) : (
        <div className="flex flex-col gap-3 mt-4">
          {filtered.map((t: Trigger) => (
            <TriggerCard
              key={t.id}
              trigger={t}
              workflowName={workflowName(t.workflowId)}
              onEdit={t.type === 'manual' ? undefined : () => setEditingTrigger(t)}
              onToggleEnabled={() =>
                t.enabled
                  ? disableTrigger.mutate(t.id)
                  : enableTrigger.mutate(t.id)
              }
              onDelete={() => {
                if (confirm(`Delete trigger "${t.name}"?`)) {
                  deleteTrigger.mutate({ triggerId: t.id, workflowId: t.workflowId });
                }
              }}
            />
          ))}
        </div>
      )}

      <CreateTriggerDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      {/* Edit mode reuses the same dialog. Keyed by trigger id so internal
          state (form path + per-form `useMemo` initial values) re-derives
          when switching which trigger we're editing. */}
      <CreateTriggerDialog
        key={editingTrigger?.id ?? 'no-edit'}
        open={!!editingTrigger}
        onClose={() => setEditingTrigger(null)}
        editing={editingTrigger ?? undefined}
      />
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
    { id: 'github', label: 'GitHub' },
    { id: 'manual', label: 'Manual' },
  ];
  return (
    <div className="inline-flex bg-surface-2 rounded-full p-0.5">
      {items.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          aria-pressed={id === active}
          className={cn(
            'px-3 py-1 text-[11px] uppercase tracking-wider font-mono rounded-full transition-colors',
            id === active
              ? 'bg-surface-0 text-foreground shadow-panel'
              : 'text-neutral-500 hover:text-foreground',
          )}
        >
          {label} · {counts[id]}
        </button>
      ))}
    </div>
  );
}
