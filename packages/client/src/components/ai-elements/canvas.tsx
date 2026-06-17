// Adapted from Vercel AI Elements (Apache-2.0):
// https://github.com/vercel/ai-elements/blob/main/packages/elements/src/canvas.tsx
import type { ReactFlowProps } from '@xyflow/react';
import { Background, ReactFlow } from '@xyflow/react';
import type { ReactNode } from 'react';

import '@xyflow/react/dist/style.css';

type CanvasProps = ReactFlowProps & {
  children?: ReactNode;
};

const deleteKeyCode = ['Backspace', 'Delete'];

export const Canvas = ({ children, ...props }: CanvasProps) => (
  <ReactFlow
    deleteKeyCode={deleteKeyCode}
    fitView
    panOnDrag
    panOnScroll
    selectionKeyCode="Shift"
    zoomOnDoubleClick={false}
    {...props}
  >
    <Background bgColor="var(--surface-1, #f7f7f8)" />
    {children}
  </ReactFlow>
);
