import dagre from 'dagre';
import type { Node, Edge } from '@xyflow/react';
import type { WorkflowData, WorkflowStep } from '@/api/workflows';
import type { WorkflowNodeData, SyntheticNodeData, DiagramMode } from './types';

const NODE_WIDTH = 260;
const NODE_HEIGHT = 80;

type AnyNodeData = WorkflowNodeData | SyntheticNodeData;

interface LayoutOptions {
  mode?: DiagramMode;
  runtimeStatus?: Record<string, import('./types').StepRuntimeStatus>;
  currentStepId?: string;
  stepErrors?: Record<string, string>;
  onNodeClick?: (stepId: string) => void;
}

/**
 * Walk the workflow JSON tree, emitting flat nodes + edges with dagre-computed positions.
 * Synthetic node IDs use a `__name__` convention so they never collide with user step IDs.
 */
export function layoutWorkflow(
  workflow: WorkflowData,
  opts: LayoutOptions = {},
): { nodes: Node<AnyNodeData>[]; edges: Edge[] } {
  const nodes: Node<AnyNodeData>[] = [];
  const edges: Edge[] = [];

  const startId = '__start__';
  const endId = '__end__';

  nodes.push({
    id: startId,
    type: 'synthetic',
    position: { x: 0, y: 0 },
    data: { kind: 'start', label: 'START' },
  });
  nodes.push({
    id: endId,
    type: 'synthetic',
    position: { x: 0, y: 0 },
    data: { kind: 'end', label: 'END' },
  });

  function walk(steps: WorkflowStep[], prevTails: string[]): string[] {
    let tails = prevTails;
    for (const step of steps) {
      const nodeData: WorkflowNodeData = {
        step,
        mode: opts.mode ?? 'view',
        status: opts.runtimeStatus?.[step.id],
        isCurrent: opts.currentStepId === step.id,
        error: opts.stepErrors?.[step.id],
        onNodeClick: opts.onNodeClick,
      };
      nodes.push({
        id: step.id,
        type: step.type,
        position: { x: 0, y: 0 },
        data: nodeData,
      });
      for (const t of tails) {
        edges.push({ id: `e_${t}_${step.id}`, source: t, target: step.id });
      }

      if (step.type === 'conditional') {
        const branchTails: string[] = [];
        if (step.then && step.then.length > 0) {
          // Walk children with [] so they don't get an unlabeled edge from prior tails; we add labeled THEN/ELSE edges explicitly.
          const thenTails = walk(step.then, []);
          const firstThen = step.then[0]?.id;
          if (firstThen) {
            edges.push({ id: `e_${step.id}_${firstThen}_then`, source: step.id, target: firstThen, label: 'THEN' });
          }
          branchTails.push(...thenTails);
        }
        if (step.else && step.else.length > 0) {
          const elseTails = walk(step.else, []);
          const firstElse = step.else[0]?.id;
          if (firstElse) {
            edges.push({ id: `e_${step.id}_${firstElse}_else`, source: step.id, target: firstElse, label: 'ELSE' });
          }
          branchTails.push(...elseTails);
        }
        // If a branch is empty, the conditional itself is a tail for that branch.
        if (!step.then || step.then.length === 0) branchTails.push(step.id);
        if (!step.else || step.else.length === 0) branchTails.push(step.id);
        tails = branchTails;
      } else if (step.type === 'parallel') {
        // Each substep gets a direct edge from this step; their tails all converge.
        const branchTails: string[] = [];
        for (const sub of step.steps ?? []) {
          const subTails = walk([sub], [step.id]);
          branchTails.push(...subTails);
        }
        tails = branchTails.length > 0 ? branchTails : [step.id];
      } else if (step.type === 'loop' || step.type === 'subworkflow') {
        // Render the body once; treat as linear-after for layout purposes.
        const innerTails = walk(step.steps ?? [], [step.id]);
        tails = innerTails.length > 0 ? innerTails : [step.id];
      } else {
        tails = [step.id];
      }
    }
    return tails;
  }

  const finalTails = walk(workflow.steps ?? [], [startId]);
  for (const t of finalTails) {
    edges.push({ id: `e_${t}_${endId}`, source: t, target: endId });
  }

  const g = new dagre.graphlib.Graph();
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 50 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const n of nodes) g.setNode(n.id, { width: NODE_WIDTH, height: NODE_HEIGHT });
  for (const e of edges) g.setEdge(e.source, e.target);
  dagre.layout(g);

  for (const n of nodes) {
    const layout = g.node(n.id);
    n.position = {
      x: layout.x - NODE_WIDTH / 2,
      y: layout.y - NODE_HEIGHT / 2,
    };
  }

  return { nodes, edges };
}
