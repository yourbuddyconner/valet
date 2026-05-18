import { Clock, Webhook, Play, ArrowRight } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { Trigger } from '@/api/triggers';
import { humanizeCron } from './cron-humanize';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

// Refactored from icon: string (unicode glyph) to icon: LucideIcon component
// so trigger-type icons match the rest of the brand pass.
const TYPE_META: Record<Trigger['type'], { label: string; classes: string; icon: LucideIcon }> = {
  schedule: { label: 'SCHEDULE', classes: 'bg-indigo-500/10 text-indigo-600 dark:text-indigo-400', icon: Clock },
  webhook: { label: 'WEBHOOK', classes: 'bg-amber-500/10 text-amber-600 dark:text-amber-400', icon: Webhook },
  manual: { label: 'MANUAL', classes: 'bg-surface-3 text-neutral-600 dark:text-neutral-400', icon: Play },
};

interface TriggerCardProps {
  trigger: Trigger;
  workflowName?: string;
  onEdit?: () => void;
  onToggleEnabled?: () => void;
  onDelete?: () => void;
}

export function TriggerCard({ trigger, workflowName, onEdit, onToggleEnabled, onDelete }: TriggerCardProps) {
  const meta = TYPE_META[trigger.type];
  const disabled = !trigger.enabled;
  const Icon = meta.icon;

  const conditionLine = renderCondition(trigger);
  const targetLine = renderTarget(trigger, workflowName);
  const activityLine = renderActivity(trigger);

  return (
    <div
      className={cn(
        'flex gap-3.5 p-4 rounded-xl border bg-surface-1 transition-colors hover:bg-surface-2',
        disabled ? 'opacity-50 border-border' : 'border-border',
      )}
    >
      <div className="text-neutral-500 pt-0.5">
        <Icon className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={cn('text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded', meta.classes)}>
            {meta.label}
          </span>
          <span className="font-semibold text-foreground truncate">{trigger.name}</span>
          <Badge variant={trigger.enabled ? 'success' : 'secondary'}>
            {trigger.enabled ? 'Enabled' : 'Disabled'}
          </Badge>
        </div>
        {conditionLine}
        {targetLine}
        {activityLine && <div className="text-xs text-neutral-500 mt-1.5 flex gap-3.5">{activityLine}</div>}
      </div>
      <TriggerActionsMenu
        trigger={trigger}
        onEdit={onEdit}
        onToggleEnabled={onToggleEnabled}
        onDelete={onDelete}
      />
    </div>
  );
}

function renderCondition(trigger: Trigger) {
  if (trigger.type === 'schedule' && trigger.config.type === 'schedule') {
    const cron = trigger.config.cron;
    const tz = trigger.config.timezone;
    const human = humanizeCron(cron);
    return (
      <div className="text-sm text-neutral-700 dark:text-neutral-300 mb-1">
        {human ?? cron}
        {tz && <span className="text-neutral-500"> ({tz})</span>}
        <span className="text-neutral-400 font-mono ml-2 cursor-default" title={`Raw: ${cron}`}>·</span>
      </div>
    );
  }
  if (trigger.type === 'webhook' && trigger.config.type === 'webhook') {
    return (
      <div className="text-sm text-neutral-700 dark:text-neutral-300 mb-1 font-mono">
        {trigger.config.method ?? 'POST'} /webhooks/{trigger.config.path}
      </div>
    );
  }
  if (trigger.type === 'manual') {
    return <div className="text-sm text-neutral-700 dark:text-neutral-300 mb-1">Run manually</div>;
  }
  return null;
}

function renderTarget(trigger: Trigger, workflowName?: string) {
  if (trigger.type === 'schedule' && trigger.config.type === 'schedule' && trigger.config.target === 'orchestrator') {
    return (
      <div className="text-sm text-indigo-600 dark:text-indigo-400 inline-flex items-center gap-1">
        <ArrowRight className="w-3 h-3 inline-block" />
        Sends prompt to your <strong>orchestrator</strong>
      </div>
    );
  }
  if (workflowName) {
    return (
      <div className="text-sm text-amber-700 dark:text-amber-400 inline-flex items-center gap-1">
        <ArrowRight className="w-3 h-3 inline-block" />
        Runs workflow: <strong>{workflowName}</strong>
      </div>
    );
  }
  return null;
}

function renderActivity(trigger: Trigger) {
  if (!trigger.lastRunAt) return null;
  return (
    <>
      <span>Last run: <strong>{formatRelativeTime(trigger.lastRunAt)}</strong></span>
    </>
  );
}

function TriggerActionsMenu({ trigger, onEdit, onToggleEnabled, onDelete }: {
  trigger: Trigger;
  onEdit?: () => void;
  onToggleEnabled?: () => void;
  onDelete?: () => void;
}) {
  return (
    <div className="flex gap-1">
      {onEdit && (
        <Button variant="ghost" size="sm" onClick={onEdit}>
          Edit
        </Button>
      )}
      {onToggleEnabled && (
        <Button variant="ghost" size="sm" onClick={onToggleEnabled}>
          {trigger.enabled ? 'Disable' : 'Enable'}
        </Button>
      )}
      {onDelete && (
        <Button
          variant="ghost"
          size="sm"
          onClick={onDelete}
          className="text-red-500 hover:text-red-600 hover:bg-red-500/10"
        >
          Delete
        </Button>
      )}
    </div>
  );
}
