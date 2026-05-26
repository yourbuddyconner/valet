import { useCallback, useEffect, useState } from 'react';
import type { ExecutionStepTrace } from '@/api/executions';
import type { WorkflowData } from '@/api/workflows';
import { useExecutionTimeline } from '@/hooks/use-execution-timeline';
import { WorkflowStepCard } from './step-cards';

interface Props {
  workflowDef: WorkflowData | null;
  stepRows: ExecutionStepTrace[];
  /**
   * Optional notifier — receives the cardKey of the step most-in-view.
   * Used by the diagram rail to highlight the corresponding node.
   */
  onHighlightedStepChange?: (key: string | null) => void;
}

export function ExecutionTimeline({ workflowDef, stepRows, onHighlightedStepChange }: Props) {
  const timeline = useExecutionTimeline(workflowDef, stepRows);
  const [openMap, setOpenMap] = useState<Map<string, boolean>>(() => new Map());
  const [seenFailures, setSeenFailures] = useState<Set<string>>(() => new Set());

  // Auto-expand on a failure transition. We track which failures we've already
  // expanded so re-renders don't keep slamming them open after a manual collapse.
  useEffect(() => {
    let changedOpen = false;
    let changedSeen = false;
    const nextOpen = new Map(openMap);
    const nextSeen = new Set(seenFailures);
    for (const row of stepRows) {
      if (row.status !== 'failed') continue;
      const key = cardKey(row);
      if (nextSeen.has(key)) continue;
      nextSeen.add(key);
      changedSeen = true;
      if (!nextOpen.get(key)) {
        nextOpen.set(key, true);
        changedOpen = true;
      }
    }
    if (changedSeen) setSeenFailures(nextSeen);
    if (changedOpen) setOpenMap(nextOpen);
    // We deliberately depend on stepRows identity; openMap/seenFailures are
    // read-then-write inside, no need to retrigger on them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stepRows]);

  const setOpen = useCallback((key: string, next: boolean) => {
    setOpenMap((prev) => {
      const out = new Map(prev);
      out.set(key, next);
      return out;
    });
  }, []);

  return (
    <div
      className="flex flex-col gap-2 p-3 overflow-y-auto"
      data-component="execution-timeline"
    >
      {timeline.length === 0 && (
        <p className="font-mono text-[11px] text-neutral-500">No steps yet.</p>
      )}
      {timeline.map((node) => {
        const key = cardKey(node.step);
        return (
          <div
            key={key}
            data-step-key={key}
            ref={makeIntersectionRef(key, onHighlightedStepChange)}
          >
            <WorkflowStepCard
              step={node.step}
              children={node.children}
              open={openMap.get(key) ?? false}
              onOpenChange={(next) => setOpen(key, next)}
              workflowDef={workflowDef}
            />
          </div>
        );
      })}
    </div>
  );
}

export function cardKey(row: { stepId: string; iterationPath: string }): string {
  return `${row.stepId}#${row.iterationPath}`;
}

// Callback-ref creates a per-element IntersectionObserver. Cheap for the timeline
// sizes we expect (<<200 cards); revisit if perf shows up as an issue.
function makeIntersectionRef(
  key: string,
  onChange: ((key: string | null) => void) | undefined,
): (el: HTMLDivElement | null) => void {
  return (el) => {
    if (!el || !onChange) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onChange(key);
        }
      },
      { threshold: 0.6 },
    );
    observer.observe(el);
  };
}
