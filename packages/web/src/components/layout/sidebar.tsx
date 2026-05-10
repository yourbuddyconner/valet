import { Link, useParams } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import type { SessionSummary } from "@valet/api/wire";
import { useSessions } from "~/api/queries";
import { Button, ScrollArea, Separator, Spinner } from "~/components/primitives";
import { cn } from "~/lib/cn";

export function Sidebar({ onNewSession }: { onNewSession: () => void }) {
  const { data, isLoading, error } = useSessions();

  return (
    <>
      <header className="px-4 py-3 flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-md bg-accent-600 grid place-items-center text-white font-semibold text-sm">
            V
          </div>
          <span className="text-sm font-semibold tracking-tight">Valet</span>
        </div>
        <Button size="sm" variant="primary" onClick={onNewSession} aria-label="New session">
          <Plus className="h-4 w-4" />
          <span>New</span>
        </Button>
      </header>
      <Separator />
      <ScrollArea className="flex-1">
        <nav className="p-2 space-y-0.5">
          {isLoading && (
            <div className="px-3 py-2 flex items-center gap-2 text-sm text-[--muted]">
              <Spinner size={14} /> Loading…
            </div>
          )}
          {error && (
            <div className="px-3 py-2 text-sm text-danger-500">
              Failed to load sessions
            </div>
          )}
          {data?.sessions.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-[--muted]">
              No sessions yet. Click <span className="font-medium">New</span> to start one.
            </div>
          )}
          {data?.sessions.map((s) => (
            <SidebarItem key={s.id} session={s} />
          ))}
        </nav>
      </ScrollArea>
    </>
  );
}

function SidebarItem({ session }: { session: SessionSummary }) {
  const params = useParams({ strict: false }) as { sessionId?: string };
  const active = params.sessionId === session.id;
  return (
    <Link
      to="/sessions/$sessionId"
      params={{ sessionId: session.id }}
      className={cn(
        "block rounded px-3 py-2 text-sm transition-colors",
        active
          ? "bg-neutral-200 dark:bg-neutral-800 text-[--fg]"
          : "hover:bg-neutral-100 dark:hover:bg-neutral-900 text-[--fg]/90",
      )}
    >
      <div className="font-medium truncate">{session.title || "Untitled session"}</div>
      <div className="text-xs text-[--muted] truncate">{session.workspace}</div>
    </Link>
  );
}
