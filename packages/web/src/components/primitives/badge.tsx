import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "~/lib/cn";

type Variant = "neutral" | "accent" | "success" | "danger";

const VARIANT: Record<Variant, string> = {
  neutral: "bg-neutral-100 text-neutral-700 dark:bg-neutral-800 dark:text-neutral-300",
  accent: "bg-accent-100 text-accent-700 dark:bg-accent-700/30 dark:text-accent-100",
  success: "bg-success-500/15 text-success-600 dark:text-success-500",
  danger: "bg-danger-500/15 text-danger-600 dark:text-danger-500",
};

export interface BadgeProps extends HTMLAttributes<HTMLSpanElement> {
  variant?: Variant;
}

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { className, variant = "neutral", ...rest },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "inline-flex items-center rounded-sm px-1.5 py-0.5 text-[11px] font-medium tracking-wide",
        VARIANT[variant],
        className,
      )}
      {...rest}
    />
  );
});
