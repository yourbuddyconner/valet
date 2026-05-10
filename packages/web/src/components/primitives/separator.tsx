import * as RSeparator from "@radix-ui/react-separator";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";
import { cn } from "~/lib/cn";

export const Separator = forwardRef<
  ElementRef<typeof RSeparator.Root>,
  ComponentPropsWithoutRef<typeof RSeparator.Root>
>(function Separator({ className, orientation = "horizontal", decorative = true, ...rest }, ref) {
  return (
    <RSeparator.Root
      ref={ref}
      orientation={orientation}
      decorative={decorative}
      className={cn(
        "bg-[--border]",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
      {...rest}
    />
  );
});
