import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/**
 * Two-pane app layout: sidebar (sessions list + new) on the left, main content
 * (route outlet) on the right. Sidebar fixed-width on desktop; on mobile we
 * stack — but agent-loop UX is mostly desktop, so we skip mobile drawer for now.
 */
export function AppShell({
  sidebar,
  children,
  className,
}: {
  sidebar: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("h-screen w-screen flex bg-[--bg] text-[--fg]", className)}>
      <aside className="w-72 shrink-0 border-r border-[--border] flex flex-col">
        {sidebar}
      </aside>
      <main className="flex-1 min-w-0 flex flex-col">{children}</main>
    </div>
  );
}
