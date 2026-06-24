import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/cn';

/**
 * Small "i" icon button that, on hover or focus, shows a Radix tooltip
 * with the given help text. Used inline next to labels in forms where a
 * specific field benefits from clarification beyond its label.
 *
 * Render `null`-equivalent if `help` is undefined — call sites can do
 * `<InfoTooltip help={NODE_DOCS[type].fields?.[field]?.help} />` and
 * the icon disappears automatically for fields without a docs entry.
 */
export function InfoTooltip({
  help,
  className,
}: {
  help?: string;
  className?: string;
}) {
  if (!help) return null;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label="More info"
            className={cn(
              'inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border border-neutral-300 text-[10px] font-semibold leading-none text-neutral-500 transition hover:border-neutral-500 hover:text-neutral-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/40 dark:border-neutral-600 dark:text-neutral-400 dark:hover:border-neutral-400 dark:hover:text-neutral-200',
              className,
            )}
            onClick={(event) => event.preventDefault()}
          >
            i
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-[280px] text-left leading-relaxed" side="top">
          {help}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
