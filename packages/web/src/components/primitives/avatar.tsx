import * as RAvatar from "@radix-ui/react-avatar";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
} from "react";
import { cn } from "~/lib/cn";

export const Avatar = forwardRef<
  ElementRef<typeof RAvatar.Root>,
  ComponentPropsWithoutRef<typeof RAvatar.Root> & { size?: "sm" | "md" | "lg" }
>(function Avatar({ className, size = "md", ...rest }, ref) {
  const sizeCls = size === "sm" ? "h-6 w-6 text-xs" : size === "lg" ? "h-10 w-10 text-base" : "h-8 w-8 text-sm";
  return (
    <RAvatar.Root
      ref={ref}
      className={cn(
        "relative inline-flex shrink-0 overflow-hidden rounded-full bg-neutral-200 dark:bg-neutral-800",
        sizeCls,
        className,
      )}
      {...rest}
    />
  );
});

export const AvatarImage = forwardRef<
  ElementRef<typeof RAvatar.Image>,
  ComponentPropsWithoutRef<typeof RAvatar.Image>
>(function AvatarImage({ className, ...rest }, ref) {
  return <RAvatar.Image ref={ref} className={cn("aspect-square h-full w-full", className)} {...rest} />;
});

export const AvatarFallback = forwardRef<
  ElementRef<typeof RAvatar.Fallback>,
  ComponentPropsWithoutRef<typeof RAvatar.Fallback>
>(function AvatarFallback({ className, ...rest }, ref) {
  return (
    <RAvatar.Fallback
      ref={ref}
      className={cn("flex h-full w-full items-center justify-center font-medium text-[--muted]", className)}
      {...rest}
    />
  );
});
