import * as RDialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type ElementRef,
  type ReactNode,
} from "react";
import { cn } from "~/lib/cn";

/**
 * Dialog primitive over Radix. We expose a small composable API:
 *
 *   <Dialog open={..} onOpenChange={..}>
 *     <DialogContent title="…" description="…">
 *       …body…
 *       <DialogFooter>…buttons…</DialogFooter>
 *     </DialogContent>
 *   </Dialog>
 *
 * If a triggering element should anchor open state, use Radix's `<Trigger />`
 * directly via `<Dialog.Root><Dialog.Trigger asChild>…</Dialog.Trigger>…</Dialog.Root>`.
 * Most consumers use the controlled `open`/`onOpenChange` form.
 */
export const Dialog = RDialog.Root;
export const DialogTrigger = RDialog.Trigger;
export const DialogClose = RDialog.Close;

// Omit the native HTML `title` (which expects a string) so we can take a ReactNode.
interface DialogContentProps
  extends Omit<ComponentPropsWithoutRef<typeof RDialog.Content>, "title"> {
  title?: ReactNode;
  description?: ReactNode;
  /** Hide the default close button in the corner. */
  hideClose?: boolean;
}

export const DialogContent = forwardRef<ElementRef<typeof RDialog.Content>, DialogContentProps>(
  function DialogContent({ className, title, description, hideClose, children, ...rest }, ref) {
    return (
      <RDialog.Portal>
        <RDialog.Overlay
          className={cn(
            "fixed inset-0 z-50 bg-black/40 backdrop-blur-sm",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0",
          )}
        />
        <RDialog.Content
          ref={ref}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-full max-w-md -translate-x-1/2 -translate-y-1/2",
            "bg-[--bg] border border-[--border] rounded-lg shadow-xl",
            "p-5 grid gap-4",
            "focus:outline-none",
            className,
          )}
          {...rest}
        >
          {(title || description) && (
            <header className="grid gap-1">
              {title && (
                <RDialog.Title className="text-base font-semibold tracking-tight">
                  {title}
                </RDialog.Title>
              )}
              {description && (
                <RDialog.Description className="text-sm text-[--muted]">
                  {description}
                </RDialog.Description>
              )}
            </header>
          )}
          {children}
          {!hideClose && (
            <RDialog.Close
              aria-label="Close"
              className={cn(
                "absolute right-3 top-3 rounded-sm p-1 text-[--muted] hover:text-[--fg]",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40",
              )}
            >
              <X className="h-4 w-4" aria-hidden />
            </RDialog.Close>
          )}
        </RDialog.Content>
      </RDialog.Portal>
    );
  },
);

export function DialogFooter({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <footer className={cn("flex justify-end gap-2 pt-2", className)}>{children}</footer>
  );
}
