import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { api, type OwnerFilter } from "./client";

export const qkCatchUp = {
  briefings: (owner: OwnerFilter) => ["workspace-briefings", owner.ownerType, owner.ownerId] as const,
  work: (owner: OwnerFilter) => ["workspace-work", owner.ownerType, owner.ownerId] as const,
  active: (owner: OwnerFilter) => ["workspace-active-work", owner.ownerType, owner.ownerId] as const,
  outcomes: (owner: OwnerFilter) => ["workspace-outcomes", owner.ownerType, owner.ownerId] as const,
  workArtifacts: (owner: OwnerFilter, sessionId: string, threadId?: string) =>
    ["artifacts", "work", owner.ownerType, owner.ownerId, sessionId, threadId] as const,
};

export function useCatchUpWork(owner: OwnerFilter) {
  return useInfiniteQuery({
    queryKey: qkCatchUp.work(owner),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listWork(owner, pageParam),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
}

export function useWorkspaceOutcomes(owner: OwnerFilter) {
  return useInfiniteQuery({
    queryKey: qkCatchUp.outcomes(owner),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listWorkspaceOutcomes(owner, pageParam),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
}

export function useWorkspaceActiveWork(owner: OwnerFilter) {
  return useInfiniteQuery({
    queryKey: qkCatchUp.active(owner),
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => api.listWorkspaceActiveWork(owner, pageParam),
    getNextPageParam: page => page.nextCursor ?? undefined,
    refetchInterval: 10_000,
  });
}

export function useWorkspaceBriefings(owner: OwnerFilter) {
  return useQuery({
    queryKey: qkCatchUp.briefings(owner),
    queryFn: () => api.getWorkspaceBriefings(owner),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });
}
