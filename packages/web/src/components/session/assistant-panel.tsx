import type { ReactNode } from "react";
import { ExternalLink, Sparkles, X } from "lucide-react";
import { Link } from "@tanstack/react-router";
import { Button, Spinner } from "~/components/primitives";
import { SessionView } from "./session-view";

/** Shared chrome; the host owns workspace or workflow conversation lifetime. */
export function AssistantPanel({ title, sessionId, threadId, error, onRetry, onClose, onOpen, scopeNotice, children }: {
  title: string;
  sessionId?: string;
  threadId?: string;
  error?: string;
  onRetry: () => void;
  onClose?: () => void;
  onOpen?: () => void;
  scopeNotice?: string;
  children?: ReactNode;
}) {
  const header = (summary?: ReactNode) => <>
    <header className="flex h-[60px] shrink-0 items-center gap-2 border-b border-line px-4">
      <Sparkles className="h-4 w-4 shrink-0 text-moss" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm font-medium">{title}</span>
      {sessionId && threadId && (onOpen ?
        <button type="button" aria-label="Open assistant in Threads" className="rounded p-2 hover:bg-ink-wash" onClick={onOpen}><ExternalLink className="h-4 w-4" /></button> :
        <Link to="/threads/$threadId" params={{ threadId }} aria-label="Open assistant in Threads" className="rounded p-2 hover:bg-ink-wash"><ExternalLink className="h-4 w-4" /></Link>)}
      {summary}
      {onClose && <button type="button" aria-label="Close Valet" className="rounded p-2 hover:bg-ink-wash" onClick={onClose}><X className="h-4 w-4" /></button>}
    </header>
    {children}
  </>;
  return <div className="flex min-h-0 min-w-0 flex-1 flex-col">
    {error ? <>{header()}<div role="alert" className="flex flex-1 flex-col items-center justify-center gap-3 p-4 text-center text-sm"><p>{error}</p><Button size="sm" variant="secondary" onClick={onRetry}>Retry</Button></div></> :
      sessionId && threadId ? <SessionView key={`${sessionId}:${threadId}`} chatOnly panel renderPanelHeader={header} scopeNotice={scopeNotice} sessionId={sessionId} activeThreadId={threadId} /> :
      <>{header()}<div role="status" className="flex flex-1 items-center justify-center gap-2 text-sm text-muted"><Spinner size={14} />Opening your conversation…</div></>}
  </div>;
}
