import { useCallback, useMemo } from 'react';
import { ReactFlow, Background, Controls, type NodeTypes, type Node as FlowNode } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { WorkflowDiagramProps } from './types';
import { layoutWorkflow } from './layout';
import { StepNode } from './nodes/step-node';
import { SyntheticNode } from './nodes/synthetic-node';

const NODE_TYPES: NodeTypes = {
  bash: StepNode,
  tool: StepNode,
  agent: StepNode,
  agent_message: StepNode,
  agent_prompt: StepNode,
  notify: StepNode,
  conditional: StepNode,
  parallel: StepNode,
  loop: StepNode,
  subworkflow: StepNode,
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
    <div className="w-full h-full min-h-[400px] bg-neutral-50 rounded-xl border border-neutral-200">
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
        <Background gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}
