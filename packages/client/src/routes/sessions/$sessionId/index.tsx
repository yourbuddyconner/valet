import { createFileRoute } from '@tanstack/react-router';
import { ChatContainer } from '@/components/chat/chat-container';
import { useResolvedSessionId } from '@/hooks/use-resolved-session-id';

type SessionSearchParams = {
  threadId?: string;
};

export const Route = createFileRoute('/sessions/$sessionId/')({
  component: SessionChatPage,
  validateSearch: (search: Record<string, unknown>): SessionSearchParams => ({
    threadId: typeof search.threadId === 'string' ? search.threadId : undefined,
  }),
});

function SessionChatPage() {
  const { sessionId: routeSessionId } = Route.useParams();
  const sessionId = useResolvedSessionId(routeSessionId);
  const { threadId } = Route.useSearch();

  // While the orchestrator alias is resolving, don't render the chat
  // to avoid creating queries keyed on the alias string.
  if (!sessionId) return null;

  return (
    <ChatContainer
      key={sessionId}
      sessionId={sessionId}
      routeSessionId={routeSessionId}
      initialThreadId={threadId}
    />
  );
}
