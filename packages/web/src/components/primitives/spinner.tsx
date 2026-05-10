import { Loader2 } from "lucide-react";
import { cn } from "~/lib/cn";

export function Spinner({ className, size = 16 }: { className?: string; size?: number }) {
  return (
    <Loader2
      className={cn("animate-spin text-[--muted]", className)}
      width={size}
      height={size}
      aria-label="Loading"
    />
  );
}
