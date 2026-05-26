/**
 * Step-cards entry point. The full byStepType dispatcher lives below in
 * `WorkflowStepCard`; this file also exports the shared
 * `WorkflowStepCardProps` interface that every typed renderer consumes.
 *
 * Spec: docs/specs/2026-05-23-workflow-ui-design.md.
 */

import type { ExecutionStepTrace } from '@/api/executions';
import type { WorkflowData } from '@/api/workflows';
import { FallbackCard } from './fallback-card';

/**
 * A node in the recursive timeline tree. Containers (loop/parallel/conditional)
 * carry their iteration/branch children here so the renderer can walk down
 * without re-querying the flat step rows.
 *
 * Defined here so that container cards can reference TimelineNode in their
 * `children` prop without creating a circular import with use-execution-timeline.
 */
export interface TimelineNode {
  step: ExecutionStepTrace;
  children?: TimelineNode[];
  /** True when the static def has this step but no row exists yet. */
  placeholder?: boolean;
}

export interface WorkflowStepCardProps {
  step: ExecutionStepTrace;
  /** Resolved by the dispatcher from the workflow def + step.input.type. */
  stepType: string;
  /** Container child rows if this is a loop/parallel/conditional. */
  children?: TimelineNode[];
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  workflowDef?: WorkflowData | null;
}

/**
 * Stub dispatcher. Real implementation lands in C13 once all per-type
 * renderers (C5-C12) are in place.
 */
export function WorkflowStepCard(props: Omit<WorkflowStepCardProps, 'stepType'>) {
  const stepType = resolveType(props.step, props.workflowDef);
  return <FallbackCard {...props} stepType={stepType} />;
}

function resolveType(step: ExecutionStepTrace, workflowDef?: WorkflowData | null): string {
  // Prefer the static workflow definition; fall back to step.input.type
  // (already parsed unknown — no JSON.parse needed).
  if (workflowDef) {
    const fromDef = findStepType(workflowDef.steps as Array<Record<string, unknown>>, step.stepId);
    if (fromDef) return fromDef;
  }
  if (step.input && typeof step.input === 'object' && !Array.isArray(step.input)) {
    const t = (step.input as { type?: unknown }).type;
    if (typeof t === 'string') return t;
  }
  return 'fallback';
}

function findStepType(steps: Array<Record<string, unknown>>, id: string): string | null {
  for (const s of steps) {
    if (s.id === id && typeof s.type === 'string') return s.type;
    for (const subList of [s.then, s.else, s.steps]) {
      if (Array.isArray(subList)) {
        const t = findStepType(subList as Array<Record<string, unknown>>, id);
        if (t) return t;
      }
    }
  }
  return null;
}
