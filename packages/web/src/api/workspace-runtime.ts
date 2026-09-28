import { useQuery, type UseQueryOptions } from "@tanstack/react-query";
import type { WorkspaceRuntimeInfoResponse } from "@valet/api/wire";
import { api } from "./client";

export function useWorkspaceRuntimeInfo(workspace: string | undefined, opts?: Partial<UseQueryOptions<WorkspaceRuntimeInfoResponse>>) {
  return useQuery<WorkspaceRuntimeInfoResponse>({
    queryKey: ["workspace-runtime", workspace, "info"],
    queryFn: () => {
      if (workspace === undefined) throw new Error("Choose a workspace.");
      return api.getWorkspaceRuntimeInfo(workspace);
    },
    enabled: workspace !== undefined,
    ...opts,
  });
}
