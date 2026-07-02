// Adapted from Vercel AI Elements (Apache-2.0):
// https://github.com/vercel/ai-elements/blob/main/packages/elements/src/toolbar.tsx
import { cn } from '@/lib/cn';
import { NodeToolbar, Position } from '@xyflow/react';
import type { ComponentProps } from 'react';

type ToolbarProps = ComponentProps<typeof NodeToolbar>;

export const Toolbar = ({ className, ...props }: ToolbarProps) => (
  <NodeToolbar
    className={cn(
      'flex items-center gap-1 rounded-sm border border-neutral-200 bg-white p-1.5 shadow-sm dark:border-neutral-700 dark:bg-neutral-900',
      className,
    )}
    position={Position.Bottom}
    {...props}
  />
);
