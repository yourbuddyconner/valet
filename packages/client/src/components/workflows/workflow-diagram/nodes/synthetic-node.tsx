import { Handle, Position, type Node, type NodeProps } from '@xyflow/react';
import { Circle, CheckCircle2 } from 'lucide-react';
import type { SyntheticNodeData } from '../types';

export function SyntheticNode({ data }: NodeProps<Node<SyntheticNodeData>>) {
  const isEnd = data.kind === 'end';
  return (
    <div className="flex flex-col items-center">
      <div className="w-7 h-7 rounded-full bg-surface-2 border border-border-strong flex items-center justify-center text-neutral-500 shadow-panel">
        <Handle type="target" position={Position.Top} />
        {isEnd ? (
          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" strokeWidth={2} />
        ) : (
          <Circle className="w-3 h-3 fill-current" strokeWidth={0} />
        )}
        <Handle type="source" position={Position.Bottom} />
      </div>
      {data.label && (
        <div className="text-[9px] tracking-[0.18em] uppercase font-mono text-neutral-500 mt-1.5">
          {data.label}
        </div>
      )}
    </div>
  );
}
