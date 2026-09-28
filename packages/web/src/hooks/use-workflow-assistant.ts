import { useCallback } from "react";
import { useWorkflowConversation } from "~/api/workflow-conversation";

export interface WorkflowAssistant {
  sessionId?: string;
  threadId?: string;
  opening: boolean;
  error?: string;
  retry: () => void;
  stage: "session" | "thread";
}

/** The server resolves the workflow owner and its durable editor thread. */
export function useWorkflowAssistant(
  workflowId: string,
  _workflowName: string,
  routing: { ownerType: string; ownerId: string },
): WorkflowAssistant {
  const conversation = useWorkflowConversation(workflowId, routing.ownerType, routing.ownerId);
  const retry = useCallback(() => { void conversation.refetch(); }, [conversation.refetch]);
  // Do not display cached identifiers until the server confirms current access.
  const ready = !conversation.isFetching && !conversation.isError ? conversation.data : undefined;
  return {
    sessionId: ready?.sessionId,
    threadId: ready?.threadId,
    opening: conversation.isFetching || conversation.isPending,
    error: conversation.isError && !conversation.isFetching
      ? "Cannot open this workflow conversation. Use Retry to try again."
      : undefined,
    retry,
    stage: "thread",
  };
}
