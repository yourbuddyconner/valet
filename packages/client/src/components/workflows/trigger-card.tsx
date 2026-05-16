import type { Trigger } from '@/api/triggers';
import { humanizeCron } from './cron-humanize';
import { cn } from '@/lib/cn';
import { formatRelativeTime } from '@/lib/format';

const TYPE_META: Record<Trigger['type'], { label: string; classes: string; icon: string }> = {
  schedule: { label: 'SCHEDULE', classes: 'bg-indigo-100 text-indigo-800', icon: '◷' },
  webhook: { label: 'WEBHOOK', classes: 'bg-amber-100 text-amber-800', icon: '⚡' },
  manual: { label: 'MANUAL', classes: 'bg-neutral-100 text-neutral-700', icon: '▶' },
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

  const conditionLine = renderCondition(trigger);
  const targetLine = renderTarget(trigger, workflowName);
  const activityLine = renderActivity(trigger);

  return (
    <div
      className={cn(
        'flex gap-3.5 p-4 rounded-xl border bg-white',
        disabled ? 'opacity-50 border-neutral-200' : 'border-neutral-200',
      )}
    >
      <div className="text-2xl text-neutral-500 pt-0.5">{meta.icon}</div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 mb-1">
          <span className={cn('text-[10px] font-bold tracking-wider px-1.5 py-0.5 rounded', meta.classes)}>
            {meta.label}
          </span>
          <span className="font-semibold text-neutral-900 truncate">{trigger.name}</span>
          <span
            className={cn(
              'text-[11px] px-2 py-0.5 rounded font-medium',
              trigger.enabled ? 'bg-emerald-50 text-emerald-800' : 'bg-neutral-100 text-neutral-500',
            )}
          >
            {trigger.enabled ? '● Enabled' : '○ Disabled'}
          </span>
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
      <div className="text-sm text-neutral-700 mb-1">
        {human ?? cron}
        {tz && <span className="text-neutral-500"> ({tz})</span>}
        <span className="text-neutral-400 font-mono ml-2 cursor-default" title={`Raw: ${cron}`}>·</span>
      </div>
    );
  }
  if (trigger.type === 'webhook' && trigger.config.type === 'webhook') {
    return (
      <div className="text-sm text-neutral-700 mb-1 font-mono">
        {trigger.config.method ?? 'POST'} /webhooks/{trigger.config.path}
      </div>
    );
  }
  if (trigger.type === 'manual') {
    return <div className="text-sm text-neutral-700 mb-1">Run manually</div>;
  }
  return null;
}

function renderTarget(trigger: Trigger, workflowName?: string) {
  if (trigger.type === 'schedule' && trigger.config.type === 'schedule' && trigger.config.target === 'orchestrator') {
    return (
      <div className="text-sm text-indigo-700">
        → Sends prompt to your <strong>orchestrator</strong>
      </div>
    );
  }
  if (workflowName) {
    return (
      <div className="text-sm text-amber-800">
        → Runs workflow: <strong>{workflowName}</strong>
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
        <button onClick={onEdit} className="text-xs text-neutral-500 hover:text-neutral-900 px-1">Edit</button>
      )}
      {onToggleEnabled && (
        <button onClick={onToggleEnabled} className="text-xs text-neutral-500 hover:text-neutral-900 px-1">
          {trigger.enabled ? 'Disable' : 'Enable'}
        </button>
      )}
      {onDelete && (
        <button onClick={onDelete} className="text-xs text-red-600 hover:text-red-800 px-1">Delete</button>
      )}
    </div>
  );
}
