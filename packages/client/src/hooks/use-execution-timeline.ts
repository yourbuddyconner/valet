import { useMemo } from 'react';
import type { ExecutionStepTrace } from '@/api/executions';
import type { WorkflowData, WorkflowStep } from '@/api/workflows';
import { bump, WORKFLOW_TELEMETRY } from '@/lib/workflow-telemetry';
import type { TimelineNode } from '@/components/workflows/step-cards';

export type { TimelineNode };

/**
 * Merge the static workflow definition with the execution's step rows into a
 * recursive tree the timeline renders. Static steps that haven't produced a
 * row yet become placeholder nodes with status='pending' so the UI shows the
 * shape of an in-flight run.
 *
 * Memoized on (workflowDef, stepRows) — both should be stable references from
 * react-query when not mutating.
 */
export function useExecutionTimeline(
  workflowDef: WorkflowData | null | undefined,
  stepRows: ExecutionStepTrace[] | undefined,
): TimelineNode[] {
  return useMemo(
    () => buildTimelineViewModel(workflowDef ?? null, stepRows ?? []),
    [workflowDef, stepRows],
  );
}

export function buildTimelineViewModel(
  workflowDef: WorkflowData | null,
  stepRows: ExecutionStepTrace[],
): TimelineNode[] {
  if (!workflowDef) {
    // Source workflow deleted with no snapshot — render flat in createdAt order.
    return [...stepRows]
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
      .map((s) => ({ step: s }));
  }

  const placedKeys = new Set<string>();
  const nodes = buildLevel(workflowDef.steps, '', stepRows, placedKeys);

  // Surface orphan rows (events arrived for steps the static def doesn't know).
  for (const r of stepRows) {
    if (!placedKeys.has(`${r.stepId}#${r.iterationPath}`)) {
      bump(WORKFLOW_TELEMETRY.ORPHAN_STEP_ROW, {
        stepId: r.stepId,
        iterationPath: r.iterationPath,
      });
    }
  }

  return nodes;
}

function buildLevel(
  defSteps: WorkflowStep[],
  parentIterationPath: string,
  allRows: ExecutionStepTrace[],
  placedKeys: Set<string>,
): TimelineNode[] {
  const out: TimelineNode[] = [];
  // Once a step at this level has failed/cancelled, subsequent steps with no
  // row aren't pending — they'll never run. Suppress their placeholders so
  // we don't show ghost "awaiting approval" cards after a real failure.
  let halted = false;

  for (const defStep of defSteps) {
    const row = allRows.find(
      (r) => r.stepId === defStep.id && r.iterationPath === parentIterationPath,
    );

    if (!row) {
      if (halted) continue;
      out.push({ step: makePlaceholderRow(defStep, parentIterationPath), placeholder: true });
      continue;
    }
    placedKeys.add(`${row.stepId}#${row.iterationPath}`);
    // Halt-on-failure: failed/cancelled at this level means nothing downstream
    // runs, so suppress later placeholders. `skipped` is intentionally NOT a
    // halt — it's used by retry-from-step replay to mark prior-success steps.
    if (row.status === 'failed' || row.status === 'cancelled') {
      halted = true;
    }

    if (defStep.type === 'loop') {
      const prefix = parentIterationPath
        ? `${parentIterationPath}/${defStep.id}:i`
        : `${defStep.id}:i`;
      const iterIndexes = collectIndexes(allRows, prefix);
      const children: TimelineNode[] = [];
      for (const i of iterIndexes) {
        const childParent = parentIterationPath
          ? `${parentIterationPath}/${defStep.id}:i${i}`
          : `${defStep.id}:i${i}`;
        children.push(...buildLevel(defStep.steps ?? [], childParent, allRows, placedKeys));
      }
      out.push({ step: row, children });
    } else if (defStep.type === 'parallel') {
      // In a parallel step, `steps[i]` IS branch i — each child step is a
      // distinct branch, not all of them per branch.
      const branchSteps = (defStep.steps ?? []) as WorkflowStep[];
      const children: TimelineNode[] = [];
      for (let i = 0; i < branchSteps.length; i++) {
        const childParent = parentIterationPath
          ? `${parentIterationPath}/${defStep.id}:b${i}`
          : `${defStep.id}:b${i}`;
        children.push(...buildLevel([branchSteps[i]!], childParent, allRows, placedKeys));
      }
      out.push({ step: row, children });
    } else if (defStep.type === 'conditional') {
      const thenPrefix = parentIterationPath
        ? `${parentIterationPath}/${defStep.id}:then`
        : `${defStep.id}:then`;
      const elsePrefix = parentIterationPath
        ? `${parentIterationPath}/${defStep.id}:else`
        : `${defStep.id}:else`;
      const children: TimelineNode[] = [];
      if (allRows.some((r) => r.iterationPath === thenPrefix || r.iterationPath.startsWith(`${thenPrefix}/`))) {
        children.push(...buildLevel((defStep.then ?? []) as WorkflowStep[], thenPrefix, allRows, placedKeys));
      } else if (allRows.some((r) => r.iterationPath === elsePrefix || r.iterationPath.startsWith(`${elsePrefix}/`))) {
        children.push(...buildLevel((defStep.else ?? []) as WorkflowStep[], elsePrefix, allRows, placedKeys));
      }
      out.push({ step: row, children });
    } else {
      out.push({ step: row });
    }
  }

  return out;
}

function collectIndexes(rows: ExecutionStepTrace[], prefix: string): number[] {
  const seen = new Set<number>();
  for (const r of rows) {
    if (!r.iterationPath.startsWith(prefix)) continue;
    const tail = r.iterationPath.slice(prefix.length);
    const end = tail.indexOf('/');
    const numStr = end >= 0 ? tail.slice(0, end) : tail;
    const n = Number(numStr);
    if (Number.isInteger(n) && n >= 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

function makePlaceholderRow(
  defStep: WorkflowStep,
  iterationPath: string,
): ExecutionStepTrace {
  return {
    id: `placeholder-${defStep.id}-${iterationPath}`,
    executionId: '',
    stepId: defStep.id,
    attempt: 0,
    iterationPath,
    status: 'pending',
    // ExecutionStepTrace.input is `unknown | null`; assigning a WorkflowStep
    // directly is fine — the renderer reads `input.type` and `input.persona`
    // / `input.prompt` etc. via narrowing, and a WorkflowStep already has the
    // same shape.
    input: defStep,
    output: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: '',
    workflowStepIndex: null,
    sequence: 0,
  };
}
