// Adapted from Vercel AI Elements (Apache-2.0):
// https://github.com/vercel/ai-elements/blob/main/packages/elements/src/panel.tsx
import { cn } from '@/lib/cn';
import { Panel as PanelPrimitive } from '@xyflow/react';
import type { ComponentProps } from 'react';

type PanelProps = ComponentProps<typeof PanelPrimitive>;

export const Panel = ({ className, ...props }: PanelProps) => (
  <PanelPrimitive
    className={cn(
      'm-4 overflow-hidden rounded-md border border-neutral-200 bg-white p-1 shadow-sm dark:border-neutral-700 dark:bg-neutral-900',
      className,
    )}
    {...props}
  />
);
