import * as RTooltip from "@radix-ui/react-tooltip";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from "react";
import { cn } from "~/lib/cn";

export const TooltipProvider = RTooltip.Provider;
export const TooltipRoot = RTooltip.Root;
export const TooltipTrigger = RTooltip.Trigger;

export const TooltipContent = forwardRef<
  ElementRef<typeof RTooltip.Content>,
  ComponentPropsWithoutRef<typeof RTooltip.Content>
>(function TooltipContent({ className, sideOffset = 6, ...rest }, ref) {
  return (
    <RTooltip.Portal>
      <RTooltip.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-md border border-[--border] bg-[--bg] px-2 py-1 text-xs shadow-md",
          "data-[state=delayed-open]:animate-in data-[state=closed]:animate-out",
          "data-[state=delayed-open]:fade-in-0 data-[state=closed]:fade-out-0",
          className,
        )}
        {...rest}
      />
    </RTooltip.Portal>
  );
});

/**
 * Convenience wrapper for the common case of "show this tip when hovering this
 * trigger." For richer control use the lower-level primitives.
 */
export function Tooltip({
  content,
  children,
  delayDuration = 200,
}: {
  content: ReactNode;
  children: ReactNode;
  delayDuration?: number;
}) {
  return (
    <TooltipRoot delayDuration={delayDuration}>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent>{content}</TooltipContent>
    </TooltipRoot>
  );
}
