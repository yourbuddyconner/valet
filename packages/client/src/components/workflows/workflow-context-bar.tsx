import { Link } from '@tanstack/react-router';
import { useExecution, useExecutionSteps } from '@/api/executions';

interface Props {
  executionId: string;
}

/**
 * Slim bar above the chat for workflow-driven sessions. Shows execution state
 * and links to the full execution detail page.
 *
 * Persists for the life of the session — once a session is a workflow session
 * it stays one. Terminal executions show the final status here.
 */
export function WorkflowContextBar({ executionId }: Props) {
  const { data: execData } = useExecution(executionId);
  const execution = execData?.execution;
  const isTerminal = execution
    ? ['completed', 'failed', 'cancelled'].includes(execution.status)
    : false;
  const { data: stepsData } = useExecutionSteps(executionId, { isTerminal });
  if (!execution) return null;

  const topLevelSteps = (stepsData?.steps ?? []).filter((s) => s.iterationPath === '');
  const done = topLevelSteps.filter((s) =>
    ['completed', 'failed', 'skipped'].includes(s.status),
  ).length;
  const total = topLevelSteps.length;
  const wfName = execution.workflowName ?? 'workflow';

  return (
    <div
      role="status"
      aria-label={`workflow ${wfName} — step ${done} of ${total}`}
      className="flex items-center gap-3 px-3 py-1.5 border-b border-border bg-surface-1 text-xs font-mono shrink-0"
    >
      <span className="font-semibold text-foreground truncate max-w-[40%]">{wfName}</span>
      <span className="text-neutral-500">{executionId.slice(0, 8)}</span>
      {total > 0 && (
        <>
          <span className="text-neutral-500">step {done} / {total}</span>
          <div className="flex gap-0.5" aria-hidden="true">
            {topLevelSteps.map((s) => (
              <span
                key={`${s.stepId}#${s.iterationPath}`}
                className={`h-1.5 w-3 rounded ${dotColor(s.status)}`}
                title={`${s.stepId} · ${s.status}`}
              />
            ))}
          </div>
        </>
      )}
      <Link
        to="/automation/executions/$executionId"
        params={{ executionId }}
        className="ml-auto text-accent hover:underline"
      >
        execution ↗
      </Link>
    </div>
  );
}

function dotColor(status: string): string {
  switch (status) {
    case 'completed': return 'bg-emerald-500';
    case 'failed':    return 'bg-red-500';
    case 'running':   return 'bg-amber-500';
    case 'cancelled': return 'bg-neutral-500';
    case 'skipped':   return 'bg-neutral-400';
    default:          return 'bg-neutral-300 dark:bg-neutral-700';
  }
}
