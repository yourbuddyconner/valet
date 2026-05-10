import { Link, useNavigate, useParams } from "@tanstack/react-router";
import { ChevronDown, Plus } from "lucide-react";
import type { SessionDetail, SessionSummary } from "@valet/api/wire";
import { useSession, useSessions } from "~/api/queries";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Spinner,
} from "~/components/primitives";
import { cn } from "~/lib/cn";

/**
 * App-wide top navigation: brand on the left, session selector in the middle,
 * "New session" action on the right.
 *
 * The current session id is read from the URL via useParams(strict: false), so
 * this component renders correctly on any route — no prop-drilling required.
 */
export function TopNav({ onNewSession }: { onNewSession: () => void }) {
  const params = useParams({ strict: false }) as { sessionId?: string };
  const sessionId = params.sessionId ?? "";
  const session = useSession(sessionId);

  return (
    <header className="h-12 shrink-0 border-b border-[--border] bg-[--bg] flex items-center px-3 gap-3">
      <Link
        to="/"
        className="flex items-center gap-2 rounded px-1 py-1 hover:bg-neutral-100 dark:hover:bg-neutral-900"
      >
        <div className="h-6 w-6 rounded bg-accent-600 grid place-items-center text-white font-semibold text-xs">
          V
        </div>
        <span className="text-sm font-semibold tracking-tight">Valet</span>
      </Link>

      <SessionPicker currentSession={session.data} />

      <div className="flex-1" />

      <Button size="sm" onClick={onNewSession}>
        <Plus className="h-4 w-4" />
        <span>New session</span>
      </Button>
    </header>
  );
}

function SessionPicker({ currentSession }: { currentSession?: SessionDetail }) {
  const navigate = useNavigate();
  const { data, isLoading } = useSessions();
  const sessions = data?.sessions ?? [];

  const triggerLabel = currentSession
    ? currentSession.title || "Untitled session"
    : "Select session";

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="font-normal max-w-[320px] gap-1.5"
          aria-label="Switch session"
        >
          <span className="truncate">{triggerLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 text-[--muted] shrink-0" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="min-w-[300px]">
        <DropdownMenuLabel>Sessions</DropdownMenuLabel>
        {isLoading && (
          <div className="px-2 py-2 flex items-center gap-2 text-sm text-[--muted]">
            <Spinner size={14} /> Loading…
          </div>
        )}
        {!isLoading && sessions.length === 0 && (
          <div className="px-2 py-2 text-sm text-[--muted]">No sessions yet.</div>
        )}
        {sessions.map((s) => (
          <SessionMenuItem
            key={s.id}
            session={s}
            isActive={currentSession?.id === s.id}
            onSelect={() => navigate({ to: "/sessions/$sessionId", params: { sessionId: s.id } })}
          />
        ))}
        {sessions.length > 0 && <DropdownMenuSeparator />}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SessionMenuItem({
  session,
  isActive,
  onSelect,
}: {
  session: SessionSummary;
  isActive: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onSelect={onSelect}
      className={cn("flex flex-col items-stretch gap-0.5", isActive && "bg-neutral-100 dark:bg-neutral-800")}
    >
      <span className="text-sm font-medium truncate">{session.title || "Untitled session"}</span>
      <span className="text-xs text-[--muted] font-mono truncate">{session.workspace}</span>
    </DropdownMenuItem>
  );
}
