import { forwardRef, type LabelHTMLAttributes } from "react";
import { cn } from "~/lib/cn";

export const Label = forwardRef<HTMLLabelElement, LabelHTMLAttributes<HTMLLabelElement>>(
  function Label({ className, ...rest }, ref) {
    return (
      <label
        ref={ref}
        className={cn("text-xs font-medium text-[--muted] tracking-wide", className)}
        {...rest}
      />
    );
  },
);
