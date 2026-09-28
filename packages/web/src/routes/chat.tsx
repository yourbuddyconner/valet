import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useTeams } from "~/api/settings";
import { Spinner } from "~/components/primitives";
import { ChildPanel } from "~/components/session/child-panel";
import { SessionView } from "~/components/session/session-view";
import { useInvalidateMessagesOnQueueState } from "~/hooks/use-invalidate-messages-on-queue-state";
import { useWorkspaceConversation } from "~/hooks/use-workspace-conversation";
import { errorText } from "~/lib/error-text";
import { useWorkspaceScope } from "~/lib/workspace-scope";

interface ChatSearch { thread?: string; child?: string; workspace?: string }
export const Route = createFileRoute("/chat")({
  validateSearch: (raw): ChatSearch => ({
    thread: typeof raw.thread === "string" ? raw.thread : undefined,
    child: typeof raw.child === "string" ? raw.child : undefined,
    workspace: typeof raw.workspace === "string" ? raw.workspace : undefined,
  }),
  component: ChatPage,
});

function ChatPage() {
  const { thread, child } = Route.useSearch();
  const conversation = useWorkspaceConversation();
  const scope = useWorkspaceScope();
  const teams = useTeams();
  const team = teams.data?.teams.find(t => t.id === scope.teamId);
  const navigate = useNavigate({ from: Route.fullPath });
  const sessionId = conversation.data?.sessionId;
  useInvalidateMessagesOnQueueState(sessionId, thread);
  if (conversation.error) return <div role="alert" className="p-8 text-sm text-danger-500">
    Couldn’t open this workspace’s threads. {errorText(conversation.error)}
    <button className="ml-2 underline" onClick={() => void conversation.refetch()}>Retry</button>
  </div>;
  if (!sessionId) return <div className="flex-1 grid place-items-center"><Spinner /> Opening threads…</div>;
  return <>
    <div className="flex-1 min-h-0 flex flex-col">
      {team && <div role="status" className="border-b border-line px-4 py-1.5 text-xs text-muted">
        Shared with {team.name}. Team members can read and reply.
      </div>}
      <SessionView key={sessionId} sessionId={sessionId} activeThreadId={thread}
        onOpenChild={id => void navigate({ search: prev => ({ ...prev, child: id }) })} enableReplies />
    </div>
    {child && <ChildPanel childId={child} onClose={() => void navigate({ search: prev => ({ ...prev, child: undefined }) })} />}
  </>;
}
