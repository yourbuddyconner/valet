import { useEffect, useRef } from 'react';
import { Check, X, MinusCircle, Play } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ExecutionStepTrace } from '@/api/executions';
import type { StepRuntimeStatus } from './workflow-diagram/types';
import { STATUS_TEXT_COLOR } from './state-tokens';

interface Props {
  steps: ExecutionStepTrace[];
  startedAt: string;
}

export function ExecutionStepTracePanel({ steps, startedAt }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    containerRef.current?.scrollTo({ top: containerRef.current.scrollHeight });
  }, [steps]);

  const start = new Date(startedAt).getTime();
  const sorted = [...steps].sort((a, b) =>
    (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt),
  );

  return (
    <div
      ref={containerRef}
      className="font-mono text-xs leading-relaxed text-neutral-700 dark:text-neutral-300 bg-surface-2 border border-border rounded-lg p-2.5 max-h-72 overflow-y-auto"
    >
      <div className="flex items-center gap-1 text-emerald-600 dark:text-emerald-400 animate-fade-in">
        <span>[{fmtElapsed(0)}]</span>
        <Play className="w-3 h-3 inline-block" />
        <span>START</span>
      </div>
      {sorted.map((s) => (
        <StepTraceLines key={s.id} step={s} startMs={start} />
      ))}
    </div>
  );
}

function statusIcon(status: ExecutionStepTrace['status']): LucideIcon {
  if (status === 'completed') return Check;
  if (status === 'failed') return X;
  return MinusCircle;
}

function StepTraceLines({ step, startMs }: { step: ExecutionStepTrace; startMs: number }) {
  // Narrow step.input (unknown) to safely extract a `type` field for display.
  const stepInput = step.input;
  const stepType =
    stepInput !== null &&
    typeof stepInput === 'object' &&
    'type' in stepInput &&
    typeof (stepInput as { type: unknown }).type === 'string'
      ? (stepInput as { type: string }).type.toUpperCase()
      : 'STEP';

  // Map step.status to the broader runtime-status union for color lookup.
  const runtimeStatus = step.status as StepRuntimeStatus;
  const colorCls = STATUS_TEXT_COLOR[runtimeStatus] ?? 'text-neutral-500';

  const Icon = statusIcon(step.status);

  return (
    <div className="animate-fade-in">
      {step.startedAt && (
        <div className="text-neutral-700 dark:text-neutral-300">
          [{fmtElapsed(new Date(step.startedAt).getTime() - startMs)}] {stepType} · {step.stepId}
        </div>
      )}
      {step.completedAt && (
        <>
          <div className={`flex items-center gap-1 ${colorCls}`}>
            <span>[{fmtElapsed(new Date(step.completedAt).getTime() - startMs)}]</span>
            <Icon className="w-3 h-3 inline-block" />
            <span>
              {step.stepId} {step.status}
            </span>
          </div>
          {step.error && (
            <div className="text-red-600 dark:text-red-400 whitespace-pre-wrap break-words">
              {`        ↳ ${step.error}`}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function fmtElapsed(ms: number): string {
  const safeMs = Math.max(0, ms);
  const s = Math.floor(safeMs / 1000);
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  const millis = String(safeMs % 1000).padStart(3, '0');
  return `${mm}:${ss}.${millis}`;
}
