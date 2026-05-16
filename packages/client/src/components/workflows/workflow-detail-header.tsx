import type { ButtonHTMLAttributes } from 'react';
import type { Workflow } from '@/api/workflows';
import { cn } from '@/lib/cn';

interface Props {
  workflow: Workflow;
  onEdit?: () => void;
  onRun?: () => void;
  onToggleEnabled?: () => void;
  onDelete?: () => void;
}

export function WorkflowDetailHeader({ workflow, onEdit, onRun, onToggleEnabled, onDelete }: Props) {
  return (
    <div className="px-6 py-4 bg-white border-b border-neutral-200">
      <div className="text-xs text-neutral-500 tracking-wider mb-1">AUTOMATION / WORKFLOWS</div>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-semibold text-neutral-900">{workflow.name}</h1>
            <span
              className={cn(
                'text-[11px] px-2 py-0.5 rounded-full font-medium',
                workflow.enabled ? 'bg-emerald-50 text-emerald-800' : 'bg-neutral-100 text-neutral-500',
              )}
            >
              {workflow.enabled ? '● Enabled' : '○ Disabled'}
            </span>
          </div>
          {workflow.description && (
            <div className="text-sm text-neutral-600 mt-1.5">{workflow.description}</div>
          )}
          <div className="text-xs text-neutral-500 mt-1.5">
            slug: <code className="bg-neutral-100 px-1 py-0.5 rounded">{workflow.slug ?? '—'}</code> · v
            {workflow.version} · updated {new Date(workflow.updatedAt).toLocaleString()}
          </div>
        </div>
        <div className="flex gap-2">
          {onRun && <Btn onClick={onRun}>▶ Run now</Btn>}
          {onEdit && <Btn onClick={onEdit}>✎ Edit</Btn>}
          {onToggleEnabled && (
            <Btn onClick={onToggleEnabled}>{workflow.enabled ? 'Disable' : 'Enable'}</Btn>
          )}
          {onDelete && (
            <Btn variant="danger" onClick={onDelete}>
              Delete
            </Btn>
          )}
        </div>
      </div>
    </div>
  );
}

function Btn({
  variant,
  className,
  ...rest
}: { variant?: 'danger' } & ButtonHTMLAttributes<HTMLButtonElement>) {
  const v =
    variant === 'danger'
      ? 'bg-red-50 text-red-800 border-red-200 hover:bg-red-100'
      : 'bg-white text-neutral-700 border-neutral-300 hover:bg-neutral-50';
  return (
    <button
      {...rest}
      className={cn('text-sm px-3 py-1.5 rounded-md border font-medium', v, className)}
    />
  );
}
