import { useQuery } from "@tanstack/react-query";
import { api } from "./client";

export function useWorkflowConversation(workflowId: string, ownerType: string, ownerId: string) {
  return useQuery({
    queryKey: ["workflow-conversation", workflowId, ownerType, ownerId],
    queryFn: () => api.ensureWorkflowConversation(workflowId),
    retry: false,
    staleTime: 0,
  });
}
