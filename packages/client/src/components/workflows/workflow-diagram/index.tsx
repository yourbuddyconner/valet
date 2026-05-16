import { useMemo } from 'react';
import { ReactFlow, Background, Controls, type NodeTypes } from '@xyflow/react';
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
  onNodeClick,
}: WorkflowDiagramProps) {
  const { nodes, edges } = useMemo(
    () => layoutWorkflow(workflow, { mode, runtimeStatus, currentStepId, stepErrors, onNodeClick }),
    [workflow, mode, runtimeStatus, currentStepId, stepErrors, onNodeClick],
  );

  return (
    <div className="w-full h-full min-h-[400px] bg-neutral-50 rounded-xl border border-neutral-200">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={NODE_TYPES}
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
