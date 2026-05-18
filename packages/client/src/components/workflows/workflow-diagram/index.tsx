import { useCallback, useMemo } from 'react';
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  type NodeTypes,
  type Node as FlowNode,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorkflowDiagramProps } from './types';
import { layoutWorkflow } from './layout';
import { StepNode } from './nodes/step-node';
import { SyntheticNode } from './nodes/synthetic-node';

const NODE_TYPES: NodeTypes = {
  bash: StepNode,
  tool: StepNode,
  agent_prompt: StepNode,
  notify: StepNode,
  conditional: StepNode,
  parallel: StepNode,
  loop: StepNode,
  approval: StepNode,
  synthetic: SyntheticNode,
};

export function WorkflowDiagram({
  workflow,
  mode,
  runtimeStatus,
  currentStepId,
  stepErrors,
  selectedStepIds,
  onNodeClick,
}: WorkflowDiagramProps) {
  const { nodes, edges } = useMemo(
    () =>
      layoutWorkflow(workflow, {
        mode,
        runtimeStatus,
        currentStepId,
        stepErrors,
        onNodeClick,
        selectedStepIds,
      }),
    [workflow, mode, runtimeStatus, currentStepId, stepErrors, onNodeClick, selectedStepIds],
  );

  const handleNodeClick = useCallback(
    (event: React.MouseEvent, node: FlowNode) => {
      // Synthetic nodes (start/end) have id starting with __; ignore.
      if (node.id.startsWith('__')) return;
      onNodeClick?.(node.id, { modifier: event.ctrlKey || event.metaKey });
    },
    [onNodeClick],
  );

  return (
    // text-neutral-* drives the BackgroundVariant.Dots color via currentColor so the
    // grid sits quietly on top of surface-1 in both light and dark mode.
    <div className="w-full h-full min-h-[400px] bg-surface-1 rounded-xl border border-border text-neutral-300 dark:text-neutral-800">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
        onNodeClick={handleNodeClick}
        fitView
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={28} size={1.2} color="currentColor" />
        <Controls
          showInteractive={false}
          className="!bg-surface-2 !border !border-border !rounded-md !shadow-panel [&_button]:!bg-transparent [&_button]:!border-0 [&_button]:!text-neutral-500 [&_button:hover]:!text-foreground [&_button]:!w-7 [&_button]:!h-7 [&_svg]:!fill-current"
        />
      </ReactFlow>
    </div>
  );
}
