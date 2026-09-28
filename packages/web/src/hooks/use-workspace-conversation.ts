import { useQuery } from "@tanstack/react-query";
import { useSearch } from "@tanstack/react-router";
import { api } from "~/api/client";
import { useWorkspaceScope } from "~/lib/workspace-scope";

/** Resolve the runtime by workspace ownership. The server authorizes the owner. */
export function useOwnerConversation(workspace: string | undefined) {
  return useQuery({
    queryKey: ["workspace-conversation", workspace],
    enabled: workspace !== undefined,
    queryFn: async () => {
      if (workspace === undefined) throw new Error("Choose a workspace to open its threads.");
      return api.ensureWorkspaceRuntime(workspace);
    },
    staleTime: Infinity,
    retry: false,
  });
}

/** Share the same owner-addressed ensure between the thread rail and page. */
export function useWorkspaceConversation() {
  const scope = useWorkspaceScope();
  const search = useSearch({ strict: false });
  const workspace = search && "workspace" in search && typeof search.workspace === "string"
    ? search.workspace : scope.key;
  return useOwnerConversation(workspace);
}
