/**
 * Step-cards entry point. Resolves a workflow step's type and dispatches to
 * the typed renderer; falls back to a generic JSON-tree card for unknown
 * types or rows from pre-Phase-B executions.
 *
 * Spec: docs/specs/2026-05-23-workflow-ui-design.md.
 */

import { useMemo } from 'react';
import { RotateCcw } from 'lucide-react';
import type { ExecutionStepTrace } from '@/api/executions';
import type { WorkflowData } from '@/api/workflows';
import { useRunWorkflow } from '@/api/workflows';
import { bump, WORKFLOW_TELEMETRY } from '@/lib/workflow-telemetry';
import { AgentPromptCard } from './agent-prompt-card';
import { ApprovalCard } from './approval-card';
import { BashCard } from './bash-card';
import { ConditionalCard } from './conditional-card';
import { FallbackCard } from './fallback-card';
import { LoopCard } from './loop-card';
import { NotifyCard } from './notify-card';
import { ParallelCard } from './parallel-card';
import { ToolCard } from './tool-card';

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

interface WorkflowStepCardEntryProps {
  step: ExecutionStepTrace;
  children?: TimelineNode[];
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  workflowDef?: WorkflowData | null;
}

export function WorkflowStepCard(props: WorkflowStepCardEntryProps) {
  const stepType = useMemo(
    () => resolveType(props.step, props.workflowDef),
    [props.step, props.workflowDef],
  );
  const enriched: WorkflowStepCardProps = { ...props, stepType };
  const card = dispatchCard(stepType, enriched);

  if (props.step.status !== 'failed') return card;
  return (
    <div className="flex flex-col gap-1">
      {card}
      <RetryFooter workflowId={props.workflowDef?.id} />
    </div>
  );
}

function dispatchCard(stepType: string, props: WorkflowStepCardProps) {
  switch (stepType) {
    case 'agent_prompt': return <AgentPromptCard {...props} />;
    case 'bash':         return <BashCard {...props} />;
    case 'notify':       return <NotifyCard {...props} />;
    case 'approval':     return <ApprovalCard {...props} />;
    case 'conditional':  return <ConditionalCard {...props} />;
    case 'loop':         return <LoopCard {...props} />;
    case 'parallel':     return <ParallelCard {...props} />;
    case 'tool':         return <ToolCard {...props} />;
    default:
      bump(WORKFLOW_TELEMETRY.FALLBACK_RENDERER_USED, { type: stepType });
      return <FallbackCard {...props} />;
  }
}

function RetryFooter({ workflowId }: { workflowId: string | undefined }) {
  // useRunWorkflow's onSuccess already navigates to the new execution, so we
  // just need to fire the mutation here.
  const run = useRunWorkflow();
  if (!workflowId) return null;
  return (
    <button
      type="button"
      onClick={() => run.mutate({ workflowId, variables: {} })}
      disabled={run.isPending}
      className="self-start font-mono text-[10px] px-2 py-1 rounded border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-white/[0.02] inline-flex items-center gap-1 disabled:opacity-50"
    >
      <RotateCcw className="w-3 h-3" />
      retry workflow
    </button>
  );
}

function resolveType(step: ExecutionStepTrace, workflowDef: WorkflowData | null | undefined): string {
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
