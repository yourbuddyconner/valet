import { useEffect, useRef } from 'react';
import type { ExecutionStepTrace } from '@/api/executions';

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
      className="font-mono text-xs leading-relaxed text-neutral-700 bg-neutral-50 border border-neutral-200 rounded-lg p-2.5 max-h-72 overflow-y-auto"
    >
      <div className="text-emerald-700">[{fmtElapsed(0)}] ▶ START</div>
      {sorted.map((s) => (
        <StepTraceLines key={s.id} step={s} startMs={start} />
      ))}
    </div>
  );
}

function StepTraceLines({ step, startMs }: { step: ExecutionStepTrace; startMs: number }) {
  const lines: { text: string; cls: string }[] = [];
  if (step.startedAt) {
    // Narrow step.input (unknown) to safely extract a `type` field for display.
    const stepInput = step.input;
    const stepType =
      stepInput !== null &&
      typeof stepInput === 'object' &&
      'type' in stepInput &&
      typeof (stepInput as { type: unknown }).type === 'string'
        ? (stepInput as { type: string }).type.toUpperCase()
        : 'STEP';
    lines.push({
      text: `[${fmtElapsed(new Date(step.startedAt).getTime() - startMs)}] ${stepType} · ${step.stepId}`,
      cls: 'text-neutral-700',
    });
  }
  if (step.completedAt) {
    const sym = step.status === 'completed' ? '✓' : step.status === 'failed' ? '✗' : '⊘';
    const cls =
      step.status === 'completed'
        ? 'text-emerald-700'
        : step.status === 'failed'
          ? 'text-red-700'
          : 'text-neutral-500';
    lines.push({
      text: `[${fmtElapsed(new Date(step.completedAt).getTime() - startMs)}] ${sym} ${step.stepId} ${step.status}`,
      cls,
    });
    if (step.error) {
      lines.push({
        text: `        ↳ ${step.error}`,
        cls: 'text-red-700 whitespace-pre-wrap break-words',
      });
    }
  }
  return (
    <>
      {lines.map((l, i) => (
        <div key={i} className={l.cls}>
          {l.text}
        </div>
      ))}
    </>
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
