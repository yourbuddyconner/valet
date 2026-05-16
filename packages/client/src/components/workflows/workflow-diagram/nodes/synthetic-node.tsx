import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import type { SyntheticNodeData } from '../types';

export function SyntheticNode({ data }: NodeProps<Node<SyntheticNodeData>>) {
  const isEnd = data.kind === 'end';
  return (
    <div
      className={`px-4 py-1.5 rounded-full text-xs font-semibold tracking-wider text-white ${
        isEnd ? 'bg-emerald-700' : data.kind === 'merge' ? 'bg-neutral-400' : 'bg-neutral-900'
      }`}
    >
      <Handle type="target" position={Position.Top} />
      {data.label}
      <Handle type="source" position={Position.Bottom} />
    </div>
  );
}
