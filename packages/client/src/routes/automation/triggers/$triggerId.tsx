import { Fragment, useState } from 'react';
import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowRight, ChevronDown, ChevronRight, Clock, GitBranch, Play, Webhook } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import {
  useTrigger,
  useTriggerDeliveries,
  useDeleteTrigger,
  useEnableTrigger,
  useDisableTrigger,
  useTestFireTrigger,
  type Trigger,
  type TriggerDelivery,
  type TriggerDeliveryOutcome,
} from '@/api/triggers';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { formatRelativeTime } from '@/lib/format';
import { cn } from '@/lib/cn';
import { humanizeCron } from '@/components/workflows/cron-humanize';
import { toastError, toastSuccess, toastWarning } from '@/hooks/use-toast';

export const Route = createFileRoute('/automation/triggers/$triggerId')({
  component: TriggerDetailPage,
});

const TYPE_META: Record<Trigger['type'], { label: string; classes: string; icon: LucideIcon }> = {
  schedule: { label: 'SCHEDULE', classes: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400', icon: Clock },
  webhook: { label: 'WEBHOOK', classes: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', icon: Webhook },
  manual: { label: 'MANUAL', classes: 'bg-surface-3 text-neutral-600 dark:text-neutral-400', icon: Play },
  github: { label: 'GITHUB', classes: 'bg-violet-500/10 text-violet-600 dark:text-violet-400', icon: GitBranch },
};

type OutcomeVariant = 'default' | 'success' | 'warning' | 'error' | 'secondary';

const OUTCOME_META: Record<TriggerDeliveryOutcome, { label: string; variant: OutcomeVariant }> = {
  matched: { label: 'Matched', variant: 'success' },
  no_match: { label: 'No match', variant: 'secondary' },
  duplicate: { label: 'Duplicate', variant: 'secondary' },
  concurrency_cap: { label: 'Rate limited', variant: 'warning' },
  workflow_deleted: { label: 'No workflow', variant: 'warning' },
  error: { label: 'Error', variant: 'error' },
};

function TriggerDetailPage() {
  const { triggerId } = Route.useParams();
  const navigate = useNavigate();
  const { data: triggerData, isLoading, error } = useTrigger(triggerId);
  const { data: deliveriesData, isLoading: deliveriesLoading } = useTriggerDeliveries(triggerId);

  const deleteTrigger = useDeleteTrigger();
  const enableTrigger = useEnableTrigger();
  const disableTrigger = useDisableTrigger();
  const testFire = useTestFireTrigger();

  if (isLoading) {
    return (
      <div className="flex flex-col h-full bg-surface-0">
        <div className="px-4 py-2.5 bg-surface-0 border-b border-border">
          <div className="flex items-center gap-2.5 h-7">
            <Skeleton className="h-5 w-48" />
            <Skeleton className="h-5 w-20" />
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
  if (error || !triggerData) {
    return (
      <div className="p-6 bg-surface-0">
        <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / TRIGGERS</div>
        <h1 className="text-xl font-semibold text-foreground">Trigger not found</h1>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-2">
          This trigger may have been deleted, or the link may be incorrect.
        </p>
      </div>
    );
  }

  const trigger = triggerData.trigger;
  const meta = TYPE_META[trigger.type];
  const Icon = meta.icon;
  const deliveries = deliveriesData?.deliveries ?? [];

  const handleToggle = () => {
    if (trigger.enabled) disableTrigger.mutate(trigger.id);
    else enableTrigger.mutate(trigger.id);
  };

  const handleDelete = () => {
    if (!confirm(`Delete trigger "${trigger.name}"?`)) return;
    deleteTrigger.mutate(
      { triggerId: trigger.id, workflowId: trigger.workflowId },
      {
        onSuccess: () => navigate({ to: '/automation/schedules-and-hooks' }),
      },
    );
  };

  const handleTestFire = () => {
    testFire.mutate(
      { triggerId: trigger.id },
      {
        onSuccess: (data) => {
          if (data.outcome === 'matched') {
            toastSuccess(
              'Test fire dispatched',
              data.executionId ? 'Execution queued. Click to view.' : 'Dispatched successfully.',
            );
            if (data.executionId) {
              navigate({ to: '/automation/executions/$executionId', params: { executionId: data.executionId } });
            }
            return;
          }
          // Non-error, non-matched outcomes (no_match, duplicate, concurrency_cap,
          // workflow_deleted) are surfaced as warnings — the dispatcher ran and
          // logged a row, but no execution was created.
          if (data.outcome === 'error') {
            toastError('Test fire failed', data.reason ?? 'Unknown error');
            return;
          }
          toastWarning(`Test fire: ${data.outcome.replace('_', ' ')}`, data.reason ?? undefined);
        },
        onError: (err) => {
          const msg = err instanceof Error ? err.message : 'Unknown error';
          toastError('Test fire failed', msg);
        },
      },
    );
  };

  // Manual triggers have their own Run button; test-fire is for the three
  // event-driven types where the dispatcher path is what we want to exercise.
  const canTestFire = trigger.type === 'github' || trigger.type === 'webhook' || trigger.type === 'schedule';

  return (
    <div className="flex flex-col h-full bg-surface-0">
      <div className="px-4 py-2.5 bg-surface-0 border-b border-border">
        <div className="flex items-center justify-between gap-4 h-7">
          <div className="flex items-center gap-2.5 min-w-0">
            <Icon className="w-4 h-4 text-neutral-500 shrink-0" />
            <h1 className="text-base font-semibold text-foreground truncate">{trigger.name}</h1>
            <span className={cn('text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded', meta.classes)}>
              {meta.label}
            </span>
            <Badge variant={trigger.enabled ? 'success' : 'secondary'}>
              {trigger.enabled ? 'Enabled' : 'Disabled'}
            </Badge>
          </div>
          <div className="flex gap-1.5">
            {canTestFire && (
              <Button
                variant="ghost"
                size="sm"
                onClick={handleTestFire}
                disabled={testFire.isPending || !trigger.enabled}
                title={trigger.enabled ? 'Send a synthetic payload through the dispatcher' : 'Enable the trigger first'}
              >
                {testFire.isPending ? 'Sending…' : 'Test fire'}
              </Button>
            )}
            <Button variant="ghost" size="sm" onClick={handleToggle}>
              {trigger.enabled ? 'Disable' : 'Enable'}
            </Button>
            <Button variant="ghost" size="sm" onClick={handleDelete} className="text-red-500 hover:text-red-600 hover:bg-red-500/10">
              Delete
            </Button>
          </div>
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-neutral-500">
          <Link to="/automation/schedules-and-hooks" className="hover:text-foreground transition-colors">
            ← All triggers
          </Link>
          {trigger.workflowId && trigger.workflowName && (
            <Link
              to="/automation/workflows/$workflowId"
              params={{ workflowId: trigger.workflowId }}
              className="inline-flex items-center gap-1 text-amber-700 dark:text-amber-400 hover:underline"
            >
              <ArrowRight className="w-3 h-3" />
              {trigger.workflowName}
            </Link>
          )}
          {trigger.lastRunAt && (
            <span>Last run: <strong>{formatRelativeTime(trigger.lastRunAt)}</strong></span>
          )}
        </div>
      </div>

      <div className="flex-1 overflow-auto p-4">
        <div className="grid gap-4 lg:grid-cols-[2fr_1fr]">
          <DeliveriesPanel deliveries={deliveries} isLoading={deliveriesLoading} triggerType={trigger.type} />
          <ConfigSummary trigger={trigger} />
        </div>
      </div>
    </div>
  );
}

function DeliveriesPanel({
  deliveries,
  isLoading,
  triggerType,
}: {
  deliveries: TriggerDelivery[];
  isLoading: boolean;
  triggerType: Trigger['type'];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <section className="rounded-xl border border-border bg-surface-1">
      <div className="px-4 py-2.5 border-b border-border flex items-center justify-between">
        <h2 className="text-sm font-semibold text-foreground">Recent deliveries</h2>
        <span className="text-xs text-neutral-500">{deliveries.length} shown</span>
      </div>
      {isLoading ? (
        <div className="p-4 space-y-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-3/4" />
        </div>
      ) : deliveries.length === 0 ? (
        <div className="p-6 text-sm text-neutral-500 text-center">
          No deliveries yet. {emptyHint(triggerType)}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-[11px] uppercase tracking-wider text-neutral-500">
              <tr className="border-b border-border">
                <th className="text-left font-medium px-3 py-2 w-8"></th>
                <th className="text-left font-medium px-3 py-2">Time</th>
                <th className="text-left font-medium px-3 py-2">Outcome</th>
                <th className="text-left font-medium px-3 py-2">Event</th>
                <th className="text-left font-medium px-3 py-2">Detail</th>
              </tr>
            </thead>
            <tbody>
              {deliveries.map((d) => {
                const isOpen = expanded === d.id;
                const om = OUTCOME_META[d.outcome];
                return (
                  <Fragment key={d.id}>
                    <tr
                      className="border-b border-border last:border-0 hover:bg-surface-2 cursor-pointer"
                      onClick={() => setExpanded(isOpen ? null : d.id)}
                    >
                      <td className="px-3 py-2 align-top text-neutral-500">
                        {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
                      </td>
                      <td className="px-3 py-2 align-top whitespace-nowrap text-neutral-700 dark:text-neutral-300">
                        {formatRelativeTime(d.receivedAt)}
                      </td>
                      <td className="px-3 py-2 align-top">
                        <Badge variant={om.variant}>{om.label}</Badge>
                      </td>
                      <td className="px-3 py-2 align-top font-mono text-xs text-neutral-600 dark:text-neutral-400">
                        {d.eventType ?? '—'}
                      </td>
                      <td className="px-3 py-2 align-top text-xs">
                        {d.outcome === 'matched' && d.executionId ? (
                          <Link
                            to="/automation/executions/$executionId"
                            params={{ executionId: d.executionId }}
                            className="text-accent hover:underline inline-flex items-center gap-1"
                            onClick={(e) => e.stopPropagation()}
                          >
                            View execution
                            <ArrowRight className="w-3 h-3" />
                          </Link>
                        ) : (
                          <span className="text-neutral-600 dark:text-neutral-400 line-clamp-1">
                            {d.reason ?? '—'}
                          </span>
                        )}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-border last:border-0 bg-surface-0">
                        <td colSpan={5} className="px-4 py-3 text-xs space-y-2">
                          <DeliveryDetail delivery={d} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function DeliveryDetail({ delivery }: { delivery: TriggerDelivery }) {
  return (
    <div className="space-y-2">
      <div className="grid grid-cols-2 gap-2 text-xs">
        <KV label="Received" value={new Date(delivery.receivedAt).toLocaleString()} />
        <KV label="Outcome" value={OUTCOME_META[delivery.outcome].label} />
        <KV label="Event" value={delivery.eventType ?? '—'} mono />
        <KV label="Delivery ID" value={delivery.deliveryId ?? '—'} mono />
        {delivery.executionId && <KV label="Execution" value={delivery.executionId} mono />}
        {delivery.reason && <KV label="Reason" value={delivery.reason} />}
      </div>
      {delivery.payloadPreview && (
        <div>
          <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-1">Payload preview</div>
          <pre className="text-[11px] font-mono bg-surface-2 p-2 rounded border border-border overflow-x-auto max-h-64 whitespace-pre-wrap">
            {formatPayload(delivery.payloadPreview)}
          </pre>
        </div>
      )}
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div>
      <div className="text-[11px] uppercase tracking-wider text-neutral-500">{label}</div>
      <div className={cn('text-foreground break-all', mono && 'font-mono text-xs')}>{value}</div>
    </div>
  );
}

function formatPayload(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw;
  }
}

function emptyHint(type: Trigger['type']): string {
  switch (type) {
    case 'github':
      return 'This trigger fires when GitHub delivers a matching event.';
    case 'webhook':
      return 'This trigger fires when its configured URL is called.';
    case 'schedule':
      return 'This trigger fires on its configured cron schedule.';
    case 'manual':
      return 'This trigger only fires from manual runs.';
  }
}

function ConfigSummary({ trigger }: { trigger: Trigger }) {
  return (
    <aside className="rounded-xl border border-border bg-surface-1">
      <div className="px-4 py-2.5 border-b border-border">
        <h2 className="text-sm font-semibold text-foreground">Configuration</h2>
      </div>
      <div className="p-4 space-y-3 text-sm">
        {renderConfig(trigger)}
        {trigger.variableMapping && Object.keys(trigger.variableMapping).length > 0 && (
          <div>
            <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-1">Variable mapping</div>
            <div className="space-y-1">
              {Object.entries(trigger.variableMapping).map(([k, v]) => (
                <div key={k} className="flex items-center gap-2 text-xs">
                  <code className="font-mono bg-surface-2 px-1.5 py-0.5 rounded">{k}</code>
                  <span className="text-neutral-500">←</span>
                  <code className="font-mono text-neutral-600 dark:text-neutral-400">{v}</code>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}

function renderConfig(trigger: Trigger) {
  if (trigger.type === 'schedule' && trigger.config.type === 'schedule') {
    const cron = trigger.config.cron;
    const human = humanizeCron(cron);
    return (
      <>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-1">Schedule</div>
          <div className="text-foreground">{human ?? cron}</div>
          <div className="text-xs font-mono text-neutral-500 mt-0.5">{cron}</div>
        </div>
        {trigger.config.timezone && (
          <KV label="Timezone" value={trigger.config.timezone} />
        )}
        {trigger.config.target === 'orchestrator' ? (
          <div>
            <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-1">Target</div>
            <div className="text-indigo-600 dark:text-indigo-400">Orchestrator prompt</div>
            {trigger.config.prompt && (
              <pre className="mt-1 text-xs whitespace-pre-wrap text-neutral-700 dark:text-neutral-300 bg-surface-2 p-2 rounded border border-border max-h-40 overflow-y-auto">
                {trigger.config.prompt}
              </pre>
            )}
          </div>
        ) : (
          <KV label="Target" value="Workflow" />
        )}
      </>
    );
  }
  if (trigger.type === 'webhook' && trigger.config.type === 'webhook') {
    return (
      <>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-1">Webhook URL</div>
          <code className="font-mono text-xs break-all text-foreground">
            {trigger.config.method ?? 'POST'} /webhooks/{trigger.config.path}
          </code>
          {trigger.webhookUrl && (
            <div className="text-xs text-neutral-500 mt-1 break-all">{trigger.webhookUrl}</div>
          )}
        </div>
        {trigger.config.secret && (
          <KV label="Secret" value="Configured" />
        )}
      </>
    );
  }
  if (trigger.type === 'github' && trigger.config.type === 'github') {
    const cfg = trigger.config;
    return (
      <>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-1">Repositories</div>
          <div className="flex flex-wrap gap-1">
            {cfg.repos.map((r) => (
              <Badge key={r} variant="secondary" className="!font-mono !normal-case !tracking-normal">
                {r}
              </Badge>
            ))}
          </div>
        </div>
        <div>
          <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-1">Events</div>
          <div className="flex flex-wrap gap-1">
            {cfg.events.map((e) => (
              <Badge key={e} variant="secondary" className="!font-mono !normal-case !tracking-normal">
                {e}
              </Badge>
            ))}
          </div>
        </div>
        {cfg.filter && (cfg.filter.branch || cfg.filter.labels || cfg.filter.actions) && (
          <div>
            <div className="text-[11px] uppercase tracking-wider text-neutral-500 mb-1">Filters</div>
            <div className="space-y-1 text-xs">
              {cfg.filter.actions && cfg.filter.actions.length > 0 && (
                <div>actions: <code className="font-mono">{cfg.filter.actions.join(', ')}</code></div>
              )}
              {cfg.filter.branch && (
                <div>branch: <code className="font-mono">{Array.isArray(cfg.filter.branch) ? cfg.filter.branch.join(', ') : cfg.filter.branch}</code></div>
              )}
              {cfg.filter.labels && cfg.filter.labels.length > 0 && (
                <div>labels: <code className="font-mono">{cfg.filter.labels.join(', ')}</code></div>
              )}
            </div>
          </div>
        )}
      </>
    );
  }
  if (trigger.type === 'manual') {
    return <div className="text-sm text-neutral-700 dark:text-neutral-300">Runs only via the manual run API or UI.</div>;
  }
  return null;
}
