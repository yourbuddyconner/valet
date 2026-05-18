import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Link } from '@tanstack/react-router';
import {
  useExecution,
  useExecutionSteps,
  useCancelExecution,
} from '@/api/executions';
import { useExecutionStepEvents } from '@/hooks/use-execution-step-events';
import { ExecutionStepTracePanel } from './execution-step-trace';
import { ExecutionVariablesPanel } from './execution-variables-panel';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface Props {
  executionId: string;
  sessionId: string | null;
  onClose: () => void;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds}s`;
  return `${minutes}m ${seconds.toString().padStart(2, '0')}s`;
}

function statusBadgeVariant(status: string | undefined): 'default' | 'secondary' {
  if (!status) return 'secondary';
  if (status === 'completed') return 'default';
  return 'secondary';
}

/**
 * Floating side panel that streams a test/dry workflow execution.
 * Reuses the same execution detail data sources (steps + step events) used by the
 * full execution page, so behavior is consistent.
 */
export function TestRunPanel({ executionId, sessionId, onClose }: Props) {
  const { data: execData } = useExecution(executionId);
  const { data: stepsData } = useExecutionSteps(executionId);
  const cancel = useCancelExecution();

  useExecutionStepEvents(sessionId, executionId);

  const execution = execData?.execution;
  const status = execution?.status;
  const isRunning = !!status && !TERMINAL_STATUSES.has(status);

  // Track elapsed time; pin to completedAt once terminal so the badge stops counting.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!isRunning) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [isRunning]);

  const startedAtMs = execution?.startedAt ? Date.parse(execution.startedAt) : null;
  const completedAtMs = execution?.completedAt ? Date.parse(execution.completedAt) : null;
  const elapsedMs =
    startedAtMs == null
      ? 0
      : (completedAtMs ?? now) - startedAtMs;

  return (
    <div className="fixed inset-y-0 right-0 z-40 w-full max-w-[480px] bg-surface-1 border-l border-border shadow-xl flex flex-col">
      <header className="flex items-center justify-between px-4 py-3 border-b border-border">
        <div className="flex items-center gap-2 min-w-0">
          <div className="text-xs uppercase tracking-wider text-neutral-500">Test run</div>
          <Badge variant={statusBadgeVariant(status)}>{status ?? 'pending'}</Badge>
          {startedAtMs != null && (
            <span className="text-xs text-neutral-500 font-mono">{formatElapsed(elapsedMs)}</span>
          )}
        </div>
        <button
          onClick={onClose}
          aria-label="Close test run panel"
          className="text-neutral-500 hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" strokeWidth={1.5} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-4 space-y-5">
        {execution?.error && (
          <div className="bg-red-500/10 border border-red-500/30 text-red-600 dark:text-red-400 text-xs px-3 py-2 rounded font-mono">
            {execution.error}
          </div>
        )}

        <div>
          <div className="text-[11px] tracking-wider text-neutral-500 mb-2">STEP TRACE</div>
          {execution ? (
            <ExecutionStepTracePanel
              steps={stepsData?.steps ?? []}
              startedAt={execution.startedAt}
            />
          ) : (
            <div className="text-xs text-neutral-500">Waiting for execution to start…</div>
          )}
        </div>

        <div>
          <div className="text-[11px] tracking-wider text-neutral-500 mb-2">STEP OUTPUTS</div>
          <ExecutionVariablesPanel outputs={execution?.outputs ?? null} />
        </div>
      </div>

      <footer className="border-t border-border p-3 flex items-center gap-2">
        {isRunning && (
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={() => cancel.mutate({ executionId, data: { reason: 'Test run cancelled' } })}
            disabled={cancel.isPending}
          >
            Cancel
          </Button>
        )}
        <Link
          to="/automation/executions/$executionId"
          params={{ executionId }}
          className="text-xs text-accent hover:underline"
        >
          Open full execution →
        </Link>
        <div className="flex-1" />
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          Close
        </Button>
      </footer>
    </div>
  );
}
