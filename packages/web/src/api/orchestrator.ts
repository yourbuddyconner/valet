/**
 * Assistant identity + children queries (assistant-centered web UI,
 * decisions 4/6). House pattern: a query-key factory per resource file,
 * mirroring `~/api/queries`.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type UseQueryOptions,
} from "@tanstack/react-query";
import type {
  GetTeamChildrenResponse,
  GetOrchestratorChildrenResponse,
  WorkspaceRuntimeInfoResponse,
} from "@valet/api/wire";
import { api } from "./client";

export const qkOrchestrator = {
  // Keyed by parent session so one assistant's children never overwrite
  // another's in the cache. Bare key stays for the caller's own default.
  children: (sessionId?: string) =>
    sessionId
      ? (["orchestrator", "children", sessionId] as const)
      : (["orchestrator", "children"] as const),
};

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

/** Children of one assistant session. `sessionId` is the OPEN assistant in
 * the thread tree, so a team assistant's runs nest under it; omitted reads the
 * caller's own default. */
export function useOrchestratorChildren(
  sessionId?: string,
  opts?: Partial<UseQueryOptions<GetOrchestratorChildrenResponse>>,
) {
  return useQuery<GetOrchestratorChildrenResponse>({
    queryKey: qkOrchestrator.children(sessionId),
    queryFn: () => api.getOrchestratorChildren(sessionId),
    ...opts,
  });
}

/** A team's assistant runs — the team mirror of `useOrchestratorChildren`
 * (team dashboard design). Runs move, so refetch on the same cadence the
 * personal children query uses. */
export function useTeamChildren(
  teamId: string,
  opts?: Partial<UseQueryOptions<GetTeamChildrenResponse>>,
) {
  return useQuery<GetTeamChildrenResponse>({
    queryKey: ["teams", teamId, "children"],
    queryFn: () => api.getTeamChildren(teamId),
    refetchInterval: 30_000,
    ...opts,
  });
}

/** Dismiss a settled child from the thread tree. Display state only — the
 * child session and its history stay reachable from the Sessions page.
 * `sessionId` is the parent whose children list to refresh, so a team
 * assistant's tree updates in place. */
export function useDismissChild(sessionId?: string) {
  const qc = useQueryClient();
  return useMutation<{ ok: true }, Error, string>({
    mutationFn: (childSessionId) => api.dismissChild(childSessionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: qkOrchestrator.children(sessionId) });
    },
  });
}
