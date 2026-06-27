import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { DialogOverlay } from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from '@/components/ui/command';
import { cn } from '@/lib/cn';

export type ModelSelectorProps = React.ComponentProps<typeof DialogPrimitive.Root>;
export const ModelSelector = (props: ModelSelectorProps) => (
  <DialogPrimitive.Root {...props} />
);

export type ModelSelectorTriggerProps = React.ComponentProps<typeof DialogPrimitive.Trigger>;
export const ModelSelectorTrigger = (props: ModelSelectorTriggerProps) => (
  <DialogPrimitive.Trigger {...props} />
);

export type ModelSelectorContentProps = React.ComponentProps<typeof DialogPrimitive.Content> & {
  title?: React.ReactNode;
};
export const ModelSelectorContent = ({
  className,
  children,
  title = 'Select model',
  ...props
}: ModelSelectorContentProps) => (
  <DialogPrimitive.Portal>
    <DialogOverlay />
    <DialogPrimitive.Content
      className={cn(
        'fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2',
        'overflow-hidden rounded-lg border border-neutral-200 bg-white shadow-lg',
        'dark:border-neutral-700 dark:bg-neutral-900',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0',
        'data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95',
        'data-[state=closed]:slide-out-to-left-1/2 data-[state=closed]:slide-out-to-top-[48%]',
        'data-[state=open]:slide-in-from-left-1/2 data-[state=open]:slide-in-from-top-[48%]',
        className
      )}
      {...props}
    >
      <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
      <Command>{children}</Command>
    </DialogPrimitive.Content>
  </DialogPrimitive.Portal>
);

export type ModelSelectorInputProps = React.ComponentProps<typeof CommandInput>;
export const ModelSelectorInput = ({ className, ...props }: ModelSelectorInputProps) => (
  <CommandInput className={cn('h-auto py-3.5', className)} {...props} />
);

export type ModelSelectorListProps = React.ComponentProps<typeof CommandList>;
export const ModelSelectorList = (props: ModelSelectorListProps) => (
  <CommandList {...props} />
);

export type ModelSelectorEmptyProps = React.ComponentProps<typeof CommandEmpty>;
export const ModelSelectorEmpty = (props: ModelSelectorEmptyProps) => (
  <CommandEmpty {...props} />
);

export type ModelSelectorGroupProps = React.ComponentProps<typeof CommandGroup>;
export const ModelSelectorGroup = (props: ModelSelectorGroupProps) => (
  <CommandGroup {...props} />
);

export type ModelSelectorItemProps = React.ComponentProps<typeof CommandItem>;
export const ModelSelectorItem = (props: ModelSelectorItemProps) => (
  <CommandItem {...props} />
);

export type ModelSelectorSeparatorProps = React.ComponentProps<typeof CommandSeparator>;
export const ModelSelectorSeparator = (props: ModelSelectorSeparatorProps) => (
  <CommandSeparator {...props} />
);

export type ModelSelectorLogoProps = Omit<React.ComponentProps<'img'>, 'src' | 'alt'> & {
  provider: string;
};
export const ModelSelectorLogo = ({ provider, className, ...props }: ModelSelectorLogoProps) => (
  <img
    {...props}
    alt={`${provider} logo`}
    className={cn('size-3 dark:invert', className)}
    height={12}
    src={`https://models.dev/logos/${provider}.svg`}
    width={12}
  />
);

export type ModelSelectorLogoGroupProps = React.ComponentProps<'div'>;
export const ModelSelectorLogoGroup = ({ className, ...props }: ModelSelectorLogoGroupProps) => (
  <div
    className={cn(
      'flex shrink-0 items-center -space-x-1',
      '[&>img]:rounded-full [&>img]:bg-white [&>img]:p-px [&>img]:ring-1',
      'dark:[&>img]:bg-neutral-900',
      className
    )}
    {...props}
  />
);

export type ModelSelectorNameProps = React.ComponentProps<'span'>;
export const ModelSelectorName = ({ className, ...props }: ModelSelectorNameProps) => (
  <span className={cn('flex-1 truncate text-left', className)} {...props} />
);
