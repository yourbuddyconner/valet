// Adapted from Vercel AI Elements (Apache-2.0):
// https://github.com/vercel/ai-elements/blob/main/packages/elements/src/controls.tsx
import { cn } from '@/lib/cn';
import { Controls as ControlsPrimitive } from '@xyflow/react';
import type { ComponentProps } from 'react';

export type ControlsProps = ComponentProps<typeof ControlsPrimitive>;

export const Controls = ({ className, ...props }: ControlsProps) => (
  <ControlsPrimitive
    className={cn(
      'gap-px overflow-hidden rounded-md border border-neutral-200 bg-white p-1 shadow-sm dark:border-neutral-700 dark:bg-neutral-900',
      '[&>button]:rounded-md [&>button]:border-none [&>button]:bg-transparent [&>button]:hover:bg-surface-2',
      className,
    )}
    {...props}
  />
);
