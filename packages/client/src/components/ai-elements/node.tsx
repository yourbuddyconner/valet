// Adapted from Vercel AI Elements (Apache-2.0):
// https://github.com/vercel/ai-elements/blob/main/packages/elements/src/node.tsx
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { cn } from '@/lib/cn';
import { Handle, Position } from '@xyflow/react';
import type { ComponentProps } from 'react';

export type NodeProps = ComponentProps<typeof Card> & {
  handles: {
    target: boolean;
    source: boolean;
    sourceOutputs?: Array<'true' | 'false'>;
  };
};

export const Node = ({ handles, className, ...props }: NodeProps) => (
  <Card
    className={cn(
      'node-container relative h-auto w-[260px] gap-0 rounded-md p-0 shadow-sm',
      'border-neutral-200 bg-white dark:border-neutral-700 dark:bg-neutral-900',
      className,
    )}
    {...props}
>
  {handles.target && <Handle position={Position.Left} type="target" />}
  {handles.sourceOutputs?.length ? (
    handles.sourceOutputs.map((output, index) => {
      const top = handles.sourceOutputs!.length === 1 ? 50 : index === 0 ? 38 : 62;
      return (
        <div
          key={output}
          className="absolute right-0 z-10 translate-x-full -translate-y-1/2 pl-2 text-[10px] font-medium uppercase tracking-normal text-neutral-500 dark:text-neutral-400"
          style={{ top: `${top}%` }}
        >
          {output}
          <Handle
            id={output}
            position={Position.Right}
            style={{ top: '50%', right: '100%' }}
            type="source"
          />
        </div>
      );
    })
  ) : (
    handles.source && <Handle position={Position.Right} type="source" />
  )}
  {props.children}
</Card>
);

export type NodeHeaderProps = ComponentProps<typeof CardHeader>;

export const NodeHeader = ({ className, ...props }: NodeHeaderProps) => (
  <CardHeader
    className={cn('gap-0.5 rounded-t-md border-b bg-surface-1 p-3 dark:bg-neutral-800', className)}
    {...props}
  />
);

export type NodeTitleProps = ComponentProps<typeof CardTitle>;

export const NodeTitle = ({ className, ...props }: NodeTitleProps) => (
  <CardTitle className={cn('text-sm', className)} {...props} />
);

export type NodeDescriptionProps = ComponentProps<typeof CardDescription>;

export const NodeDescription = ({ className, ...props }: NodeDescriptionProps) => (
  <CardDescription className={cn('text-xs', className)} {...props} />
);

export type NodeActionProps = ComponentProps<'div'>;

export const NodeAction = ({ className, ...props }: NodeActionProps) => (
  <div className={cn('ml-auto', className)} {...props} />
);

export type NodeContentProps = ComponentProps<typeof CardContent>;

export const NodeContent = ({ className, ...props }: NodeContentProps) => (
  <CardContent className={cn('p-3', className)} {...props} />
);

export type NodeFooterProps = ComponentProps<typeof CardFooter>;

export const NodeFooter = ({ className, ...props }: NodeFooterProps) => (
  <CardFooter
    className={cn('rounded-b-md border-t bg-surface-1 p-3 dark:bg-neutral-800', className)}
    {...props}
  />
);
