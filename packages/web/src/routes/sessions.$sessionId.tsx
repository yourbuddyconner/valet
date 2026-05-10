import { createFileRoute } from "@tanstack/react-router";
import { useSession, useMessages } from "~/api/queries";
import { useSessionWebSocket } from "~/api/ws";
import { useSessionStream } from "~/stores/stream";
import { Composer } from "~/components/session/composer";
import { MessageList } from "~/components/session/message-list";
import { SessionHeader } from "~/components/session/session-header";
import { Spinner } from "~/components/primitives";

export const Route = createFileRoute("/sessions/$sessionId")({
  component: SessionPage,
});

function SessionPage() {
  const { sessionId } = Route.useParams();
  const session = useSession(sessionId);
  // Initial historical messages (REST). The store holds the live-merged copy.
  useMessages(sessionId);
  // Open the WS — pipes events into the store keyed by sessionId.
  useSessionWebSocket(sessionId);
  const stream = useSessionStream(sessionId);

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
      <MessageList messages={stream.messages} />
      {stream.error && (
        <div className="border-t border-danger-500/30 bg-danger-500/5 px-4 py-2 text-xs text-danger-600">
          <span className="font-medium">{stream.error.code}:</span> {stream.error.message}
        </div>
      )}
      <Composer sessionId={sessionId} agentStatus={stream.agentStatus} />
    </div>
  );
}
