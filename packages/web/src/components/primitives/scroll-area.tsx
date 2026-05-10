import * as RScrollArea from "@radix-ui/react-scroll-area";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";
import { cn } from "~/lib/cn";

export const ScrollArea = forwardRef<
  ElementRef<typeof RScrollArea.Root>,
  ComponentPropsWithoutRef<typeof RScrollArea.Root>
>(function ScrollArea({ className, children, ...rest }, ref) {
  return (
    <RScrollArea.Root ref={ref} className={cn("relative overflow-hidden", className)} {...rest}>
      <RScrollArea.Viewport className="h-full w-full rounded-[inherit]">{children}</RScrollArea.Viewport>
      <ScrollBar />
      <RScrollArea.Corner />
    </RScrollArea.Root>
  );
});

const ScrollBar = forwardRef<
  ElementRef<typeof RScrollArea.ScrollAreaScrollbar>,
  ComponentPropsWithoutRef<typeof RScrollArea.ScrollAreaScrollbar>
>(function ScrollBar({ className, orientation = "vertical", ...rest }, ref) {
  return (
    <RScrollArea.ScrollAreaScrollbar
      ref={ref}
      orientation={orientation}
      className={cn(
        "flex touch-none select-none transition-colors",
        orientation === "vertical" && "h-full w-2 border-l border-l-transparent p-[1px]",
        orientation === "horizontal" && "h-2 flex-col border-t border-t-transparent p-[1px]",
        className,
      )}
      {...rest}
    >
      <RScrollArea.ScrollAreaThumb className="relative flex-1 rounded-full bg-neutral-300 dark:bg-neutral-700" />
    </RScrollArea.ScrollAreaScrollbar>
  );
});
