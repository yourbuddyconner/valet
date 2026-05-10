import { useEffect } from "react";
import { createFileRoute } from "@tanstack/react-router";
import {
  useDecisions,
  useMessages,
  useSession,
  useThreads,
} from "~/api/queries";
import { useSessionWebSocket } from "~/api/ws";
import {
  useSessionStream,
  useStreamStore,
  usePendingGateForThread,
} from "~/stores/stream";
import { Composer } from "~/components/session/composer";
import { DecisionGateCard } from "~/components/session/decision-gate-card";
import { MessageList } from "~/components/session/message-list";
import { SessionHeader } from "~/components/session/session-header";
import { Spinner } from "~/components/primitives";

interface SessionSearch {
  /** Active thread id. Defaults to the first thread (engine's web:default). */
  thread?: string;
}

export const Route = createFileRoute("/sessions/$sessionId")({
  validateSearch: (raw): SessionSearch => ({
    thread: typeof raw.thread === "string" ? raw.thread : undefined,
  }),
  component: SessionPage,
});

function SessionPage() {
  const { sessionId } = Route.useParams();
  const { thread: searchThread } = Route.useSearch();
  const session = useSession(sessionId);
  const threads = useThreads(sessionId);
  // Open the WS — pipes events into the store keyed by sessionId.
  useSessionWebSocket(sessionId);
  const stream = useSessionStream(sessionId);

  // Active thread = URL ?thread= if present, else the first thread (default).
  // We only know the default's real id once the threads query resolves.
  const activeThreadId =
    searchThread ?? threads.data?.threads[0]?.id ?? undefined;

  // Load this thread's persisted messages from REST and pipe into the
  // stream store. Each (sessionId, threadId) is its own query key, so
  // switching threads triggers a fresh fetch. Background refetches are
  // disabled so this never wipes live state mid-session.
  const messagesQ = useMessages(sessionId, activeThreadId);
  const setThreadMessages = useStreamStore((s) => s.setThreadMessages);
  useEffect(() => {
    if (!activeThreadId || !messagesQ.data) return;
    setThreadMessages(sessionId, activeThreadId, messagesQ.data.messages);
  }, [sessionId, activeThreadId, messagesQ.data, setThreadMessages]);

  // Bootstrap pending decision gates from REST so the card shows
  // immediately on page load if a gate was raised before the WS opened.
  // Subsequent gates arrive via the wire and update the store directly.
  const decisionsQ = useDecisions(sessionId);
  const setPendingGates = useStreamStore((s) => s.setPendingGates);
  useEffect(() => {
    if (!decisionsQ.data) return;
    setPendingGates(sessionId, decisionsQ.data.gates);
  }, [sessionId, decisionsQ.data, setPendingGates]);

  const pendingGate = usePendingGateForThread(sessionId, activeThreadId);

  if (session.isLoading) {
    return (
      <div className="flex-1 grid place-items-center text-sm text-[--muted]">
        <Spinner /> Loading session…
      </div>
    );
  }
  if (session.error || !session.data) {
    return (
      <div className="flex-1 grid place-items-center text-center text-sm text-danger-500 p-8">
        Failed to load session
        <div className="text-xs text-[--muted] mt-1">{(session.error as Error)?.message}</div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <SessionHeader session={session.data} agentStatus={stream.agentStatus} conn={stream.conn} />
      <MessageList messages={stream.messages} threadId={activeThreadId} />
      {stream.error && (
        <div className="border-t border-danger-500/30 bg-danger-500/5 px-4 py-2 text-xs text-danger-600">
          <span className="font-medium">{stream.error.code}:</span> {stream.error.message}
        </div>
      )}
      {pendingGate && <DecisionGateCard sessionId={sessionId} gate={pendingGate} />}
      <Composer sessionId={sessionId} threadId={activeThreadId} agentStatus={stream.agentStatus} />
    </div>
  );
}
