import { useEffect, useRef } from "react";
import { SessionView } from "./session-view";

/**
 * Right-hand slide-over (assistant-centered web UI, decision 13): a child
 * session opened "in place" over the chat's right side — its own live
 * transcript, gates resolvable there, an "open full page" affordance.
 * Implemented by mounting `SessionView` with `panel`; the panel
 * itself owns the fixed-position chrome (~480px, full-height, hairline
 * border). Closing returns to the assistant with no navigation.
 *
 * `top-[--nav-height]` shares the nav's height token (`theme.css`) instead
 * of a hardcoded `top-14`, so the two can't drift apart. Below `sm` the
 * panel becomes a full-width overlay (there's no room for a docked ~480px
 * rail on a phone-sized viewport).
 */
export function ChildPanel({
  childId,
  onClose,
}: {
  childId: string;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);

  // Callers pass inline callbacks (a new reference every render), so the
  // keydown effect reads onClose through a ref: the window listener
  // registers once per mount instead of re-registering each render, and
  // it can never invoke a stale closure.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") {
        // Claim the event (capture phase + preventDefault) so the
        // Composer's Escape-to-interrupt does not also abort a running
        // turn — closing the top layer wins; a second Escape interrupts.
        e.preventDefault();
        onCloseRef.current();
        return;
      }
      // Minimal focus trap: keep Tab from leaving the panel while it's open.
      if (e.key === "Tab") {
        const panel = panelRef.current;
        if (!panel) return;
        const focusable = panel.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    // Capture phase: the panel must see Escape before the Composer's
    // bubble-phase interrupt listener, regardless of mount order.
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, []);

  // Focus the panel on open, restore focus to whatever triggered it on close.
  useEffect(() => {
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      previouslyFocused.current?.focus?.();
    };
  }, []);

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-modal="true"
      aria-label="Child thread"
      tabIndex={-1}
      className="fixed top-[--nav-height] bottom-0 right-0 z-40 flex w-full sm:w-[480px] flex-col border-l border-line bg-paper shadow-lg outline-none"
    >
      <SessionView sessionId={childId} panel onClose={onClose} />
    </div>
  );
}
