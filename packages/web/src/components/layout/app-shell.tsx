import type { ReactNode } from "react";
import { cn } from "~/lib/cn";

/**
 * Three-zone app shell: a top nav, a left sidebar, and the main content
 * outlet. Sidebar fixed-width on desktop; mobile drawer is out of scope —
 * agent-loop UX is desktop-first.
 */
export function AppShell({
  topNav,
  sidebar,
  children,
  className,
}: {
  topNav: ReactNode;
  sidebar: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("h-screen w-screen flex flex-col bg-[--bg] text-[--fg]", className)}>
      {topNav}
      <div className="flex-1 flex min-h-0">
        <aside className="w-60 shrink-0 border-r border-[--border] flex flex-col">
          {sidebar}
        </aside>
        <main className="flex-1 min-w-0 flex flex-col">{children}</main>
      </div>
    </div>
  );
}
